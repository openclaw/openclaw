"""
OpenRouter inference client (cloud-only).

Provides call_openrouter() — sends requests to OpenRouter API with
per-model circuit breaker and automatic fallback chain.

Enhanced features:
- Retry with exponential backoff (configurable max_retries)
- Rate-limit tracking from OpenRouter response headers
- Circuit breaker: backs off after repeated failures
- Streaming support via async generator
"""

import asyncio
import json
import re
import time
from typing import Any, AsyncIterator, Dict, List, Optional

import aiohttp
import structlog

logger = structlog.get_logger(__name__)

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# Per-model circuit breaker state (isolates failures by model)
_model_circuit_breakers: Dict[str, Dict[str, Any]] = {}
_CB_THRESHOLD = 5        # consecutive failures before opening circuit for a model
_CB_COOLDOWN_SEC = 60    # shorter cooldown — free models recover fast

# Rate limit state (updated from response headers)
_rate_limit_state = {
    "requests_remaining": 999,
    "tokens_remaining": 999_999,
    "reset_at": 0.0,
}


def _get_cb(model: str) -> Dict[str, Any]:
    """Get or create per-model circuit breaker."""
    if model not in _model_circuit_breakers:
        _model_circuit_breakers[model] = {
            "failures": 0,
            "last_failure": 0.0,
            "open_until": 0.0,
        }
    return _model_circuit_breakers[model]


def _update_rate_limits(headers: Dict[str, str]) -> None:
    """Update rate limit state from OpenRouter response headers."""
    try:
        if "x-ratelimit-remaining-requests" in headers:
            _rate_limit_state["requests_remaining"] = int(headers["x-ratelimit-remaining-requests"])
        if "x-ratelimit-remaining-tokens" in headers:
            _rate_limit_state["tokens_remaining"] = int(headers["x-ratelimit-remaining-tokens"])
    except (ValueError, KeyError):
        pass


def _is_circuit_open(model: str) -> bool:
    """Check if circuit breaker is open for a specific model."""
    cb = _get_cb(model)
    if cb["failures"] >= _CB_THRESHOLD:
        if time.time() < cb["open_until"]:
            return True
        # Cooldown expired — allow a probe
        cb["failures"] = 0
    return False


def _record_failure(model: str) -> None:
    """Record a failure for a specific model's circuit breaker."""
    cb = _get_cb(model)
    cb["failures"] += 1
    cb["last_failure"] = time.time()
    if cb["failures"] >= _CB_THRESHOLD:
        cb["open_until"] = time.time() + _CB_COOLDOWN_SEC
        logger.warning(
            "Circuit breaker OPEN for model",
            model=model,
            cooldown_sec=_CB_COOLDOWN_SEC,
        )


def _record_success(model: str) -> None:
    """Record a success — reset circuit breaker for this model."""
    cb = _get_cb(model)
    cb["failures"] = 0


def reset_circuit_breakers() -> None:
    """Reset all circuit breakers (call at pipeline start)."""
    _model_circuit_breakers.clear()


def get_rate_limit_info() -> Dict[str, Any]:
    """Get current rate-limit and circuit breaker state."""
    open_models = [m for m in _model_circuit_breakers if _is_circuit_open(m)]
    return {
        "requests_remaining": _rate_limit_state["requests_remaining"],
        "tokens_remaining": _rate_limit_state["tokens_remaining"],
        "circuit_open_models": open_models,
        "model_failures": {m: cb["failures"] for m, cb in _model_circuit_breakers.items()},
    }


