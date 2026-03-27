"""
OpenRouter inference client with local vLLM fallback.

Provides call_openrouter() — tries OpenRouter API first (primary),
falls back to local vLLM server on failure. Both use OpenAI-compatible
chat/completions endpoint.

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

# Circuit breaker state
_circuit_breaker = {
    "failures": 0,
    "last_failure": 0.0,
    "open_until": 0.0,
    "threshold": 5,       # consecutive failures before opening circuit
    "cooldown_sec": 120,  # how long to wait before retrying after circuit opens
}

# Rate limit state (updated from response headers)
_rate_limit_state = {
    "requests_remaining": 999,
    "tokens_remaining": 999_999,
    "reset_at": 0.0,
}


def _update_rate_limits(headers: Dict[str, str]) -> None:
    """Update rate limit state from OpenRouter response headers."""
    try:
        if "x-ratelimit-remaining-requests" in headers:
            _rate_limit_state["requests_remaining"] = int(headers["x-ratelimit-remaining-requests"])
        if "x-ratelimit-remaining-tokens" in headers:
            _rate_limit_state["tokens_remaining"] = int(headers["x-ratelimit-remaining-tokens"])
    except (ValueError, KeyError):
        pass


def _is_circuit_open() -> bool:
    """Check if circuit breaker is open (too many failures)."""
    if _circuit_breaker["failures"] >= _circuit_breaker["threshold"]:
        if time.time() < _circuit_breaker["open_until"]:
            return True
        # Cooldown expired — allow a probe
        _circuit_breaker["failures"] = 0
    return False


def _record_failure() -> None:
    """Record a failure for circuit breaker."""
    _circuit_breaker["failures"] += 1
    _circuit_breaker["last_failure"] = time.time()
    if _circuit_breaker["failures"] >= _circuit_breaker["threshold"]:
        _circuit_breaker["open_until"] = time.time() + _circuit_breaker["cooldown_sec"]
        logger.warning(
            "Circuit breaker OPEN — backing off OpenRouter",
            cooldown_sec=_circuit_breaker["cooldown_sec"],
        )


def _record_success() -> None:
    """Record a success — reset circuit breaker."""
    _circuit_breaker["failures"] = 0


def get_rate_limit_info() -> Dict[str, Any]:
    """Get current rate-limit and circuit breaker state."""
    return {
        "requests_remaining": _rate_limit_state["requests_remaining"],
        "tokens_remaining": _rate_limit_state["tokens_remaining"],
        "circuit_open": _is_circuit_open(),
        "consecutive_failures": _circuit_breaker["failures"],
    }


async def call_openrouter(
    openrouter_config: Dict[str, Any],
    vllm_url: str,
    model: str,
    fallback_model: str,
    system_prompt: str,
    user_prompt: str,
    role_name: str,
    role_config: Dict[str, Any],
    mcp_client: Any,
    config: Dict[str, Any],
    vllm_manager: Any = None,
    preserve_think: bool = False,
    json_schema: Optional[Dict] = None,
    tools: Optional[List[Dict]] = None,
) -> str:
    """
    Try OpenRouter first, fall back to local vLLM on error.

    Args:
        openrouter_config: {"api_key": ..., "base_url": ...}
        vllm_url: Local vLLM server URL (fallback)
        model: OpenRouter model ID (e.g. "nvidia/nemotron-3-super-120b-a12b:free")
        fallback_model: Local vLLM model ID (e.g. "Qwen/Qwen2.5-Coder-14B-Instruct-AWQ")
        Other params: same as call_vllm
    """
    from src.pipeline_schemas import ROLE_TOKEN_BUDGET

    api_key = openrouter_config.get("api_key", "").strip()
    base_url = openrouter_config.get("base_url", OPENROUTER_BASE_URL).rstrip("/")

    max_tokens = role_config.get("max_tokens", ROLE_TOKEN_BUDGET.get(role_name, 2048))
    temperature = role_config.get("temperature", 0.3)

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    payload: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": False,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if tools:
        payload["tools"] = tools

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://openclaw.bot",
        "X-Title": "OpenClaw_Autonomous_Agent",
    }

    timeout_sec = role_config.get("timeout_sec", config.get("system", {}).get("timeout_sec", 120))
    max_retries = role_config.get("max_retries", 3)

    # --- Try OpenRouter (with retry + circuit breaker) ---
    if api_key and not _is_circuit_open():
        timeout = aiohttp.ClientTimeout(total=timeout_sec)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            for attempt in range(max_retries):
                try:
                    async with session.post(
                        f"{base_url}/chat/completions",
                        json=payload,
                        headers=headers,
                    ) as resp:
                        # Track rate limits from headers
                        _update_rate_limits(dict(resp.headers))

                        if resp.status == 200:
                            _record_success()
                            data = await resp.json()
                            choice = data.get("choices", [{}])[0]
                            msg = choice.get("message", {})

                            # Handle tool calls
                            if msg.get("tool_calls") and tools:
                                tool_results = await _execute_tool_calls(
                                    msg["tool_calls"], mcp_client
                                )
                                messages.append(msg)
                                messages.extend(tool_results)
                                payload["messages"] = messages

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
                                            text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
                                        if not text:
                                            raise ValueError("OpenRouter returned empty content after tool call")
                                        logger.info(f"OpenRouter OK for {role_name}", model=model)
                                        return text

                            text = (msg.get("content") or "").strip()
                            if not preserve_think:
                                text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
                            if not text:
                                # Empty/null content — treat as retryable error
                                raise ValueError("OpenRouter returned empty content")
                            logger.info(f"OpenRouter OK for {role_name}", model=model)
                            return text

                        # Rate limited: retry with backoff
                        if resp.status == 429:
                            _record_failure()
                            wait = min(2 ** attempt * 2, 30)
                            logger.warning(
                                f"OpenRouter rate-limited for {role_name}, retry {attempt + 1}/{max_retries} in {wait}s"
                            )
                            await asyncio.sleep(wait)
                            continue

                        # Non-200: capture full error for Telegram debug
                        error_body = await resp.text()
                        from src.llm_gateway import _last_api_error
                        _last_api_error.update({
                            "status": resp.status,
                            "model": model,
                            "endpoint": f"{base_url}/chat/completions",
                            "body": error_body[:1000],
                            "role": role_name,
                            "attempt": attempt + 1,
                        })
                        logger.warning(
                            "OpenRouter HTTP error (pipeline)",
                            status=resp.status,
                            role=role_name,
                            model=model,
                            attempt=f"{attempt + 1}/{max_retries}",
                            body=error_body[:300],
                        )
                        if attempt < max_retries - 1:
                            await asyncio.sleep(2 ** attempt)
                            continue
                        _record_failure()

                except asyncio.TimeoutError:
                    logger.warning(
                        f"OpenRouter timeout for {role_name} ({timeout_sec}s), attempt {attempt + 1}/{max_retries}"
                    )
                    _record_failure()
                    if attempt < max_retries - 1:
                        await asyncio.sleep(2 ** attempt)
                        continue

                except Exception as e:
                    logger.warning(f"OpenRouter error for {role_name}: {e}, attempt {attempt + 1}/{max_retries}")
                    _record_failure()
                    if attempt < max_retries - 1:
                        await asyncio.sleep(2 ** attempt)
                        continue
    elif _is_circuit_open():
        logger.info(f"Circuit breaker open — skipping OpenRouter for {role_name}")

    # --- Fallback: local vLLM (only if explicitly allowed) ---
    force_cloud = openrouter_config.get("force_cloud", False)
    use_local_models = openrouter_config.get("use_local_models", True)
    allow_fallback = (
        openrouter_config.get("fallback_to_vllm", True)
        and not force_cloud
        and use_local_models
    )

    if not allow_fallback:
        logger.error(
            f"OpenRouter failed for {role_name} — local models DISABLED "
            f"(force_cloud={force_cloud}, use_local_models={use_local_models}). "
            "Returning error to user."
        )
        return (
            f"[ERROR] API недоступно для роли {role_name}. "
            f"Все {_circuit_breaker['threshold']} попыток исчерпаны. "
            "Локальные модели отключены (use_local_models=false). "
            "Проверьте API-ключ OpenRouter или включите локальные модели в конфиге."
        )

    logger.info(f"Using vLLM fallback for {role_name}", model=fallback_model)
    from src.vllm_inference import call_vllm

    return await call_vllm(
        vllm_url=vllm_url,
        model=fallback_model,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        role_name=role_name,
        role_config=role_config,
        mcp_client=mcp_client,
        config=config,
        vllm_manager=vllm_manager,
        preserve_think=preserve_think,
        json_schema=json_schema,
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


async def test_openrouter(api_key: str, model: str = "arcee-ai/trinity-mini:free") -> Dict[str, Any]:
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
