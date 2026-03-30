"""Mission Control — FastAPI Observability Dashboard for OpenClaw Bot.

Provides real-time monitoring endpoints:
  GET  /status           — Bot & pipeline health overview
  GET  /logs/live        — WebSocket stream of structured logs
  GET  /memory/stats     — Memory system statistics (SuperMemory, RAG, context bridge)
  GET  /sandbox/active   — Active sandbox sessions and skill library stats
  GET  /pipeline/tree    — Current pipeline Thought→Action→Observation tree
  GET  /dashboard        — Dashboard v2.0 SPA (LATS tree, Graph-RAG, Finance charts)
  GET  /api/lats/tree    — LATS tree data (D3.js format)
  GET  /api/graph/data   — Dependency graph (Cytoscape.js format)
  GET  /api/graph/stats  — Graph summary statistics
  GET  /api/finance/summary — Token costs by model + monthly forecast

All data flows through structlog and is pushed to WebSocket clients in real-time.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import deque
from typing import Any, Dict, List, Optional

import structlog
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

logger = structlog.get_logger("MissionControl")

# ---------------------------------------------------------------------------
# Shared state — filled by the gateway at boot
# ---------------------------------------------------------------------------
_gateway_ref: Any = None  # OpenClawGateway instance
_pipeline_ref: Any = None  # PipelineExecutor instance
_config_ref: Dict[str, Any] = {}

# Ring-buffer for recent logs (last 500 entries)
_log_buffer: deque = deque(maxlen=500)

# Active WebSocket connections for log streaming
_ws_clients: list[WebSocket] = []

# Pipeline thought tree for current/last execution
_pipeline_trees: deque = deque(maxlen=20)


def init_dashboard(
    gateway: Any = None,
    pipeline: Any = None,
    config: Optional[Dict[str, Any]] = None,
) -> None:
    """Wire up the dashboard to the running bot's components."""
    global _gateway_ref, _pipeline_ref, _config_ref
    _gateway_ref = gateway
    _pipeline_ref = pipeline
    _config_ref = config or {}


def record_log(event: Dict[str, Any]) -> None:
    """Push a structured log entry into the ring-buffer and broadcast to WS clients."""
    entry = {
        "ts": time.time(),
        "level": event.get("level", "info"),
        "logger": event.get("logger", ""),
        "event": event.get("event", ""),
        "data": {k: v for k, v in event.items() if k not in ("level", "logger", "event", "timestamp")},
    }
    _log_buffer.append(entry)
    # Non-blocking broadcast
    for ws in list(_ws_clients):
        try:
            asyncio.get_event_loop().create_task(ws.send_json(entry))
        except Exception:
            pass


def record_pipeline_tree(tree: Dict[str, Any]) -> None:
    """Store a pipeline execution tree (Thought→Action→Observation nodes)."""
    _pipeline_trees.append({
        "ts": time.time(),
        "tree": tree,
    })


# ---------------------------------------------------------------------------
# structlog processor to capture logs
# ---------------------------------------------------------------------------
def dashboard_log_processor(
    _logger: Any,
    method_name: str,
    event_dict: Dict[str, Any],
) -> Dict[str, Any]:
    """structlog processor: mirrors every log event to the dashboard buffer."""
    record_log(event_dict)
    return event_dict


