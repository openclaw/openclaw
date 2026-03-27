"""
Brigade REST API — FastAPI HTTP server

Exposes PipelineExecutor as a REST API so the TypeScript OpenClaw gateway
can trigger brigade pipelines without a Python import dependency.

Port: 8765 (overridable via BRIGADE_API_PORT env var)

Endpoints:
    POST /brigade/execute          — run a brigade chain-of-agents
    POST /brigade/execute/stream   — stream pipeline step updates (SSE)
    GET  /brigade/brigades         — list available brigades and roles
    GET  /brigade/status           — health + vLLM connectivity check
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, AsyncIterator

import structlog
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

logger = structlog.get_logger("BrigadeAPI")

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class ExecuteRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=64_000)
    brigade: str = Field(default="Dmarket-Dev")
    max_steps: int = Field(default=5, ge=1, le=10)
    task_type: str | None = Field(default=None)


class StepResult(BaseModel):
    role: str
    model: str
    response: str
    duration_ms: int


class ExecuteResponse(BaseModel):
    final_response: str
    brigade: str
    chain_executed: list[str]
    steps: list[StepResult]
    status: str
    question: str | None = None
    duration_ms: int


class BrigadeInfo(BaseModel):
    name: str
    description: str
    workspace_dir: str
    roles: list[str]
    pipeline: list[str]


class StatusResponse(BaseModel):
    ok: bool
    version: str
    vllm_url: str
    vllm_reachable: bool
    brigades: list[str]
    uptime_sec: float


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

_start_time = time.monotonic()


def create_brigade_app(config: dict[str, Any], vllm_url: str, vllm_manager=None) -> FastAPI:
    """Create the FastAPI application with the given config and executor."""
    from src.pipeline_executor import PipelineExecutor

    executor = PipelineExecutor(config, vllm_url, vllm_manager)

    app = FastAPI(
        title="OpenClaw Brigade API",
        version=config.get("system", {}).get("version", "unknown"),
        description="REST bridge between TypeScript OpenClaw gateway and Python brigade pipeline",
        docs_url="/brigade/docs",
        redoc_url="/brigade/redoc",
        openapi_url="/brigade/openapi.json",
    )

    # Allow requests from the TS gateway (localhost only)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:*", "http://127.0.0.1:*"],
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "Authorization"],
    )

    @app.on_event("startup")
    async def _startup():
        await executor.initialize()
        logger.info("Brigade API ready", brigades=list(config.get("brigades", {}).keys()))

    # ------------------------------------------------------------------
    # POST /brigade/execute
    # ------------------------------------------------------------------
    @app.post("/brigade/execute", response_model=ExecuteResponse)
    async def execute(req: ExecuteRequest):
        t0 = time.monotonic()

        brigade_cfg = config.get("brigades", {}).get(req.brigade)
        if brigade_cfg is None:
            raise HTTPException(
                status_code=404,
                detail=f"Brigade '{req.brigade}' not found. "
                       f"Available: {list(config.get('brigades', {}).keys())}",
            )

        try:
            result = await executor.execute(
                prompt=req.prompt,
                brigade=req.brigade,
                max_steps=req.max_steps,
                task_type=req.task_type,
            )
        except Exception as exc:
            logger.error("Pipeline execution error", error=str(exc))
            raise HTTPException(status_code=500, detail=str(exc)) from exc

        duration_ms = int((time.monotonic() - t0) * 1000)

        steps = [
            StepResult(
                role=s.get("role", ""),
                model=s.get("model", ""),
                response=s.get("response", ""),
                duration_ms=s.get("duration_ms", 0),
            )
            for s in result.get("steps", [])
        ]

        return ExecuteResponse(
            final_response=result.get("final_response", ""),
            brigade=result.get("brigade", req.brigade),
            chain_executed=result.get("chain_executed", []),
            steps=steps,
            status=result.get("status", "completed"),
            question=result.get("question"),
            duration_ms=duration_ms,
        )

    # ------------------------------------------------------------------
    # POST /brigade/execute/stream  — Server-Sent Events
    # ------------------------------------------------------------------
    @app.post("/brigade/execute/stream")
    async def execute_stream(req: ExecuteRequest):
        """Return SSE stream of pipeline step updates."""
        brigade_cfg = config.get("brigades", {}).get(req.brigade)
        if brigade_cfg is None:
            raise HTTPException(status_code=404, detail=f"Brigade '{req.brigade}' not found")

        async def _event_stream() -> AsyncIterator[str]:
            collected_steps: list[dict] = []

            async def _status_cb(role: str, model: str, text: str):
                event = json.dumps({"type": "step", "role": role, "model": model, "text": text})
                collected_steps.append({"role": role, "model": model, "status": text})
                yield f"data: {event}\n\n"

            # We need a wrapper because _status_cb is a generator
            status_updates: list[str] = []

            async def cb(role: str, model: str, text: str):
                payload = json.dumps({"type": "step", "role": role, "model": model, "text": text})
                status_updates.append(f"data: {payload}\n\n")

            try:
                result = await executor.execute(
                    prompt=req.prompt,
                    brigade=req.brigade,
                    max_steps=req.max_steps,
                    task_type=req.task_type,
                    status_callback=cb,
                )
                # Flush buffered status updates
                for update in status_updates:
                    yield update

                final = json.dumps({
                    "type": "done",
                    "final_response": result.get("final_response", ""),
                    "chain_executed": result.get("chain_executed", []),
                    "status": result.get("status", "completed"),
                })
                yield f"data: {final}\n\n"
            except Exception as exc:
                error_event = json.dumps({"type": "error", "message": str(exc)})
                yield f"data: {error_event}\n\n"

        return StreamingResponse(
            _event_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # ------------------------------------------------------------------
    # GET /brigade/brigades
    # ------------------------------------------------------------------
    @app.get("/brigade/brigades", response_model=list[BrigadeInfo])
    async def list_brigades():
        result = []
        for name, cfg in config.get("brigades", {}).items():
            roles_cfg = cfg.get("roles", {})
            pipeline = cfg.get("pipeline") or list(roles_cfg.keys())[:5]
            result.append(
                BrigadeInfo(
                    name=name,
                    description=cfg.get("description", ""),
                    workspace_dir=cfg.get("workspace_dir", "./"),
                    roles=list(roles_cfg.keys()),
                    pipeline=pipeline,
                )
            )
        return result

    # ------------------------------------------------------------------
    # GET /brigade/status
    # ------------------------------------------------------------------
    @app.get("/brigade/status", response_model=StatusResponse)
    async def get_status():
        import aiohttp

        vllm_reachable = False
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{vllm_url}/models",
                    timeout=aiohttp.ClientTimeout(total=5),
                ) as resp:
                    vllm_reachable = resp.status == 200
        except Exception:
            pass

        return StatusResponse(
            ok=True,
            version=config.get("system", {}).get("version", "unknown"),
            vllm_url=vllm_url,
            vllm_reachable=vllm_reachable,
            brigades=list(config.get("brigades", {}).keys()),
            uptime_sec=round(time.monotonic() - _start_time, 1),
        )

    return app


# ---------------------------------------------------------------------------
# Standalone runner (for development/testing)
# ---------------------------------------------------------------------------
async def run_brigade_api(config: dict[str, Any], vllm_url: str, vllm_manager=None, port: int = 8765) -> None:
    """Start the Brigade API server as an asyncio task."""
    app = create_brigade_app(config, vllm_url, vllm_manager)
    cfg = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        log_level="warning",  # suppress uvicorn access logs (structured logging via structlog)
        loop="none",          # use the existing running event loop
    )
    server = uvicorn.Server(cfg)
    logger.info("Brigade API starting", port=port)
    await server.serve()


if __name__ == "__main__":
    import asyncio

    with open("config/openclaw_config.json") as f:
        _config = json.loads(os.path.expandvars(f.read()))
    _vllm_url = _config["system"].get("vllm_base_url", "http://localhost:8000/v1")
    asyncio.run(run_brigade_api(_config, _vllm_url))
