"""
vLLM inference client: handles chat completions via OpenAI-compatible API,
tool call execution, VRAM protection, and streaming response generation.

Extracted from PipelineExecutor to keep modules under 500 LOC.
"""

import asyncio
import json
import logging
import re
import time
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

import aiohttp
import structlog

from src.mcp_client import OpenClawMCPClient
from src.pipeline_schemas import ROLE_TOKEN_BUDGET, TOOL_ELIGIBLE_ROLES

logger = structlog.get_logger(__name__)


async def call_vllm(
    vllm_url: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
    role_name: str,
    role_config: Dict[str, Any],
    mcp_client: OpenClawMCPClient,
    config: Dict[str, Any],
    vllm_manager=None,
    preserve_think: bool = False,
    json_schema: Optional[Dict] = None,
) -> str:
    """
    Calls local vLLM server (OpenAI-compatible) for a single inference step.
    Endpoint: POST {vllm_url}/chat/completions

    Blocked when use_local_models=false (Cloud-Only mode).
    """
    # Guard: refuse to call local vLLM if local models are disabled
    or_cfg = config.get("system", {}).get("openrouter", {})
    if not or_cfg.get("use_local_models", True):
        logger.error(f"call_vllm blocked: local models disabled (use_local_models=false), role={role_name}")
        return (
            f"[ERROR] Локальная модель заблокирована для {role_name}. "
            "use_local_models=false в конфиге. Используйте OpenRouter или включите локальные модели."
        )

    system_prompt += (
        " Правила плотности: каждое предложение = новый факт."
        " Запрещено: повторять суть в разных формулировках, пустые вступления."
    )

    # max_tokens: role-aware caps to prevent verbose over-generation
    if "max_tokens" in role_config:
        dynamic_max_tokens = role_config["max_tokens"]
    else:
        dynamic_max_tokens = ROLE_TOKEN_BUDGET.get(role_name, 2048)

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    # Inject MCP tools for roles that need them (OpenAI-compatible tool format)
    model_tools = []
    if role_name in TOOL_ELIGIBLE_ROLES:
        all_tools = mcp_client.available_tools_openai
        if all_tools:
            if "Planner" in role_name or "Foreman" in role_name:
                # Planners: read-only subset + web search
                read_only_names = {
                    "list_directory", "read_file", "list_tables", "read_query",
                    "describe_table", "search_memory", "web_search", "web_news_search",
                }
                model_tools = [t for t in all_tools if t.get("function", {}).get("name") in read_only_names]
            else:
                model_tools = all_tools
            if model_tools:
                logger.debug(f"Injecting {len(model_tools)} tools for role {role_name}")

    temperature = role_config.get("temperature", 0.3)
    repetition_penalty = role_config.get("repetition_penalty", 1.05)
    payload: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": False,
        "max_tokens": dynamic_max_tokens,
        "temperature": temperature,
        "repetition_penalty": repetition_penalty,
    }
    if model_tools:
        payload["tools"] = model_tools
    # Structured outputs: force valid JSON conforming to schema
    if json_schema and not model_tools:
        payload["extra_body"] = {
            "structured_outputs": {
                "type": "json",
                "value": json_schema,
            }
        }

    # Per-role timeout: use role_config.timeout_sec if defined, else system default
    system_timeout = config.get("system", {}).get("timeout_sec", 450)
    config_timeout = role_config.get("timeout_sec", system_timeout)

    # Ensure the required model is loaded via vLLM manager
    if vllm_manager:
        await vllm_manager.ensure_model_loaded(model)

    async def _run_inference():
        async with aiohttp.ClientSession() as session:
            try:
                timeout = aiohttp.ClientTimeout(total=config_timeout)
                async with session.post(
                    f"{vllm_url}/chat/completions",
                    json=payload,
                    timeout=timeout,
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        choice = data.get("choices", [{}])[0]
                        msg = choice.get("message", {})

                        # Handle tool calls (OpenAI-compatible format)
                        if msg.get("tool_calls"):
                            tool_calls = msg["tool_calls"]
                            logger.info(f"Model requested tool calls: {tool_calls}")

                            tool_results = []
                            for tool_call in tool_calls:
                                function_name = tool_call["function"]["name"]
                                function_args = tool_call["function"]["arguments"]
                                if isinstance(function_args, str):
                                    try:
                                        function_args = json.loads(function_args)
                                    except json.JSONDecodeError:
                                        pass
                                try:
                                    result = await mcp_client.call_tool(function_name, function_args)
                                    tool_results.append({
                                        "role": "tool",
                                        "tool_call_id": tool_call.get("id", ""),
                                        "content": json.dumps(result),
                                    })
                                    logger.info(f"Tool {function_name} executed. Result: {result}")
                                except Exception as e:
                                    tool_results.append({
                                        "role": "tool",
                                        "tool_call_id": tool_call.get("id", ""),
                                        "content": json.dumps({"error": str(e)}),
                                    })
                                    logger.error(f"Tool {function_name} failed: {e}")

                            messages.append(msg)
                            messages.extend(tool_results)
                            payload["messages"] = messages

                            async with session.post(
                                f"{vllm_url}/chat/completions",
                                json=payload,
                                timeout=timeout,
                            ) as resp2:
                                if resp2.status == 200:
                                    data2 = await resp2.json()
                                    text = data2["choices"][0]["message"]["content"].strip()
                                    if not preserve_think:
                                        text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
                                        text = re.sub(r"<think>.*$", "", text, flags=re.DOTALL).strip()
                                    return text
                                return f"⚠️ vLLM Error after tool call ({resp2.status})"
                        else:
                            text = msg.get("content", "").strip()
                            if not preserve_think:
                                text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
                                text = re.sub(r"<think>.*$", "", text, flags=re.DOTALL).strip()
                            return text
                    else:
                        error_body = ""
                        try:
                            error_body = await resp.text()
                        except Exception:
                            pass
                        # Fallback: if 400 due to tool_choice not supported, retry without tools
                        if resp.status == 400 and "tool" in error_body.lower() and model_tools:
                            logger.warning("vLLM rejected tools, retrying without tool_choice", status=resp.status)
                            payload.pop("tools", None)
                            payload.pop("tool_choice", None)
                            async with session.post(
                                f"{vllm_url}/chat/completions",
                                json=payload,
                                timeout=timeout,
                            ) as retry_resp:
                                if retry_resp.status == 200:
                                    retry_data = await retry_resp.json()
                                    text = retry_data["choices"][0]["message"]["content"].strip()
                                    if not preserve_think:
                                        text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
                                        text = re.sub(r"<think>.*$", "", text, flags=re.DOTALL).strip()
                                    return text
                                retry_body = await retry_resp.text()
                                return f"⚠️ vLLM Error ({retry_resp.status}): {retry_body[:200]}"
                        if resp.status == 404:
                            return (
                                f"⚠️ Model `{model}` not found on vLLM server (HTTP 404).\n"
                                f"Check that the model is downloaded and available."
                            )
                        return f"⚠️ vLLM Error ({resp.status}): {error_body[:200]}"
            except asyncio.TimeoutError:
                return f"❌ Timeout: model did not respond within {config_timeout}s"
            except Exception as e:
                return f"❌ Error: {e}"

    from src.task_queue import model_queue

    return await model_queue.enqueue(model, _run_inference)


async def force_unload(model: str):
    """No-op for vLLM — model lifecycle is managed by VLLMModelManager."""
    pass


@asynccontextmanager
async def vram_protection(target_model: str, prev_model: Optional[str]):
    """Context manager to ensure strict VRAM unloading and logging heavy switches."""
    switch_start = time.time()

    # Unload prev model if different (VRAM Guard 2.0)
    if prev_model and prev_model != target_model:
        logger.info(f"[VRAM Guard 2.0] Anti-thrash: unloading {prev_model} before loading {target_model}")
        unload_start = time.time()
        await force_unload(prev_model)
        unload_duration = time.time() - unload_start
        if unload_duration > 10:
            logger.warning(f"⚠️ [VRAM ALERT] Unloading {prev_model} took excessive time: {unload_duration:.2f}s!")

    try:
        yield
    finally:
        # Leave model hot. It will be unloaded when switching to a differently named model.
        pass


async def execute_stream(
    executor,
    prompt: str,
    brigade: str = "Dmarket",
    max_steps: int = 5,
    status_callback=None,
    task_type: Optional[str] = None,
):
    """
    Same as execute(), but the LAST step (Archivist) yields token chunks via async generator.
    All prior steps run normally. Returns dict with 'stream' key holding the async generator,
    plus 'chain_executed' and 'brigade' metadata.
    """
    result = await executor.execute(
        prompt=prompt, brigade=brigade, max_steps=max_steps,
        status_callback=status_callback, task_type=task_type,
    )
    final_text = result.get("final_response", "")

    async def _chunk_generator(text: str, chunk_size: int = 80):
        """Yields the final response in chunks for progressive Telegram message edits."""
        for i in range(0, len(text), chunk_size):
            yield text[i:i + chunk_size]
            await asyncio.sleep(0.05)

    result["stream"] = _chunk_generator(final_text)
    return result
