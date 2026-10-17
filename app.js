const $ = s => document.querySelector(s);
const G = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
const S = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

// Provedores em ordem de prioridade. Só entram os que tiverem chave cadastrada.
const PROVEDORES = [
  { id: 'groq', nome: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', modelo: 'openai/gpt-oss-120b' },
  { id: 'openrouter', nome: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', modelo: modeloGratisOR }
];
const MODOS = {
  explicar: { t: 'Explicar', d: 'Passo a passo, com exemplos simples.', p: 'Explique passo a passo, com exemplos simples.' },
  resumir: { t: 'Resumir', d: 'Cole um texto e eu resumo.', p: 'Resuma o conteúdo em tópicos curtos.' },
  exercicios: { t: 'Exercícios', d: 'Para praticar, e eu corrijo depois.', p: 'Gere 3 exercícios graduais. Só mostre a resolução se o aluno pedir.' },
  prova: { t: 'Revisar prova', d: 'Pontos principais e dúvidas comuns.', p: 'Revise os pontos principais e aponte os erros mais comuns.' }
};
const BASE = 'Você é o Estudo, um tutor de faculdade. Responda em português do Brasil, de forma clara e direta. Ajude o aluno a entender, não apenas entregue a resposta.';

let chats = G('chats') || [], atual = null, modo = 'explicar', ocupado = false;
const chave = id => (window.CHAVES && window.CHAVES[id]) || (G('chaves') || {})[id] || '';
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
const rolar = () => { const m = $('#msgs'); m.scrollTop = m.scrollHeight; };

function desenharModos() {
  $('#modos').innerHTML = Object.entries(MODOS).map(([k, m]) => `<button class="chip${k === modo ? ' on' : ''}" data-m="${k}">${m.t}</button>`).join('');
}
function desenharInicio() {
  $('#inicio').innerHTML = '<i class="orb g"></i><h1>Olá! O que vamos estudar hoje?</h1><p>Escolha um modo ou escreva sua dúvida.</p><div class="cards">' +
    Object.entries(MODOS).map(([k, m]) => `<div class="card" tabindex="0" data-m="${k}"><b>${m.t}</b><span>${m.d}</span></div>`).join('') + '</div>';
}
function desenharMemoria() { $('#mem').textContent = G('memoria') || 'Ainda sem conversas salvas.'; }
function bolha(m) {
  const d = document.createElement('div');
  if (m.r === 'user') { d.className = 'u'; d.innerHTML = fmt(m.c); }
  else if (m.r === 'nota') { d.className = 'nota'; d.textContent = m.c; }
  else {
    d.className = 'ia';
    d.innerHTML = '<i class="orb"></i><div class="card2"><div class="t">' + fmt(m.c) + '</div><span class="tag">' + esc(m.p || '') + '</span></div>';
  }
  return d;
}
function tela() {
  $('#lista').innerHTML = chats.map(c => `<div class="item${c === atual ? ' on' : ''}" tabindex="0" data-id="${c.id}">${esc(c.t)}</div>`).join('');
  const vazio = !atual || !atual.m.length;
  $('#inicio').style.display = vazio ? 'flex' : 'none';
  const conv = $('#conv'); conv.innerHTML = '';
  if (!vazio) atual.m.forEach(m => conv.appendChild(bolha(m)));
  rolar();
}

// OpenRouter: escolhe sozinho um modelo gratuito que esteja no ar (a lista de gratuitos muda toda hora).
async function modeloGratisOR() {
  const c = G('orModelo');
  if (c && Date.now() - c.ts < 12 * 3600 * 1000) return c.id;
  let id = 'meta-llama/llama-3.3-70b-instruct:free';
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models');
    const lista = (await r.json()).data.filter(m => m.id.endsWith(':free') && String((m.architecture || {}).modality || 'text->text').endsWith('->text'));
    const prefer = ['llama-3.3-70b', 'gpt-oss-120b', 'gpt-oss-20b', 'deepseek', 'gemma', 'llama', 'qwen'];
    let m = null;
    for (const k of prefer) { m = lista.find(x => x.id.includes(k)); if (m) break; }
    id = (m || lista[0] || { id }).id;
    S('orModelo', { id, ts: Date.now() });
  } catch (e) {}
  return id;
}

// Rodízio: começa pelo último que funcionou e pula, por um tempo, quem estourou o limite.
const espera = {};
function ordem() {
  const agora = Date.now();
  const ps = PROVEDORES.filter(p => chave(p.id));
  const livres = ps.filter(p => !(espera[p.id] > agora));
  const u = G('ultimo');
  return (livres.length ? livres : ps).sort((x, y) => (y.id === u) - (x.id === u));
}

async function chamar(msgs, onTxt, onFalha) {
  const ps = ordem();
  if (!ps.length) throw new Error('sem-chave');
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    try {
      const modelo = typeof p.modelo === 'function' ? await p.modelo() : p.modelo;
      const r = await fetch(p.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + chave(p.id) },
        body: JSON.stringify({ model: modelo, messages: msgs, stream: true })
      });
      if (!r.ok) throw new Error(String(r.status));
      const rd = r.body.getReader(), dc = new TextDecoder();
      let buf = '', txt = '';
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dc.decode(value, { stream: true });
        const linhas = buf.split('\n'); buf = linhas.pop();
        for (const l of linhas) {
          if (!l.startsWith('data:')) continue;
          const d = l.slice(5).trim();
          if (d === '[DONE]') continue;
          try { const t = JSON.parse(d).choices[0].delta.content; if (t) { txt += t; onTxt(txt); } } catch (e) {}
        }
      }
      if (!txt) throw new Error('vazio');
      S('ultimo', p.id);
      return p;
    } catch (e) {
      if (p.id === 'openrouter' && ['400', '404', '422'].includes(e.message)) { try { localStorage.removeItem('orModelo'); } catch (x) {} }
      espera[p.id] = Date.now() + (e.message === '429' ? 600000 : 120000);
      if (i === ps.length - 1) throw e;
      if (onFalha) onFalha(p, ps[i + 1], e);
    }
  }
}