# ---------------------------------------------------------------------------
# FastAPI Application
# ---------------------------------------------------------------------------
app = FastAPI(
    title="OpenClaw Mission Control",
    version="1.0.0",
    description="Real-time observability dashboard for OpenClaw Bot.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Dashboard v2.0 visual panels
from src.web.dashboard_views import router as dashboard_router
app.include_router(dashboard_router)


@app.get("/status")
async def get_status() -> JSONResponse:
    """Bot & pipeline health overview."""
    uptime = 0.0
    if _gateway_ref and hasattr(_gateway_ref, "_start_time"):
        uptime = time.time() - _gateway_ref._start_time

    pipeline_history = []
    if _gateway_ref and hasattr(_gateway_ref, "_pipeline_history"):
        pipeline_history = _gateway_ref._pipeline_history[-10:]

    metrics_summary = {}
    try:
        from src.llm_gateway import get_metrics_collector
        mc = get_metrics_collector()
        if mc and hasattr(mc, "summary"):
            metrics_summary = mc.summary()
    except Exception:
        pass

    pending_approvals = {}
    try:
        from src.llm_gateway import _pending_approvals
        pending_approvals = {
            rid: {"status": r.status, "reasons": r.risk_reasons}
            for rid, r in _pending_approvals.items()
        }
    except Exception:
        pass

    return JSONResponse({
        "status": "online",
        "uptime_sec": round(uptime, 1),
        "cloud_only": _config_ref.get("system", {}).get("openrouter", {}).get("force_cloud", False),
        "recent_pipelines": pipeline_history,
        "inference_metrics": metrics_summary,
        "pending_approvals": pending_approvals,
    })


@app.get("/logs/recent")
async def get_recent_logs(limit: int = 100) -> JSONResponse:
    """Return recent log entries from the ring buffer."""
    entries = list(_log_buffer)[-limit:]
    return JSONResponse({"logs": entries, "total": len(_log_buffer)})


@app.websocket("/logs/live")
async def websocket_logs(websocket: WebSocket) -> None:
    """Stream logs in real-time via WebSocket."""
    await websocket.accept()
    _ws_clients.append(websocket)
    logger.info("WS client connected for live logs", total_clients=len(_ws_clients))
    try:
        while True:
            # Keep connection alive; client can send pings
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in _ws_clients:
            _ws_clients.remove(websocket)
        logger.info("WS client disconnected", total_clients=len(_ws_clients))


@app.get("/memory/stats")
async def get_memory_stats() -> JSONResponse:
    """Memory system statistics."""
    stats: Dict[str, Any] = {"supermemory": None, "rag": None}

    if _pipeline_ref:
        # SuperMemory
        sm = getattr(_pipeline_ref, "_supermemory", None)
        if sm and hasattr(sm, "stats"):
            try:
                stats["supermemory"] = sm.stats()
            except Exception:
                stats["supermemory"] = {"status": "initialized"}

        # RAG Engine
        rag = getattr(_pipeline_ref, "_rag_engine", None)
        if rag and hasattr(rag, "stats"):
            try:
                stats["rag"] = rag.stats()
            except Exception:
                stats["rag"] = {"status": "initialized"}

    return JSONResponse(stats)


@app.get("/sandbox/active")
async def get_sandbox_status() -> JSONResponse:
    """Active sandbox sessions and skill library info."""
    result: Dict[str, Any] = {"sandbox": None, "skills": []}

    if _pipeline_ref:
        sandbox = getattr(_pipeline_ref, "_sandbox", None)
        if sandbox:
            lib = getattr(sandbox, "skill_library", None)
            if lib:
                try:
                    result["skills"] = lib.list_skills()
                except Exception:
                    pass
            result["sandbox"] = {
                "docker_available": getattr(sandbox, "_docker_available", False),
                "total_executions": getattr(sandbox, "_exec_count", 0),
            }

    return JSONResponse(result)


@app.get("/pipeline/tree")
async def get_pipeline_tree() -> JSONResponse:
    """Return recent pipeline Thought→Action→Observation trees."""
    trees = list(_pipeline_trees)[-5:]
    return JSONResponse({"trees": trees})


# ---------------------------------------------------------------------------
# Server lifecycle
# ---------------------------------------------------------------------------
_server_task: Optional[asyncio.Task] = None


async def start_dashboard(host: str = "127.0.0.1", port: int = 8800) -> None:
    """Start the Mission Control dashboard as a background async task."""
    global _server_task

    import uvicorn

    config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)

    _server_task = asyncio.create_task(server.serve())
    logger.info("Mission Control dashboard started", host=host, port=port)


async def stop_dashboard() -> None:
    """Stop the dashboard server."""
    global _server_task
    if _server_task:
        _server_task.cancel()
        try:
            await _server_task
        except asyncio.CancelledError:
            pass
        _server_task = None
