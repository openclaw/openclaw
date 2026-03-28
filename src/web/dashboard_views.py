"""Dashboard v2.0 — Visual panels for Mission Control.

Endpoints:
  GET /dashboard            — Main dashboard HTML (tabbed SPA)
  GET /api/lats/tree        — LATS tree data (D3.js-compatible)
  GET /api/graph/data       — Dependency graph data (Cytoscape.js format)
  GET /api/graph/stats      — Graph summary statistics
  GET /api/finance/summary  — Token costs by model, monthly forecast
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict
from typing import Any, Dict, List

from fastapi import APIRouter
from fastapi.responses import HTMLResponse, JSONResponse

import structlog

logger = structlog.get_logger("Dashboard")

router = APIRouter()

# Token pricing ($ per 1K tokens) — common free/cheap models
_TOKEN_PRICING: Dict[str, float] = {
    "default": 0.0,
    "nvidia/nemotron-nano-12b-v2-vl:free": 0.0,
    "arcee-ai/trinity-mini:free": 0.0,
    "qwen/qwen3-235b-a22b:free": 0.0,
    "deepseek/deepseek-r1-0528:free": 0.0,
    "openai/gpt-4o": 0.005,
    "openai/gpt-4o-mini": 0.00015,
    "anthropic/claude-sonnet-4": 0.003,
}


# ---------------------------------------------------------------------------
# LATS Tree API
# ---------------------------------------------------------------------------

@router.get("/api/lats/tree")
async def lats_tree_data() -> JSONResponse:
    """Return LATS search trees in D3.js-compatible hierarchical format."""
    from src.web.api import _pipeline_trees

    trees = list(_pipeline_trees)[-5:]
    d3_trees: List[Dict[str, Any]] = []

    for entry in trees:
        raw_tree = entry.get("tree", {})
        nodes = raw_tree.get("nodes", [])
        if not nodes:
            continue

        # Build parent→children map
        node_map: Dict[int, Dict[str, Any]] = {}
        for n in nodes:
            nid = n.get("node_id", n.get("id", 0))
            node_map[nid] = {
                "name": n.get("thought", "")[:80] or f"Node {nid}",
                "score": n.get("score", 0.0),
                "action": n.get("action", ""),
                "observation": (n.get("observation", "") or "")[:120],
                "depth": n.get("depth", 0),
                "is_terminal": n.get("is_terminal", False),
                "children": [],
            }

        # Link children
        for n in nodes:
            nid = n.get("node_id", n.get("id", 0))
            pid = n.get("parent_id")
            if pid is not None and pid in node_map:
                node_map[pid]["children"].append(node_map[nid])

        # Find root (parent_id is None or 0)
        roots = [
            node_map[n.get("node_id", n.get("id", 0))]
            for n in nodes
            if n.get("parent_id") is None
        ]
        if roots:
            d3_trees.append({
                "ts": entry.get("ts", 0),
                "root": roots[0],
            })

    return JSONResponse({"trees": d3_trees})


# ---------------------------------------------------------------------------
# Graph-RAG API
# ---------------------------------------------------------------------------

@router.get("/api/graph/data")
async def graph_data() -> JSONResponse:
    """Return dependency graph in Cytoscape.js elements format."""
    try:
        from src.memory.graph_engine import DependencyGraphEngine
        engine = DependencyGraphEngine(".")
        engine.build(sub_dirs=["src"])
    except Exception as e:
        logger.warning("graph_build_failed", error=str(e))
        return JSONResponse({"elements": {"nodes": [], "edges": []}})

    cy_nodes: List[Dict[str, Any]] = []
    cy_edges: List[Dict[str, Any]] = []

    for path, node in engine.nodes.items():
        cy_nodes.append({
            "data": {
                "id": path,
                "label": path.split("/")[-1],
                "language": node.language,
                "symbols": node.symbols[:10],
                "imports_count": len(node.imports),
                "imported_by_count": len(node.imported_by),
            }
        })

    edge_id = 0
    for source, targets in engine._adjacency.items():
        for target in targets:
            if target in engine.nodes:
                cy_edges.append({
                    "data": {
                        "id": f"e{edge_id}",
                        "source": source,
                        "target": target,
                    }
                })
                edge_id += 1

    return JSONResponse({
        "elements": {
            "nodes": cy_nodes,
            "edges": cy_edges,
        }
    })


@router.get("/api/graph/stats")
async def graph_stats() -> JSONResponse:
    """Return dependency graph summary statistics."""
    try:
        from src.memory.graph_engine import DependencyGraphEngine
        engine = DependencyGraphEngine(".")
        engine.build(sub_dirs=["src"])
        stats = engine.stats()
        return JSONResponse({
            "total_files": stats.total_files,
            "total_edges": stats.total_edges,
            "languages": stats.languages,
            "most_imported": stats.most_imported[:10],
            "most_dependent": stats.most_dependent[:10],
        })
    except Exception as e:
        return JSONResponse({"error": str(e)})


# ---------------------------------------------------------------------------
# Financial Audit API
# ---------------------------------------------------------------------------

@router.get("/api/finance/summary")
async def finance_summary() -> JSONResponse:
    """Token costs by model + monthly forecast."""
    try:
        from src.ai.inference.metrics import InferenceMetricsCollector
        from src.llm_gateway import get_metrics_collector
        mc = get_metrics_collector()
        if not mc:
            return JSONResponse({"models": [], "totals": {}})
    except Exception:
        return JSONResponse({"models": [], "totals": {}})

    models_data: List[Dict[str, Any]] = []
    total_tokens = 0
    total_cost = 0.0

    for model_name, acc in mc._model_stats.items():
        price = _TOKEN_PRICING.get(model_name, _TOKEN_PRICING["default"])
        cost = (acc.total_tokens / 1000.0) * price
        models_data.append({
            "model": model_name,
            "requests": acc.count,
            "tokens": acc.total_tokens,
            "cost_usd": round(cost, 6),
            "avg_latency_ms": round(acc.total_latency_ms / acc.count, 1) if acc.count else 0,
        })
        total_tokens += acc.total_tokens
        total_cost += cost

    # Monthly forecast: extrapolate from uptime
    uptime_hours = (time.monotonic() - mc._start_time) / 3600.0
    monthly_factor = (30 * 24) / max(uptime_hours, 0.01)

    return JSONResponse({
        "models": sorted(models_data, key=lambda x: x["tokens"], reverse=True),
        "totals": {
            "total_tokens": total_tokens,
            "total_cost_usd": round(total_cost, 6),
            "prompt_tokens": mc._total_prompt_tokens,
            "completion_tokens": mc._total_completion_tokens,
            "uptime_hours": round(uptime_hours, 2),
            "monthly_forecast_usd": round(total_cost * monthly_factor, 4),
        },
    })


# ---------------------------------------------------------------------------
# Main Dashboard HTML (SPA with tabs)
# ---------------------------------------------------------------------------

@router.get("/dashboard", response_class=HTMLResponse)
async def dashboard_page() -> HTMLResponse:
    """Serve the Mission Control Dashboard v2.0 — single-page app."""
    return HTMLResponse(_DASHBOARD_HTML)


_DASHBOARD_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenClaw Mission Control v2.0</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.4/cytoscape.min.js"
        integrity="sha512-NRx/Fv0DJQLT/gbuJocTG+R/BnRe+GmaAwQAp0dI9Z7GfPe6AaQ6dmTQgvdwQ+fUUWR1WXPoGAjk1zeFKbj6g=="
        crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --yellow: #d29922;
    --purple: #bc8cff;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:var(--text); font-family:'Segoe UI',system-ui,sans-serif; }
  header { background:var(--surface); border-bottom:1px solid var(--border); padding:12px 24px;
           display:flex; align-items:center; gap:16px; }
  header h1 { font-size:18px; font-weight:600; }
  header .badge { background:var(--green); color:#000; border-radius:12px; padding:2px 10px;
                  font-size:12px; font-weight:600; }
  .tabs { display:flex; gap:0; background:var(--surface); border-bottom:1px solid var(--border); }
  .tab { padding:10px 20px; cursor:pointer; border-bottom:2px solid transparent;
         color:var(--muted); font-size:14px; transition:all .15s; }
  .tab:hover { color:var(--text); }
  .tab.active { color:var(--accent); border-bottom-color:var(--accent); }
  .panel { display:none; padding:20px 24px; min-height:calc(100vh - 110px); }
  .panel.active { display:block; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:8px;
          padding:16px; margin-bottom:16px; }
  .card h3 { font-size:14px; color:var(--muted); margin-bottom:12px; text-transform:uppercase;
             letter-spacing:0.5px; }
  .stats-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px;
               margin-bottom:16px; }
  .stat { background:var(--surface); border:1px solid var(--border); border-radius:8px;
          padding:14px; text-align:center; }
  .stat .value { font-size:28px; font-weight:700; color:var(--accent); }
  .stat .label { font-size:12px; color:var(--muted); margin-top:4px; }
  #cy { width:100%; height:70vh; background:var(--bg); border:1px solid var(--border);
        border-radius:8px; }
  #lats-tree { width:100%; min-height:500px; }
  .tree-node { display:inline-flex; flex-direction:column; align-items:center; margin:4px; }
  .tree-card { background:var(--surface); border:1px solid var(--border); border-radius:6px;
               padding:8px 12px; font-size:12px; max-width:220px; text-align:center;
               position:relative; }
  .tree-card .score { position:absolute; top:-8px; right:-8px; background:var(--accent);
                      color:#000; border-radius:50%; width:28px; height:28px;
                      display:flex; align-items:center; justify-content:center;
                      font-size:10px; font-weight:700; }
  .tree-card.terminal { border-color:var(--green); }
  .tree-children { display:flex; justify-content:center; gap:8px; padding-top:8px;
                   border-top:1px dashed var(--border); margin-top:8px; }
  canvas { max-height:350px; }
  .tooltip { position:fixed; background:var(--surface); border:1px solid var(--accent);
             border-radius:6px; padding:10px; font-size:12px; pointer-events:none;
             z-index:1000; max-width:320px; display:none; }
  .tooltip .path { color:var(--accent); font-weight:600; }
  .tooltip .lang { color:var(--yellow); }
  .tooltip .syms { color:var(--muted); font-style:italic; }
  table { width:100%; border-collapse:collapse; }
  th, td { padding:8px 12px; text-align:left; border-bottom:1px solid var(--border); }
  th { color:var(--muted); font-size:12px; text-transform:uppercase; }
  td { font-size:13px; }
  .loading { color:var(--muted); padding:40px; text-align:center; }
</style>
</head>
<body>

<header>
  <h1>&#x1F9E0; OpenClaw Mission Control</h1>
  <span class="badge">v2.0</span>
  <span id="status-badge" class="badge" style="background:var(--muted)">connecting...</span>
</header>

<div class="tabs">
  <div class="tab active" data-panel="overview">Overview</div>
  <div class="tab" data-panel="lats">LATS Tree</div>
  <div class="tab" data-panel="graph">Graph-RAG</div>
  <div class="tab" data-panel="finance">Finance</div>
</div>

<!-- Overview Panel -->
<div id="overview" class="panel active">
  <div class="stats-row" id="overview-stats"></div>
  <div class="card"><h3>Recent Logs</h3><div id="log-stream" style="max-height:400px;overflow:auto;font-family:monospace;font-size:12px;"></div></div>
</div>

<!-- LATS Tree Panel -->
<div id="lats" class="panel">
  <div class="card">
    <h3>LATS Search Tree — Live Decision Visualization</h3>
    <p style="color:var(--muted);font-size:13px;margin-bottom:12px;">
      Each node is a Thought branch scored by the Auditor. Green = terminal (solution found).
      Score badges show evaluation confidence (0.0–1.0).
    </p>
    <div id="lats-tree"><div class="loading">Loading LATS trees...</div></div>
  </div>
</div>

<!-- Graph-RAG Panel -->
<div id="graph" class="panel">
  <div class="stats-row" id="graph-stats"></div>
  <div class="card">
    <h3>Dependency Graph Explorer</h3>
    <div id="cy"></div>
  </div>
  <div id="node-tooltip" class="tooltip"></div>
</div>

<!-- Finance Panel -->
<div id="finance" class="panel">
  <div class="stats-row" id="finance-stats"></div>
  <div class="card" style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
    <div><h3>Token Usage by Model</h3><canvas id="token-chart"></canvas></div>
    <div><h3>Cost Breakdown (USD)</h3><canvas id="cost-chart"></canvas></div>
  </div>
  <div class="card">
    <h3>Model Performance Table</h3>
    <table id="finance-table">
      <thead><tr><th>Model</th><th>Requests</th><th>Tokens</th><th>Cost (USD)</th><th>Avg Latency</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
</div>

<script>
// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.panel).classList.add('active');
    if (tab.dataset.panel === 'graph' && !window._cyLoaded) loadGraph();
    if (tab.dataset.panel === 'lats') loadLATS();
    if (tab.dataset.panel === 'finance') loadFinance();
  });
});

// ---------- Overview ----------
async function loadOverview() {
  try {
    const res = await fetch('/status');
    const data = await res.json();
    const sb = document.getElementById('status-badge');
    sb.textContent = data.status;
    sb.style.background = data.status === 'online' ? 'var(--green)' : 'var(--red)';
    sb.style.color = '#000';

    const stats = document.getElementById('overview-stats');
    const m = data.inference_metrics || {};
    stats.innerHTML = `
      <div class="stat"><div class="value">${Math.round(data.uptime_sec/60)}m</div><div class="label">Uptime</div></div>
      <div class="stat"><div class="value">${m.total_requests||0}</div><div class="label">Inferences</div></div>
      <div class="stat"><div class="value">${m.avg_tps||0}</div><div class="label">Avg TPS</div></div>
      <div class="stat"><div class="value">${m.avg_ttft_ms||0}ms</div><div class="label">Avg TTFT</div></div>
      <div class="stat"><div class="value">${((m.cache_hit_rate||0)*100).toFixed(1)}%</div><div class="label">Cache Hit</div></div>
      <div class="stat"><div class="value">${m.vram_estimate_gb||0}GB</div><div class="label">VRAM Est.</div></div>
    `;
  } catch(e) { console.warn('Status fetch failed:', e); }

  try {
    const res = await fetch('/logs/recent?limit=50');
    const data = await res.json();
    const el = document.getElementById('log-stream');
    el.innerHTML = (data.logs || []).map(l => {
      const color = l.level === 'error' ? 'var(--red)' : l.level === 'warning' ? 'var(--yellow)' : 'var(--muted)';
      const ts = new Date(l.ts * 1000).toLocaleTimeString();
      return `<div style="color:${color};margin:2px 0;">[${ts}] ${l.level.toUpperCase()} ${l.event}</div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
  } catch(e) {}
}

// ---------- LATS Tree ----------
function renderNode(node) {
  const isT = node.is_terminal;
  const scoreColor = node.score > 0.7 ? 'var(--green)' : node.score > 0.4 ? 'var(--yellow)' : 'var(--red)';
  let html = `<div class="tree-node">
    <div class="tree-card ${isT ? 'terminal' : ''}">
      <div class="score" style="background:${scoreColor}">${node.score.toFixed(1)}</div>
      <div style="font-weight:600;margin-bottom:4px;">${esc(node.name)}</div>`;
  if (node.action) html += `<div style="color:var(--accent);font-size:11px;">&#x2192; ${esc(node.action)}</div>`;
  if (node.observation) html += `<div style="color:var(--muted);font-size:10px;margin-top:2px;">${esc(node.observation)}</div>`;
  html += `</div>`;
  if (node.children && node.children.length > 0) {
    html += `<div class="tree-children">${node.children.map(c => renderNode(c)).join('')}</div>`;
  }
  html += `</div>`;
  return html;
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

async function loadLATS() {
  try {
    const res = await fetch('/api/lats/tree');
    const data = await res.json();
    const el = document.getElementById('lats-tree');
    if (!data.trees || data.trees.length === 0) {
      el.innerHTML = '<div class="loading">No LATS trees recorded yet. Run a complex pipeline task to generate one.</div>';
      return;
    }
    el.innerHTML = data.trees.map((t,i) => {
      const ts = new Date(t.ts * 1000).toLocaleString();
      return `<div style="margin-bottom:20px;">
        <div style="color:var(--muted);font-size:12px;margin-bottom:8px;">Tree #${i+1} — ${ts}</div>
        <div style="overflow-x:auto;">${renderNode(t.root)}</div>
      </div>`;
    }).join('');
  } catch(e) {
    document.getElementById('lats-tree').innerHTML = '<div class="loading">Failed to load LATS data.</div>';
  }
}

// ---------- Graph-RAG ----------
async function loadGraph() {
  window._cyLoaded = true;
  const statsEl = document.getElementById('graph-stats');
  statsEl.innerHTML = '<div class="loading">Building dependency graph...</div>';

  try {
    const [graphRes, statsRes] = await Promise.all([
      fetch('/api/graph/data'),
      fetch('/api/graph/stats'),
    ]);
    const graph = await graphRes.json();
    const stats = await statsRes.json();

    statsEl.innerHTML = `
      <div class="stat"><div class="value">${stats.total_files||0}</div><div class="label">Files</div></div>
      <div class="stat"><div class="value">${stats.total_edges||0}</div><div class="label">Edges</div></div>
      ${Object.entries(stats.languages||{}).map(([l,c]) =>
        `<div class="stat"><div class="value">${c}</div><div class="label">${l}</div></div>`
      ).join('')}
    `;

    const langColors = { python:'#3572A5', typescript:'#3178c6', rust:'#dea584', javascript:'#f1e05a', unknown:'#8b949e' };
    const cy = cytoscape({
      container: document.getElementById('cy'),
      elements: [
        ...(graph.elements.nodes || []).map(n => ({
          data: { ...n.data, color: langColors[n.data.language] || langColors.unknown }
        })),
        ...(graph.elements.edges || []),
      ],
      style: [
        { selector:'node', style:{
          'label':'data(label)', 'font-size':8, 'color':'#e6edf3',
          'background-color':'data(color)', 'width':20, 'height':20,
          'text-valign':'bottom', 'text-margin-y':4,
        }},
        { selector:'edge', style:{
          'width':1, 'line-color':'#30363d', 'target-arrow-color':'#58a6ff',
          'target-arrow-shape':'triangle', 'curve-style':'bezier', 'arrow-scale':0.6,
        }},
        { selector:'node:selected', style:{ 'border-width':2, 'border-color':'#58a6ff' }},
      ],
      layout:{ name:'cose', animate:false, nodeRepulsion:8000, idealEdgeLength:80 },
    });

    const tooltip = document.getElementById('node-tooltip');
    cy.on('mouseover','node', e => {
      const d = e.target.data();
      tooltip.innerHTML = `<div class="path">${d.id}</div>
        <div class="lang">Language: ${d.language}</div>
        <div>Imports: ${d.imports_count} | Imported by: ${d.imported_by_count}</div>
        ${d.symbols.length ? `<div class="syms">Exports: ${d.symbols.join(', ')}</div>` : ''}`;
      tooltip.style.display = 'block';
    });
    cy.on('mousemove','node', e => {
      tooltip.style.left = e.originalEvent.clientX + 12 + 'px';
      tooltip.style.top = e.originalEvent.clientY + 12 + 'px';
    });
    cy.on('mouseout','node', () => { tooltip.style.display = 'none'; });

  } catch(e) {
    statsEl.innerHTML = '<div class="loading">Failed to build graph.</div>';
    console.error(e);
  }
}

// ---------- Finance ----------
let tokenChart, costChart;
async function loadFinance() {
  try {
    const res = await fetch('/api/finance/summary');
    const data = await res.json();
    const t = data.totals || {};
    const models = data.models || [];

    document.getElementById('finance-stats').innerHTML = `
      <div class="stat"><div class="value">${(t.total_tokens||0).toLocaleString()}</div><div class="label">Total Tokens</div></div>
      <div class="stat"><div class="value">$${(t.total_cost_usd||0).toFixed(4)}</div><div class="label">Total Cost</div></div>
      <div class="stat"><div class="value">${(t.prompt_tokens||0).toLocaleString()}</div><div class="label">Prompt Tokens</div></div>
      <div class="stat"><div class="value">${(t.completion_tokens||0).toLocaleString()}</div><div class="label">Completion Tokens</div></div>
      <div class="stat"><div class="value">${t.uptime_hours||0}h</div><div class="label">Uptime</div></div>
      <div class="stat"><div class="value">$${(t.monthly_forecast_usd||0).toFixed(4)}/mo</div><div class="label">Forecast</div></div>
    `;

    const labels = models.map(m => m.model.split('/').pop());
    const colors = ['#58a6ff','#3fb950','#d29922','#f85149','#bc8cff','#f778ba','#79c0ff','#a5d6ff'];

    if (tokenChart) tokenChart.destroy();
    tokenChart = new Chart(document.getElementById('token-chart'), {
      type:'doughnut',
      data:{ labels, datasets:[{ data:models.map(m=>m.tokens), backgroundColor:colors }] },
      options:{ plugins:{ legend:{ labels:{ color:'#e6edf3',font:{size:11} } } } }
    });

    if (costChart) costChart.destroy();
    costChart = new Chart(document.getElementById('cost-chart'), {
      type:'bar',
      data:{
        labels,
        datasets:[{ label:'Cost (USD)', data:models.map(m=>m.cost_usd),
                     backgroundColor:colors.slice(0,models.length) }]
      },
      options:{
        scales:{ y:{ ticks:{color:'#8b949e'}, grid:{color:'#30363d'} },
                 x:{ ticks:{color:'#8b949e'}, grid:{color:'#30363d'} } },
        plugins:{ legend:{ display:false } }
      }
    });

    const tbody = document.querySelector('#finance-table tbody');
    tbody.innerHTML = models.map(m => `<tr>
      <td style="color:var(--accent)">${esc(m.model)}</td>
      <td>${m.requests}</td>
      <td>${m.tokens.toLocaleString()}</td>
      <td>$${m.cost_usd.toFixed(6)}</td>
      <td>${m.avg_latency_ms}ms</td>
    </tr>`).join('');

  } catch(e) {
    document.getElementById('finance-stats').innerHTML = '<div class="loading">No finance data available.</div>';
  }
}

// Initial load
loadOverview();
setInterval(loadOverview, 10000);
</script>

</body>
</html>
"""
