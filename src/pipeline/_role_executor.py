"""Single pipeline step executor + OpenRouter inference routing.

Extracted from _core.py for modularity.
"""

from __future__ import annotations

import time
from typing import Any, Dict, Optional

import structlog

from src.llm.gateway import route_llm
from src.llm.openrouter import call_openrouter
from src.pipeline_schemas import ROLE_TOKEN_BUDGET
from src.pipeline_utils import build_role_prompt

logger = structlog.get_logger(__name__)


async def run_single_step(
    *,
    role_name: str,
    step_index: int,
    chain_len: int,
    brigade: str,
    prompt: str,
    context_briefing: str,
    config: Dict[str, Any],
    framework_root: str,
    smart_router: Any,
    openrouter_config: Dict[str, Any],
    openrouter_enabled: bool,
    metrics_collector: Any,
    mcp_client: Any,
    status_callback: Any = None,
    task_type: Optional[str] = None,
) -> str:
    """Run a single pipeline step — used for parallel Executor dispatch.

    This is a standalone coroutine so it can be called from TaskGroup.
    """
    role_config = (
        config.get("brigades", {}).get(brigade, {}).get("roles", {}).get(role_name, {})
    )
    if not role_config:
        return f"⚠️ Role '{role_name}' not found in config."

    model = role_config.get("model", "meta-llama/llama-3.3-70b-instruct:free")
    system_prompt = build_role_prompt(role_name, role_config, framework_root)

    step_prompt = (
        f"[PIPELINE CONTEXT from previous step]\n{context_briefing}\n\n"
        f"[ORIGINAL USER TASK]\n{prompt}\n\n"
        f"Based on the above context, perform your role as {role_name}."
    )

    if status_callback:
        display_model = role_config.get("openrouter_model") or model
        await status_callback(role_name, display_model, f"⚡ Параллельно: {role_name} работает...")

    return await call_llm(
        model=model,
        system_prompt=system_prompt,
        user_prompt=step_prompt,
        role_name=role_name,
        role_config=role_config,
        mcp_client=mcp_client,
        config=config,
        smart_router=smart_router,
        openrouter_config=openrouter_config,
        openrouter_enabled=openrouter_enabled,
        metrics_collector=metrics_collector,
    )


async def call_llm(
    *,
    model: str,
    system_prompt: str,
    user_prompt: str,
    role_name: str,
    role_config: Dict[str, Any],
    mcp_client: Any,
    config: Dict[str, Any],
    smart_router: Any = None,
    openrouter_config: Optional[Dict[str, Any]] = None,
    openrouter_enabled: bool = False,
    metrics_collector: Any = None,
    preserve_think: bool = False,
    json_schema: Optional[Dict] = None,
) -> str:
    """Unified LLM call with SmartRouter selection and metrics recording."""
    from src.ai.inference._shared import RoutingTask

    or_model = role_config.get("openrouter_model")

    if not or_model and smart_router:
        task_type = "general"
        lower_prompt = user_prompt[:500].lower()
        if any(kw in lower_prompt for kw in ["код", "code", "функци", "class", "def ", "import "]):
            task_type = "code"
        elif any(kw in lower_prompt for kw in ["math", "матем", "вычисл", "формул"]):
            task_type = "math"
        elif any(kw in lower_prompt for kw in ["напиши", "сочини", "creativ", "story", "стих"]):
            task_type = "creative"
        routed_model = smart_router.route(RoutingTask(prompt=user_prompt[:300], task_type=task_type))
        if routed_model:
            or_model = routed_model
            logger.info("SmartRouter selected model", model=or_model, task_type=task_type, role=role_name)

    fallback = role_config.get("fallback_model", model)

    # Auditor context isolation
    if "Auditor" in role_name:
        auditor_budget = ROLE_TOKEN_BUDGET.get("Auditor", 1536)
        max_prompt_chars = auditor_budget * 4
        if len(user_prompt) > max_prompt_chars:
            logger.warning("Auditor context truncated", original_chars=len(user_prompt), budget_chars=max_prompt_chars)
            user_prompt = user_prompt[:max_prompt_chars] + "\n\n[... контекст сокращён для Auditor ...]"

    t0 = time.monotonic()
    if openrouter_enabled and or_model:
        result = await call_openrouter(
            openrouter_config=openrouter_config or {},
            model=or_model,
            fallback_model=fallback,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            role_name=role_name,
            role_config=role_config,
            mcp_client=mcp_client,
            config=config,
            preserve_think=preserve_think,
            json_schema=json_schema,
        )
    else:
        result = await route_llm(
            user_prompt,
            system=system_prompt,
            model=model,
            max_tokens=role_config.get("max_tokens", 2048),
            temperature=role_config.get("temperature", 0.3),
        )
    elapsed_ms = (time.monotonic() - t0) * 1000

    if metrics_collector:
        used_model = or_model or model
        prompt_tokens_est = (len(system_prompt) + len(user_prompt)) // 4
        completion_tokens_est = len(result) // 4
        metrics_collector.record_inference(
            model=used_model,
            prompt_tokens=prompt_tokens_est,
            completion_tokens=completion_tokens_est,
            total_latency_ms=elapsed_ms,
            first_token_ms=elapsed_ms * 0.15,
        )
    return result