function montar(c) {
  const mem = G('memoria');
  const sys = BASE + ' ' + MODOS[modo].p + (mem ? ' Contexto da última conversa: ' + mem : '');
  return [{ role: 'system', content: sys }, ...c.m.filter(m => m.r !== 'nota').map(m => ({ role: m.r, content: m.c }))];
}
function erroTexto(e) {
  const c = e.message;
  if (c === 'sem-chave') return 'Adicione sua chave em Configurações para começar.';
  if (c === '401') return 'Chave inválida. Confira em Configurações.';
  if (c === '429') return 'Limite atingido em todos os provedores. Tente mais tarde.';
  return 'Não consegui responder agora. Verifique a internet e tente de novo.';
}

async function enviar(txt) {
  txt = txt.trim();
  if (!txt || ocupado) return;
  ocupado = true;
  if (!atual) { atual = { id: Date.now(), t: txt.slice(0, 36), m: [] }; chats.unshift(atual); }
  atual.m.push({ r: 'user', c: txt });
  tela();
  const m = { r: 'assistant', c: '', p: '' }, el = bolha(m), conv = $('#conv'), t = el.querySelector('.t'), notas = [];
  t.innerHTML = '<span class="pens">Pensando<i></i><i></i><i></i></span>';
  el.querySelector('.orb').classList.add('glow');
  conv.appendChild(el); rolar();
  try {
    const p = await chamar(montar(atual), x => { m.c = x; t.innerHTML = fmt(x); rolar(); }, (a, b, e) => {
      const n = { r: 'nota', c: (e.message === '429' ? 'Limite do ' + a.nome + ' atingido.' : a.nome + ' indisponível.') + ' Continuando com ' + b.nome + '.' };
      notas.push(n); conv.insertBefore(bolha(n), el);
    });
    m.p = p.nome;
    el.querySelector('.tag').textContent = p.nome;
    el.querySelector('.orb').classList.remove('glow');
    $('#prov').textContent = p.nome;
    atual.m.push(...notas, m);
  } catch (e) {
    atual.m.push(...notas, { r: 'nota', c: erroTexto(e) });
  }
  S('chats', chats);
  ocupado = false;
  tela();
}

async function novaConversa() {
  const c = atual;
  atual = null; tela(); $('#q').focus();
  const conteudo = c ? c.m.filter(m => m.r !== 'nota') : [];
  if (conteudo.length < 4) return;
  let r = '';
  try {
    await chamar([
      { role: 'system', content: 'Resuma em até 2 frases curtas, em português, o que o aluno estudou e o que ainda falta praticar.' },
      { role: 'user', content: conteudo.map(m => m.r + ': ' + m.c).join('\n').slice(-6000) }
    ], x => { r = x; });
  } catch (e) {}
  if (r) { S('memoria', r); desenharMemoria(); }
}

function abrirConfig() {
  const k = G('chaves') || {};
  $('#campos').innerHTML = PROVEDORES.map(p => `<label>${p.nome}<input type="password" id="k_${p.id}" value="${esc(k[p.id] || '')}" placeholder="Cole a chave aqui" autocomplete="off"></label>`).join('');
  $('#dlg').showModal();
}

document.addEventListener('click', e => {
  const mo = e.target.closest('[data-m]');
  if (mo) { modo = mo.dataset.m; desenharModos(); $('#q').focus(); return; }
  const it = e.target.closest('.item');
  if (it) { atual = chats.find(c => String(c.id) === it.dataset.id) || null; tela(); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('.card,.item')) e.target.click();
});
$('#novo').onclick = novaConversa;
$('#cfg').onclick = abrirConfig;
$('#salvar').onclick = () => {
  const k = {};
  PROVEDORES.forEach(p => { k[p.id] = $('#k_' + p.id).value.trim(); });
  S('chaves', k);
};
$('#f').onsubmit = e => { e.preventDefault(); const q = $('#q'); const v = q.value; q.value = ''; q.style.height = 'auto'; enviar(v); };
$('#q').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#f').requestSubmit(); } });
$('#q').addEventListener('input', e => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; });

desenharModos(); desenharInicio(); desenharMemoria(); tela();
