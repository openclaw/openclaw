import type { IncomingMessage, ServerResponse } from "node:http";

const HTML_PAGE = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Iris Pattern Detector</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1117; color: #e1e4e8; padding: 24px; max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 8px; color: #f0f6fc; }
  .subtitle { color: #8b949e; margin-bottom: 24px; font-size: 0.9rem; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 8px 12px; color: #8b949e; font-size: 0.8rem; text-transform: uppercase; border-bottom: 1px solid #30363d; }
  td { padding: 8px 12px; border-bottom: 1px solid #21262d; font-size: 0.9rem; }
  tr:hover td { background: #1c2128; }
  input, textarea, select { background: #0d1117; border: 1px solid #30363d; color: #e1e4e8; padding: 8px 12px; border-radius: 6px; font-size: 0.9rem; width: 100%; }
  input:focus, textarea:focus { outline: none; border-color: #58a6ff; }
  .btn { padding: 8px 16px; border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #e1e4e8; cursor: pointer; font-size: 0.85rem; }
  .btn:hover { background: #30363d; }
  .btn-primary { background: #238636; border-color: #238636; color: #fff; }
  .btn-primary:hover { background: #2ea043; }
  .btn-danger { background: #da3633; border-color: #da3633; color: #fff; }
  .btn-danger:hover { background: #f85149; }
  .btn-sm { padding: 4px 10px; font-size: 0.8rem; }
  .toggle { position: relative; display: inline-block; width: 40px; height: 22px; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background: #30363d; border-radius: 22px; transition: .2s; }
  .toggle .slider:before { content: ""; position: absolute; height: 16px; width: 16px; left: 3px; bottom: 3px; background: #e1e4e8; border-radius: 50%; transition: .2s; }
  .toggle input:checked + .slider { background: #238636; }
  .toggle input:checked + .slider:before { transform: translateX(18px); }
  .form-row { display: flex; gap: 12px; margin-bottom: 12px; }
  .form-row > * { flex: 1; }
  .form-row label { display: block; font-size: 0.8rem; color: #8b949e; margin-bottom: 4px; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  .toast { position: fixed; top: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; font-size: 0.9rem; z-index: 1000; animation: fadeIn .3s; }
  .toast-success { background: #238636; color: #fff; }
  .toast-error { background: #da3633; color: #fff; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
  .test-panel { margin-top: 24px; }
  .test-results { margin-top: 12px; }
  .match-tag { display: inline-block; background: #1f6feb33; color: #58a6ff; padding: 2px 8px; border-radius: 4px; margin: 2px; font-size: 0.85rem; }
  .section-title { font-size: 1.1rem; margin-bottom: 12px; color: #f0f6fc; }
  .empty-state { text-align: center; color: #8b949e; padding: 40px; }
</style>
</head>
<body>
<h1>Iris Pattern Detector</h1>
<p class="subtitle">Manage regex patterns that detect and annotate content in messages</p>

<div class="card">
  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
    <span class="section-title">Patterns</span>
    <div style="display:flex; gap:8px; align-items:center;">
      <label class="toggle" title="Enable/Disable all">
        <input type="checkbox" id="globalToggle" checked>
        <span class="slider"></span>
      </label>
      <button class="btn btn-primary btn-sm" onclick="showAddForm()">+ Add Pattern</button>
    </div>
  </div>
  <table>
    <thead><tr><th>On</th><th>Label</th><th>Regex</th><th>Dir</th><th>Template</th><th></th></tr></thead>
    <tbody id="patternTable"></tbody>
  </table>
  <div id="emptyState" class="empty-state" style="display:none;">No patterns configured</div>
</div>

<div id="addForm" class="card" style="display:none;">
  <div class="section-title" id="formTitle">Add Pattern</div>
  <div class="form-row">
    <div><label>ID</label><input id="fId" placeholder="e.g. phone"></div>
    <div><label>Label</label><input id="fLabel" placeholder="e.g. Telefone"></div>
    <div style="max-width:80px;"><label>Flags</label><input id="fFlags" value="g"></div>
    <div style="max-width:120px;"><label>Direction</label><select id="fDirection"><option value="inbound">Inbound</option><option value="outbound">Outbound</option><option value="both">Both</option></select></div>
  </div>
  <div class="form-row">
    <div><label>Regex</label><input id="fRegex" placeholder="Regular expression"></div>
  </div>
  <div class="form-row">
    <div><label>Template</label><input id="fTemplate" placeholder="Use {{match}} for the matched value"></div>
  </div>
  <div class="actions">
    <button class="btn" onclick="hideAddForm()">Cancel</button>
    <button class="btn btn-primary" onclick="savePattern()">Save</button>
  </div>
</div>

<div class="actions">
  <button class="btn btn-primary" onclick="saveAll()">Save to Config</button>
</div>

<div class="test-panel card">
  <div class="section-title">Test Patterns</div>
  <textarea id="testText" rows="4" placeholder="Paste sample text here to test patterns..."></textarea>
  <div class="actions">
    <button class="btn" onclick="runTest()">Run Patterns</button>
  </div>
  <div id="testResults" class="test-results"></div>
</div>

<script>
let patterns = [];
let editingIdx = -1;

async function load() {
  try {
    const r = await fetch("/__iris__/patterns");
    const d = await r.json();
    patterns = d.patterns || [];
    document.getElementById("globalToggle").checked = d.enabled !== false;
    render();
  } catch(e) { toast("Failed to load: " + e, "error"); }
}

function render() {
  const tb = document.getElementById("patternTable");
  const empty = document.getElementById("emptyState");
  if (!patterns.length) { tb.innerHTML = ""; empty.style.display = "block"; return; }
  empty.style.display = "none";
  tb.innerHTML = patterns.map((p, i) => \`<tr>
    <td><label class="toggle"><input type="checkbox" \${p.enabled ? "checked" : ""} onchange="togglePattern(\${i})"><span class="slider"></span></label></td>
    <td>\${esc(p.label)}</td>
    <td style="font-family:monospace;font-size:0.8rem;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="\${esc(p.regex)}">\${esc(p.regex)}</td>
    <td style="font-size:0.85rem;">\${esc(p.direction || "inbound")}</td>
    <td style="font-size:0.85rem;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="\${esc(p.template)}">\${esc(p.template)}</td>
    <td style="white-space:nowrap;"><button class="btn btn-sm" onclick="editPattern(\${i})">Edit</button> <button class="btn btn-sm btn-danger" onclick="deletePattern(\${i})">Del</button></td>
  </tr>\`).join("");
}

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function togglePattern(i) { patterns[i].enabled = !patterns[i].enabled; render(); }
function deletePattern(i) { patterns.splice(i, 1); render(); }

function showAddForm() {
  editingIdx = -1;
  document.getElementById("formTitle").textContent = "Add Pattern";
  document.getElementById("fId").value = "";
  document.getElementById("fLabel").value = "";
  document.getElementById("fRegex").value = "";
  document.getElementById("fFlags").value = "g";
  document.getElementById("fDirection").value = "inbound";
  document.getElementById("fTemplate").value = "";
  document.getElementById("addForm").style.display = "block";
}

function editPattern(i) {
  editingIdx = i;
  const p = patterns[i];
  document.getElementById("formTitle").textContent = "Edit Pattern";
  document.getElementById("fId").value = p.id;
  document.getElementById("fLabel").value = p.label;
  document.getElementById("fRegex").value = p.regex;
  document.getElementById("fFlags").value = p.flags || "g";
  document.getElementById("fDirection").value = p.direction || "inbound";
  document.getElementById("fTemplate").value = p.template;
  document.getElementById("addForm").style.display = "block";
}

function hideAddForm() { document.getElementById("addForm").style.display = "none"; editingIdx = -1; }

function savePattern() {
  const p = {
    id: document.getElementById("fId").value.trim(),
    label: document.getElementById("fLabel").value.trim(),
    regex: document.getElementById("fRegex").value,
    flags: document.getElementById("fFlags").value.trim() || "g",
    direction: document.getElementById("fDirection").value,
    template: document.getElementById("fTemplate").value,
    enabled: true,
  };
  if (!p.id || !p.regex) { toast("ID and Regex are required", "error"); return; }
  try { new RegExp(p.regex, p.flags); } catch(e) { toast("Invalid regex: " + e.message, "error"); return; }
  if (editingIdx >= 0) { patterns[editingIdx] = { ...patterns[editingIdx], ...p }; }
  else { patterns.push(p); }
  hideAddForm();
  render();
}

async function saveAll() {
  try {
    const r = await fetch("/__iris__/patterns", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: document.getElementById("globalToggle").checked, patterns }),
    });
    const d = await r.json();
    if (d.ok) toast("Saved!", "success");
    else toast(d.error || "Failed", "error");
  } catch(e) { toast("Failed: " + e, "error"); }
}

async function runTest() {
  const text = document.getElementById("testText").value;
  if (!text) { toast("Enter test text first", "error"); return; }
  try {
    const r = await fetch("/__iris__/patterns/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, patterns }),
    });
    const d = await r.json();
    const el = document.getElementById("testResults");
    if (!d.results?.length) { el.innerHTML = '<p style="color:#8b949e;">No matches found</p>'; return; }
    el.innerHTML = d.results.map(r =>
      \`<div style="margin-bottom:8px;"><strong>\${esc(r.label)}</strong>: \${r.matches.map(m => \`<span class="match-tag">\${esc(m)}</span>\`).join(" ")}</div>\`
    ).join("");
  } catch(e) { toast("Test failed: " + e, "error"); }
}

function toast(msg, type) {
  const el = document.createElement("div");
  el.className = "toast toast-" + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

load();
</script>
</body>
</html>`;

export async function handlePatternsUi(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(HTML_PAGE);
}
