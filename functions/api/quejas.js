/**
 * Pages Function: /api/quejas
 *
 * POST /api/quejas -> guarda una queja en D1 (env.DB)
 *                     prioriza con Workers AI (env.AI, llama-3.1-8b-instruct)
 *                     fallback por palabras clave si la IA falla o no hay binding.
 * GET  /api/quejas -> devuelve las quejas en JSON, ordenadas por prioridad y fecha.
 *
 * Bindings:
 *   DB : base D1 con la tabla `quejas` (ver schema.sql)  -- requerido
 *   AI : Workers AI (opcional; si no está se usa fallback por keywords)
 */

const MAX_TEXTO = 500;
const MAX_CATEGORIA = 80;
const PRIORIDADES = ['alta', 'media', 'baja'];
const MODELO_IA = '@cf/meta/llama-3.1-8b-instruct';

const KEYWORDS_ALTA = [
  'urgente', 'urgencia', 'grave', 'peligro',
  'podrido', 'podrida', 'descompuesto', 'descompuesta',
  'vencido', 'vencida', 'fecha vencida', 'vencimiento',
  'vidrio', 'metal', 'cuerpo extrano', 'extrano',
  'insecto', 'insectos', 'gusano', 'gusanos', 'larva', 'larvas', 'plaga',
  'hongo', 'hongos', 'moho', 'mohos',
  'enfermo', 'enferma', 'intoxicacion', 'intoxicado', 'intoxicada',
  'contaminacion', 'contaminado', 'contaminada',
  'roto', 'rota', 'derramado', 'derramada',
  'no funciona', 'no sirve', 'no anda',
  'estafa', 'cobro indebido', 'cobro mal',
  'sucio', 'sucia', 'higiene',
  'pesimo', 'pesima', 'horrible', 'asco', 'asqueroso', 'asquerosa'
];

const KEYWORDS_BAJA = [
  'sugerencia', 'sugerencias', 'idea', 'ideas', 'propuesta',
  'consulta', 'duda', 'pregunta',
  'felicitacion', 'felicitaciones', 'felicitar', 'felicito',
  'gracias', 'agradecido', 'agradecida',
  'mejorar', 'mejora', 'opinion', 'comentario', 'comentarios'
];

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

function errorJson(mensaje, status) {
  return json({ ok: false, error: mensaje }, status || 400);
}

function normalizar(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function prioridadPorKeywords(texto, categoria) {
  const t = normalizar(texto + ' ' + (categoria || ''));
  for (const k of KEYWORDS_ALTA) if (t.includes(k)) return 'alta';
  for (const k of KEYWORDS_BAJA) if (t.includes(k)) return 'baja';
  return 'media';
}

function parsearPrioridadIA(respuesta) {
  if (!respuesta) return null;
  let txt = '';
  if (typeof respuesta === 'string') {
    txt = respuesta;
  } else if (typeof respuesta === 'object') {
    if (typeof respuesta.response === 'string') txt = respuesta.response;
    else if (typeof respuesta.result === 'string') txt = respuesta.result;
    else if (respuesta.result && typeof respuesta.result.response === 'string') txt = respuesta.result.response;
    else if (typeof respuesta.text === 'string') txt = respuesta.text;
  }
  if (!txt) return null;

  const n = normalizar(txt);
  for (const p of PRIORIDADES) {
    const re = new RegExp('\\b' + p + '\\b');
    if (re.test(n)) return p;
  }
  return null;
}

async function priorizarConIA(env, texto, categoria) {
  if (!env || !env.AI || typeof env.AI.run !== 'function') return null;

  const prompt =
    'Sos un clasificador de quejas de una empresa láctea uruguaya (Conaprole).\n' +
    'Leé la queja y respondé EXCLUSIVAMENTE con una de estas tres palabras: alta, media o baja.\n' +
    'Criterios:\n' +
    '- alta: riesgo para la salud, producto en mal estado/vencido/con contaminación, seguridad, intoxicación, cuerpos extraños, estafa o cobro indebido grave.\n' +
    '- media: producto en condiciones dudosas, mala atención, problemas operativos sin riesgo sanitario.\n' +
    '- baja: sugerencias, felicitaciones, consultas, opiniones generales.\n' +
    'No expliques. No agregues puntuación. Solo una palabra.\n\n' +
    'Categoría: ' + categoria + '\n' +
    'Queja: ' + texto + '\n' +
    'Prioridad:';

  try {
    const respuesta = await env.AI.run(MODELO_IA, {
      messages: [
        { role: 'system', content: 'Respondés solo con una palabra: alta, media o baja.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 8,
      temperature: 0
    });
    return parsearPrioridadIA(respuesta);
  } catch (e) {
    return null;
  }
}

async function manejarPOST(context) {
  const { request, env } = context;

  if (!env || !env.DB) {
    return errorJson(
      'Falta el binding D1 "DB". Configuralo en Cloudflare Pages → Settings → Functions → D1 database bindings.',
      500
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return errorJson('El cuerpo debe ser JSON válido.', 400);
  }

  if (!body || typeof body !== 'object') {
    return errorJson('Cuerpo inválido.', 400);
  }

  const textoRaw = typeof body.texto === 'string' ? body.texto : '';
  const categoriaRaw = typeof body.categoria === 'string' ? body.categoria : '';

  const texto = textoRaw.trim();
  const categoria = categoriaRaw.trim();

  if (texto.length < 10) {
    return errorJson('La queja debe tener al menos 10 caracteres.', 400);
  }
  if (texto.length > MAX_TEXTO) {
    return errorJson('La queja no puede superar los ' + MAX_TEXTO + ' caracteres.', 400);
  }