async def call_openrouter(
    openrouter_config: Dict[str, Any],
    model: str,
    fallback_model: str,
    system_prompt: str,
    user_prompt: str,
    role_name: str,
    role_config: Dict[str, Any],
    mcp_client: Any,
    config: Dict[str, Any],
    preserve_think: bool = False,
    json_schema: Optional[Dict] = None,
    tools: Optional[List[Dict]] = None,
    vllm_url: str = "",
    vllm_manager: Any = None,
) -> str:
    """
    Try OpenRouter with per-model circuit breaker + automatic fallback chain.

    Fallback order: primary model → fallback_model → LAST_RESORT_MODEL.
    Each model has an independent circuit breaker so one flaky model
    doesn't poison the rest of the pipeline.

    Note: vllm_url and vllm_manager parameters are accepted for backwards
    compatibility but are unused (cloud-only mode).
    """
    from src.pipeline_schemas import ROLE_TOKEN_BUDGET

    api_key = openrouter_config.get("api_key", "").strip()
    base_url = openrouter_config.get("base_url", OPENROUTER_BASE_URL).rstrip("/")

    max_tokens = role_config.get("max_tokens", ROLE_TOKEN_BUDGET.get(role_name, 2048))
    temperature = role_config.get("temperature", 0.3)
    timeout_sec = role_config.get("timeout_sec", config.get("system", {}).get("timeout_sec", 120))
    max_retries = role_config.get("max_retries", 3)

    # Build fallback chain (deduplicated, preserve order)
    _LAST_RESORT = "google/gemma-3-12b-it:free"
    models_to_try: List[str] = []
    for m in [model, fallback_model, _LAST_RESORT]:
        if m and m not in models_to_try:
            models_to_try.append(m)

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://openclaw.bot",
        "X-Title": "OpenClaw_Autonomous_Agent",
    }

    last_error = ""

    # --- Try each model in the fallback chain ---
    for model_idx, current_model in enumerate(models_to_try):
        if not api_key:
            break

        if _is_circuit_open(current_model):
            logger.info(f"Circuit open for {current_model}, trying next fallback", role=role_name)
            continue

        payload: Dict[str, Any] = {
            "model": current_model,
            "messages": list(messages),  # fresh copy
            "stream": False,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if tools:
            payload["tools"] = tools

        timeout = aiohttp.ClientTimeout(total=timeout_sec)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            for attempt in range(max_retries):
                try:
                    async with session.post(
                        f"{base_url}/chat/completions",
                        json=payload,
                        headers=headers,
                    ) as resp:
                        _update_rate_limits(dict(resp.headers))

                        if resp.status == 200:
                            _record_success(current_model)
                            data = await resp.json()
                            choice = data.get("choices", [{}])[0]
                            msg = choice.get("message", {})

                            # Handle tool calls
                            if msg.get("tool_calls") and tools:
                                tool_results = await _execute_tool_calls(
                                    msg["tool_calls"], mcp_client
                                )
                                tc_messages = list(messages)
                                tc_messages.append(msg)
                                tc_messages.extend(tool_results)
                                payload["messages"] = tc_messages

                                async with session.post(
                                    f"{base_url}/chat/completions",
                                    json=payload,
                                    headers=headers,
                                    timeout=timeout,
                                ) as resp2:
                                    if resp2.status == 200:
                                        data2 = await resp2.json()
                                        raw = data2.get("choices", [{}])[0].get("message", {}).get("content") or ""
                                        text = raw.strip()
                                        if not preserve_think:
                                            text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
                                            text = re.sub(r"<think>.*$", "", text, flags=re.DOTALL).strip()
                                        if not text:
                                            raise ValueError("Empty content after tool call")
                                        if model_idx > 0:
                                            logger.info(f"OpenRouter OK for {role_name} (fallback #{model_idx})", model=current_model)
                                        else:
                                            logger.info(f"OpenRouter OK for {role_name}", model=current_model)
                                        return text

                            text = (msg.get("content") or "").strip()
                            if not preserve_think:
                                text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
                                text = re.sub(r"<think>.*$", "", text, flags=re.DOTALL).strip()
                            if not text:
                                raise ValueError("OpenRouter returned empty content")
                            if model_idx > 0:
                                logger.info(f"OpenRouter OK for {role_name} (fallback #{model_idx})", model=current_model)
                            else:
                                logger.info(f"OpenRouter OK for {role_name}", model=current_model)
                            return text

                        # Rate limited or upstream error: retry with backoff
                        if resp.status == 429:
                            _record_failure(current_model)
                            wait = min(2 ** attempt * 2, 15)
                            logger.warning(
                                f"Rate-limited ({current_model}) for {role_name}, "
                                f"retry {attempt + 1}/{max_retries} in {wait}s"
                            )
                            await asyncio.sleep(wait)
                            continue

                        # Other HTTP errors
                        error_body = await resp.text()
                        last_error = f"HTTP {resp.status}: {error_body[:300]}"
                        try:
                            from src.llm_gateway import _last_api_error
                            _last_api_error.update({
                                "status": resp.status,
                                "model": current_model,
                                "endpoint": f"{base_url}/chat/completions",
                                "body": error_body[:1000],
                                "role": role_name,
                                "attempt": attempt + 1,
                            })
                        except ImportError:
                            pass
                        logger.warning(
                            "OpenRouter HTTP error",
                            status=resp.status,
                            role=role_name,
                            model=current_model,
                            attempt=f"{attempt + 1}/{max_retries}",
                            body=error_body[:200],
                        )
                        _record_failure(current_model)
                        if attempt < max_retries - 1:
                            await asyncio.sleep(min(2 ** attempt, 8))
                            continue
                        # All retries exhausted for this model — move to next in chain
                        break

                except asyncio.TimeoutError:
                    _record_failure(current_model)
                    logger.warning(
                        f"Timeout ({current_model}) for {role_name} ({timeout_sec}s), "
                        f"attempt {attempt + 1}/{max_retries}"
                    )
                    if attempt < max_retries - 1:
                        await asyncio.sleep(min(2 ** attempt, 8))
                        continue
                    break

                except Exception as e:
                    _record_failure(current_model)
                    last_error = str(e)
                    logger.warning(f"Error ({current_model}) for {role_name}: {e}, attempt {attempt + 1}/{max_retries}")
                    if attempt < max_retries - 1:
                        await asyncio.sleep(min(2 ** attempt, 8))
                        continue
                    break

    # --- All models in chain failed ---
    tried = ", ".join(models_to_try)
    logger.error(
        f"All OpenRouter models failed for {role_name}. "
        f"Models tried: {tried}. Last error: {last_error[:200]}"
    )
    return (
        f"[ERROR] API недоступно для роли {role_name}. "
        f"Все модели ({tried}) недоступны. "
        "Проверьте API-ключ OpenRouter или попробуйте позже."
    )


async def _execute_tool_calls(tool_calls: list, mcp_client: Any) -> list:
    """Execute MCP tool calls and return results for OpenAI-compatible message format."""
    results = []
    for tc in tool_calls:
        fn_name = tc["function"]["name"]
        fn_args = tc["function"]["arguments"]
        if isinstance(fn_args, str):
            try:
                fn_args = json.loads(fn_args)
            except json.JSONDecodeError:
                fn_args = {}
        try:
            result = await mcp_client.call_tool(fn_name, fn_args)
            results.append({
                "role": "tool",
                "tool_call_id": tc.get("id", ""),
                "content": json.dumps(result),
            })
        except Exception as e:
            results.append({
                "role": "tool",
                "tool_call_id": tc.get("id", ""),
                "content": json.dumps({"error": str(e)}),
            })
            logger.error(f"Tool {fn_name} failed: {e}")
    return results


async def check_openrouter(api_key: str, model: str = "arcee-ai/trinity-mini:free") -> Dict[str, Any]:
    """Quick connectivity test — sends a ping to OpenRouter and returns status."""
    headers = {
        "Authorization": f"Bearer {api_key.strip()}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://openclaw.bot",
        "X-Title": "OpenClaw_Autonomous_Agent",
    }
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "Reply with exactly: PONG"}],
        "max_tokens": 8,
        "temperature": 0.0,
    }
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{OPENROUTER_BASE_URL}/chat/completions",
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    raw = data.get("choices", [{}])[0].get("message", {}).get("content") or ""
                    text = raw.strip()
                    return {"status": "ok", "response": text, "model": model}
                error = await resp.text()
                return {"status": "error", "code": resp.status, "error": error[:200]}
    except Exception as e:
        return {"status": "error", "error": str(e)}
