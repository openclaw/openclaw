"""
Unified LLM Gateway — single entry point for ALL LLM inference across OpenClaw Bot.

Consolidates 6 previously scattered call-sites:
  1. pipeline_executor._call_vllm()
  2. intent_classifier.py (hardcoded OpenRouter/vLLM)
  3. deep_research.py (_llm_call_openrouter / _llm_call_vllm)
  4. memory_mcp.py (direct vLLM localhost:8000)
  5. ai/agents/_shared.py (bare vLLM POST)
  6. bot_commands.cmd_test_all_models (vLLM direct)

Architecture:
  route_llm() → SmartModelRouter (optional) → OpenRouter (primary) → vLLM (fallback)

Integrates: SmartModelRouter, AdaptiveTokenBudget, InferenceMetricsCollector.
Respects force_cloud mode: never hits localhost when cloud-only.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine, Dict, List, Optional

import aiohttp
import structlog

logger = structlog.get_logger("LLMGateway")

# ---------------------------------------------------------------------------
# Singleton-ish config holder (set once at gateway boot)
# ---------------------------------------------------------------------------
_gateway_config: Dict[str, Any] = {}
_force_cloud: bool = False
_openrouter_config: Dict[str, Any] = {}
_vllm_url: str = "http://localhost:8000/v1"

# Lazy-init inference components (singletons — initialized once by configure())
_smart_router = None
_token_budget = None
_metrics_collector = None
_configured: bool = False

# ---------------------------------------------------------------------------
# HITL (Human-in-the-Loop) Approval Gate  — Phase 8
# ---------------------------------------------------------------------------
# Risk patterns that trigger approval
_HIGH_RISK_PATTERNS: list[str] = [
    r"\brm\s+-rf\b",
    r"\bsudo\b",
    r"\bshutil\.rmtree\b",
    r"\bos\.remove\b",
    r"\bos\.unlink\b",
    r"\bdrop\s+table\b",
    r"\bdelete\s+from\b",
    r"\bformat\s+[a-z]:",
    r"\bkill\s+-9\b",
    r"\bshutdown\b",
    r"\breboot\b",
]
_COMPILED_RISK_RE = [re.compile(p, re.IGNORECASE) for p in _HIGH_RISK_PATTERNS]

# Budget threshold (USD) above which approval is needed
_BUDGET_APPROVAL_THRESHOLD: float = 0.05

# Approval callback — set by the Telegram/Discord handler at startup
_approval_callback: Optional[Callable[..., Coroutine]] = None
_approval_config: Dict[str, Any] = {}


@dataclass
class ApprovalRequest:
    """Represents a paused pipeline awaiting human approval."""
    request_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    prompt_preview: str = ""
    risk_reasons: List[str] = field(default_factory=list)
    estimated_cost: float = 0.0
    status: str = "PENDING_APPROVAL"  # PENDING_APPROVAL | APPROVED | REJECTED | EDITED
    edited_prompt: Optional[str] = None

    def approve(self) -> None:
        self.status = "APPROVED"

    def reject(self) -> None:
        self.status = "REJECTED"

    def edit(self, new_prompt: str) -> None:
        self.status = "EDITED"
        self.edited_prompt = new_prompt


# Active approval requests keyed by request_id
_pending_approvals: Dict[str, ApprovalRequest] = {}


def set_approval_callback(callback: Callable[..., Coroutine]) -> None:
    """Register the UI callback (Telegram/Discord) for sending approval buttons."""
    global _approval_callback
    _approval_callback = callback


def get_pending_approval(request_id: str) -> Optional[ApprovalRequest]:
    """Retrieve a pending approval request by ID."""
    return _pending_approvals.get(request_id)


def resolve_approval(request_id: str, action: str, edited_prompt: str = "") -> bool:
    """Resolve a pending approval: 'approve', 'reject', or 'edit'."""
    req = _pending_approvals.get(request_id)
    if not req or req.status != "PENDING_APPROVAL":
        return False
    if action == "approve":
        req.approve()
    elif action == "reject":
        req.reject()
    elif action == "edit" and edited_prompt:
        req.edit(edited_prompt)
    else:
        return False
    return True


def assess_risk(prompt: str, estimated_cost: float = 0.0) -> Optional[ApprovalRequest]:
    """Check if a prompt requires human approval. Returns ApprovalRequest or None."""
    if not _approval_config.get("enabled", False):
        return None

    reasons: list[str] = []
    lower = prompt.lower()

    for pat in _COMPILED_RISK_RE:
        if pat.search(lower):
            reasons.append(f"dangerous pattern: {pat.pattern}")

    threshold = _approval_config.get("budget_threshold", _BUDGET_APPROVAL_THRESHOLD)
    if estimated_cost > threshold:
        reasons.append(f"estimated cost ${estimated_cost:.3f} > ${threshold:.3f}")

    if not reasons:
        return None

    req = ApprovalRequest(
        prompt_preview=prompt[:300],
        risk_reasons=reasons,
        estimated_cost=estimated_cost,
    )
    _pending_approvals[req.request_id] = req
    logger.warning("HITL approval gate triggered", request_id=req.request_id, reasons=reasons)
    return req


# ---------------------------------------------------------------------------
# Vision / Multimodal support — Phase 8
# ---------------------------------------------------------------------------
_VISION_MODELS: list[str] = [
    "nvidia/nemotron-nano-12b-v2-vl:free",
    "google/gemma-3-27b-it:free",
    "google/gemma-3-12b-it:free",
]


def configure(config: Dict[str, Any]) -> None:
    """Initialize the gateway from the master OpenClaw config.

    Must be called once during startup (from OpenClawGateway.run()).
    Subsequent calls are no-ops to prevent double initialization.
    """
    global _gateway_config, _force_cloud, _openrouter_config, _vllm_url
    global _smart_router, _token_budget, _metrics_collector, _approval_config
    global _configured

    if _configured:
        logger.debug("LLMGateway already configured — skipping duplicate init")
        return

    _gateway_config = config
    _vllm_url = config.get("system", {}).get("vllm_base_url", "http://localhost:8000/v1").rstrip("/")

    # HITL configuration
    _approval_config.update(config.get("hitl", {}))

    or_cfg = config.get("system", {}).get("openrouter", {})
    _openrouter_config = or_cfg

    _force_cloud = (
        or_cfg.get("enabled", False)
        and or_cfg.get("force_cloud", False)
        and not or_cfg.get("use_local_models", True)
        and bool(or_cfg.get("api_key", ""))
    )

    # --- SmartModelRouter ---
    try:
        from src.ai.inference.router import SmartModelRouter
        from src.ai.inference._shared import ModelProfile

        router_cfg = config.get("system", {}).get("model_router", {})
        profiles: Dict[str, Any] = {}
        for task_type, model_name in router_cfg.items():
            # In force_cloud mode, skip models that look like local paths (contain AWQ/GPTQ/GGUF)
            if _force_cloud and any(tag in model_name.upper() for tag in ("AWQ", "GPTQ", "GGUF")):
                logger.debug("Skipping local model in cloud-only mode", model=model_name)
                continue
            if model_name not in profiles:
                is_fast = "7b" in model_name.lower() or "mini" in model_name.lower()
                profiles[model_name] = ModelProfile(
                    name=model_name,
                    vram_gb=4.0 if is_fast else 9.5,
                    capabilities=[task_type],
                    speed_tier="fast" if is_fast else "medium",
                    quality_tier="medium" if is_fast else "high",
                )
            else:
                profiles[model_name].capabilities.append(task_type)
        if profiles:
            _smart_router = SmartModelRouter(profiles)
            logger.info("LLMGateway: SmartModelRouter initialized", models=list(profiles.keys()))
    except Exception as e:
        logger.warning("LLMGateway: SmartModelRouter init failed (non-fatal)", error=str(e))

    # --- AdaptiveTokenBudget ---
    try:
        from src.ai.inference.budget import AdaptiveTokenBudget

        vram_gb = config.get("system", {}).get("hardware", {}).get("vram_gb", 16.0)
        _token_budget = AdaptiveTokenBudget(
            default_max_tokens=config.get("system", {}).get("vllm_max_model_len", 8192),
            vram_gb=vram_gb,
        )
    except Exception as e:
        logger.warning("LLMGateway: AdaptiveTokenBudget init failed", error=str(e))

    # --- InferenceMetricsCollector ---
    try:
        from src.ai.inference.metrics import InferenceMetricsCollector

        _metrics_collector = InferenceMetricsCollector()
    except Exception as e:
        logger.warning("LLMGateway: InferenceMetricsCollector init failed", error=str(e))

    _configured = True
    logger.info(
        "LLMGateway configured",
        force_cloud=_force_cloud,
        openrouter_enabled=or_cfg.get("enabled", False),
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def route_llm(
    prompt: str,
    *,
    system: str = "",
    task_type: str = "general",
    model: str = "",
    max_tokens: int = 2048,
    temperature: float = 0.3,
    messages: Optional[List[Dict[str, Any]]] = None,
    image_url: Optional[str] = None,
    image_base64: Optional[str] = None,
    skip_approval: bool = False,
) -> str:
    """Unified LLM call — routes through OpenRouter (primary) or vLLM (fallback).

    Args:
        prompt: User prompt (ignored if messages is provided).
        system: System prompt.
        task_type: "general" | "code" | "math" | "creative" | "intent" | "research" | "vision".
        model: Explicit model override. If empty, SmartRouter picks one.
        max_tokens: Max output tokens.
        temperature: Sampling temperature.
        messages: Full chat messages list (overrides prompt/system).
        image_url: URL of image for vision models.
        image_base64: Base64-encoded image data for vision models.
        skip_approval: If True, bypass HITL gate (internal retries etc.).

    Returns:
        LLM response text.
    """
    # --- HITL Approval Gate (Phase 8) ---
    if not skip_approval:
        approval = assess_risk(prompt)
        if approval is not None:
            # Notify via callback (Telegram/Discord buttons)
            if _approval_callback:
                try:
                    await _approval_callback(approval)
                except Exception as e:
                    logger.warning("HITL callback failed", error=str(e))

            # Wait for human decision (poll with timeout)
            deadline = time.monotonic() + _approval_config.get("timeout_sec", 300)
            while approval.status == "PENDING_APPROVAL" and time.monotonic() < deadline:
                await asyncio.sleep(1)

            if approval.status == "REJECTED":
                logger.info("HITL: request rejected", request_id=approval.request_id)
                _pending_approvals.pop(approval.request_id, None)
                return "⛔ Запрос отклонён оператором (HITL)."
            elif approval.status == "EDITED" and approval.edited_prompt:
                prompt = approval.edited_prompt
                logger.info("HITL: prompt edited by operator", request_id=approval.request_id)
            elif approval.status == "PENDING_APPROVAL":
                logger.warning("HITL: approval timed out", request_id=approval.request_id)
                _pending_approvals.pop(approval.request_id, None)
                return "⏱ Таймаут HITL: оператор не ответил вовремя. Запрос отменён."

            _pending_approvals.pop(approval.request_id, None)

    # --- Vision: detect multimodal content ---
    has_image = bool(image_url or image_base64)

    # Build messages if not provided directly
    if messages is None:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        if has_image:
            content_parts: list[dict] = [{"type": "text", "text": prompt}]
            if image_url:
                content_parts.append({"type": "image_url", "image_url": {"url": image_url}})
            elif image_base64:
                content_parts.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"},
                })
            messages.append({"role": "user", "content": content_parts})
        else:
            messages.append({"role": "user", "content": prompt})

    # --- SmartModelRouter: auto-select model ---
    selected_model = model

    # Vision auto-routing: when image is present, force a vision-capable model
    if has_image and not selected_model:
        selected_model = _VISION_MODELS[0]
        task_type = "vision"
        logger.info("Vision auto-route", model=selected_model)

    if not selected_model and _smart_router:
        try:
            from src.ai.inference._shared import RoutingTask

            inferred_type = _infer_task_type(prompt, task_type)
            routed = _smart_router.route(
                RoutingTask(prompt=prompt[:300], task_type=inferred_type)
            )
            if routed:
                selected_model = routed
                logger.debug("SmartRouter selected", model=selected_model, task_type=inferred_type)
        except Exception:
            pass

    # Fallback model from config
    if not selected_model:
        selected_model = (
            _gateway_config.get("system", {}).get("model_router", {}).get(task_type)
            or _gateway_config.get("system", {}).get("model_router", {}).get("general", "")
        )

    # --- Route: OpenRouter (primary) → vLLM (fallback) ---
    t0 = time.monotonic()
    result = ""
    used_provider = "none"

    api_key = _openrouter_config.get("api_key", "")
    if api_key and _openrouter_config.get("enabled", False):
        result = await _call_openrouter(messages, selected_model, max_tokens, temperature)
        if result:
            used_provider = "openrouter"

    if not result and not _force_cloud:
        result = await _call_vllm_local(messages, selected_model, max_tokens, temperature)
        if result:
            used_provider = "vllm"

    if not result:
        logger.warning("LLMGateway: all providers failed", model=selected_model, task_type=task_type)
        result = ""

    # --- Record metrics ---
    elapsed_ms = (time.monotonic() - t0) * 1000
    if _metrics_collector and result:
        prompt_tokens_est = sum(
            len(m.get("content", "") if isinstance(m.get("content"), str) else str(m.get("content", "")))
            for m in messages
        ) // 4
        completion_tokens_est = len(result) // 4
        _metrics_collector.record_inference(
            model=selected_model or "unknown",
            prompt_tokens=prompt_tokens_est,
            completion_tokens=completion_tokens_est,
            total_latency_ms=elapsed_ms,
            first_token_ms=elapsed_ms * 0.15,
        )

    logger.debug(
        "LLMGateway call",
        provider=used_provider,
        model=selected_model,
        latency_ms=round(elapsed_ms),
        task_type=task_type,
        response_len=len(result),
    )
    return result


def get_metrics_collector():
    """Return the shared InferenceMetricsCollector instance."""
    return _metrics_collector


def get_token_budget():
    """Return the shared AdaptiveTokenBudget instance."""
    return _token_budget


def is_cloud_only() -> bool:
    """Return True if gateway is in cloud-only mode."""
    return _force_cloud


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _infer_task_type(prompt: str, hint: str) -> str:
    """Infer a task type from prompt content when hint is generic."""
    if hint not in ("general", ""):
        return hint
    lower = prompt[:500].lower()
    if any(kw in lower for kw in ["код", "code", "функци", "class", "def ", "import "]):
        return "code"
    if any(kw in lower for kw in ["math", "матем", "вычисл", "формул"]):
        return "math"
    if any(kw in lower for kw in ["напиши", "сочини", "creativ", "story", "стих"]):
        return "creative"
    return "general"


# Last API error details — populated by _call_openrouter for Telegram debug reporting
_last_api_error: Dict[str, Any] = {}


def get_last_api_error() -> Dict[str, Any]:
    """Return the last OpenRouter API error details (for /diag and crash reporting)."""
    return dict(_last_api_error)


async def _call_openrouter(
    messages: List[Dict[str, Any]],
    model: str,
    max_tokens: int,
    temperature: float,
    retries: int = 3,
) -> str:
    """Call OpenRouter API with retry + circuit breaker awareness."""
    from src.openrouter_client import _is_circuit_open, _record_failure, _record_success

    api_key = _openrouter_config.get("api_key", "").strip()
    base_url = _openrouter_config.get("base_url", "https://openrouter.ai/api/v1").rstrip("/")
    endpoint = f"{base_url}/chat/completions"

    if not api_key or _is_circuit_open():
        return ""

    # Free-tier enforcement: reject models without :free suffix to prevent 402
    if _force_cloud and ":free" not in model:
        logger.warning("Free-tier guard: model missing :free suffix, auto-appending", model=model)
        model = model + ":free"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://openclaw.bot",
        "X-Title": "OpenClaw_Autonomous_Agent",
    }
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }

    timeout = aiohttp.ClientTimeout(total=120)
    for attempt in range(retries):
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(endpoint, json=payload, headers=headers) as resp:
                    if resp.status == 200:
                        _record_success()
                        data = await resp.json()
                        content = (
                            data.get("choices", [{}])[0]
                            .get("message", {})
                            .get("content", "")
                        )
                        return content.strip()

                    # Capture full error details for debug reporting
                    error_body = await resp.text()
                    _last_api_error.update({
                        "status": resp.status,
                        "model": model,
                        "endpoint": endpoint,
                        "body": error_body[:1000],
                        "attempt": attempt + 1,
                    })
                    logger.warning(
                        "OpenRouter HTTP error",
                        status=resp.status,
                        model=model,
                        attempt=f"{attempt + 1}/{retries}",
                        body=error_body[:300],
                    )

                    if resp.status == 429 and attempt < retries - 1:
                        wait = min(2 ** attempt * 3, 30)
                        await asyncio.sleep(wait)
                        continue

                    _record_failure()
                    if attempt < retries - 1:
                        await asyncio.sleep(2 ** attempt)
                        continue
        except asyncio.CancelledError:
            raise
        except Exception as e:
            _record_failure()
            _last_api_error.update({
                "status": 0,
                "model": model,
                "endpoint": endpoint,
                "body": str(e)[:1000],
                "attempt": attempt + 1,
            })
            if attempt < retries - 1:
                logger.warning("OpenRouter error", error=str(e), attempt=attempt)
                await asyncio.sleep(2 ** attempt)
                continue
            logger.warning("OpenRouter failed after retries", error=str(e))

    return ""


async def _call_vllm_local(
    messages: List[Dict[str, str]],
    model: str,
    max_tokens: int,
    temperature: float,
    retries: int = 2,
) -> str:
    """Call local vLLM server with retry."""
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }

    for attempt in range(retries):
        try:
            timeout = aiohttp.ClientTimeout(total=120)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(
                    f"{_vllm_url}/chat/completions",
                    json=payload,
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        content = (
                            data.get("choices", [{}])[0]
                            .get("message", {})
                            .get("content", "")
                        )
                        return content.strip()
                    if attempt < retries - 1:
                        await asyncio.sleep(2 ** attempt)
                        continue
        except asyncio.CancelledError:
            raise
        except Exception as e:
            if attempt < retries - 1:
                logger.warning("vLLM error", error=str(e), attempt=attempt)
                await asyncio.sleep(2 ** attempt)
                continue
            logger.warning("vLLM failed after retries", error=str(e))

    return ""
