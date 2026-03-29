"""Pipeline tools handler — Planner→Executor handoff, ReAct, sandbox, MCP execution."""

import json
import re
from typing import Any, Dict, List

import structlog

logger = structlog.get_logger(__name__)


async def handle_planner_handoff(
    executor,
    extracted_json_str: str,
    role_name: str,
    model: str,
    brigade: str,
    active_mcp,
    status_callback,
    steps_results: List[Dict[str, Any]],
    response: str,
) -> bool:
    """Execute Planner→Executor handoff with ReAct, sandbox, and PoW.

    Appends step results to ``steps_results`` in-place.
    Returns True if the handoff was executed (caller should break the loop).
    """
    executor_model = executor.config.get("system", {}).get("model_router", {}).get(
        "tool_execution", "meta-llama/llama-3.3-70b-instruct:free"
    )
    executor_role_cfg = (
        executor.config.get("brigades", {}).get(brigade, {}).get("roles", {}).get("Executor_Tools", {})
    )
    display_exec_model = executor._display_model(executor_role_cfg, executor_model)
    logger.info(f"JSON instructions detected from Planner, executing Handoff to {display_exec_model}")

    steps_results.append({"role": role_name, "model": model, "response": response})

    await executor._force_unload(model)

    executor_role = "Executor_Tools"
    executor_sys = (
        executor.config.get("brigades", {}).get(brigade, {}).get("roles", {})
        .get(executor_role, {}).get("system_prompt", "Ты — Executor_Tools. Выполняй команды.")
    )
    executor_prompt = f"Выполни эту инструкцию через доступные инструменты:\n```json\n{extracted_json_str}\n```"

    if status_callback:
        await status_callback(executor_role, display_exec_model, "🛠 Исполнитель вызывает инструменты MCP...")

    executor_config = {"model": executor_model}
    logger.info(f"DEBUG: active_mcp is {active_mcp}")
    if active_mcp:
        logger.info(f"DEBUG: active_mcp tool_route_map keys: {list(active_mcp._tool_route_map.keys())}")

    # --- Phase 6: ReAct reasoning for Executor_Tools ---
    react_tools = []
    if active_mcp and hasattr(active_mcp, '_tool_route_map'):
        for tname in active_mcp._tool_route_map:
            react_tools.append({"name": tname, "description": f"MCP tool: {tname}"})

    # Phase 7: register sandbox tools for ReAct
    react_tools.append({
        "name": "sandbox_execute",
        "description": "Execute generated Python/Bash code in an isolated sandbox. Input: JSON with 'code' and optional 'language' (python|bash).",
    })
    react_tools.append({
        "name": "sandbox_list_skills",
        "description": "List all saved sandbox skills/tools available for reuse.",
    })

    # Phase 8: register YouTube analyzer for ReAct
    react_tools.append({
        "name": "analyze_youtube_video",
        "description": "Extract transcript and metadata from a YouTube video. Input: JSON with 'url' (YouTube URL or video ID). Returns title, description, transcript text.",
    })

    executor_response = await _react_execution(
        executor, executor_prompt, react_tools, executor_model, active_mcp,
    )

    # Classic execution fallback (if ReAct didn't finish)
    if executor_response is None:
        executor_response = await _classic_execution(
            executor, executor_model, executor_sys, executor_prompt,
            executor_role, executor_config, active_mcp,
        )

    steps_results.append({"role": executor_role, "model": executor_model, "response": executor_response})

    # --- PHYSICAL MCP EXECUTION BLOCK ---
    executor_response = await _execute_mcp_tool(active_mcp, executor_response)

    # --- Proof of Work Verification ---
    if status_callback:
        await status_callback(executor_role, display_exec_model, "🔎 Ядро проверяет Proof of Work через MCP...")

    pow_result = await _verify_proof_of_work(active_mcp, extracted_json_str)
    if pow_result:
        executor_response += f"\n\n[Proof of Work Auto-Verification]:\n{pow_result}"
        steps_results[-1]["response"] = executor_response

    return True


async def _react_execution(executor, executor_prompt, react_tools, executor_model, active_mcp):
    """Run ReAct reasoning. Returns executor_response or None if ReAct didn't finish."""
    if not react_tools:
        return None

    try:
        executor._react_reasoner.model = executor_model
        react_result = await executor._react_reasoner.reason(
            prompt=executor_prompt, tools=react_tools, max_steps=5,
        )
        for step in react_result.steps:
            if step.action and step.action != "Finish":
                try:
                    if step.action == "sandbox_execute":
                        payload = json.loads(step.action_input) if step.action_input else {}
                        sb_result = await executor._sandbox.execute(
                            code=payload.get("code", ""),
                            language=payload.get("language", "python"),
                        )
                        step.observation = (
                            f"exit={sb_result.exit_code} stdout={sb_result.stdout[:1500]} stderr={sb_result.stderr[:500]}"
                        )
                        if sb_result.success:
                            executor._sandbox.save_as_skill(
                                name=payload.get("name", "auto_skill"),
                                description=payload.get("description", "Auto-synthesized skill"),
                                result=sb_result,
                                code=payload.get("code", ""),
                                language=payload.get("language", "python"),
                            )
                    elif step.action == "sandbox_list_skills":
                        step.observation = str(executor._sandbox.skill_library.list_skills())[:2000]
                    elif step.action == "analyze_youtube_video":
                        from src.tools.youtube_parser import analyze_youtube_video
                        payload = json.loads(step.action_input) if step.action_input else {}
                        url_or_id = payload.get("url", payload.get("query", step.action_input or ""))
                        yt_result = await analyze_youtube_video(url_or_id)
                        step.observation = yt_result.to_context()[:2000]
                    elif active_mcp:
                        tool_output = await active_mcp.call_tool(
                            step.action, {"query": step.action_input} if step.action_input else {},
                        )
                        step.observation = str(tool_output)[:2000]
                    else:
                        step.observation = f"No handler for tool: {step.action}"
                except Exception as te:
                    step.observation = f"Tool error: {te}"

        if react_result.finished and react_result.answer:
            logger.info("ReAct reasoning succeeded for Executor_Tools", steps=react_result.total_steps)
            return react_result.answer
    except Exception as e:
        logger.warning("ReAct reasoning failed, falling back to classic", error=str(e))

    return None


async def _classic_execution(executor, executor_model, executor_sys, executor_prompt, executor_role, executor_config, active_mcp):
    """Classic tool execution with auto-correction loop."""
    async with executor._vram_protection(executor_model, executor.last_loaded_model):
        executor.last_loaded_model = executor_model
        max_retries = 3
        for attempt in range(max_retries):
            executor_response = await executor._call_vllm(
                executor_model, executor_sys, executor_prompt, executor_role, executor_config, active_mcp,
            )

            valid_tools = (
                list(active_mcp._tool_route_map.keys())
                if active_mcp and hasattr(active_mcp, '_tool_route_map')
                else ["read_query", "write_query", "list_tables", "describe_table",
                       "read_file", "write_file", "list_allowed_directories", "execute_command"]
            )
            json_match = re.search(r"```json\n(.*?)\n```", executor_response, re.DOTALL)
            if not json_match:
                json_match = re.search(r"{.*?}", executor_response, re.DOTALL)

            if json_match:
                try:
                    exec_str = json_match.group(1) if "```" in executor_response else json_match.group(0)
                    exec_str = exec_str.strip().replace("}\n{", "},{")
                    if exec_str.startswith("{") and exec_str.endswith("}") and "},{" in exec_str:
                        exec_str = f"[{exec_str}]"

                    exec_json = json.loads(exec_str)
                    if isinstance(exec_json, list):
                        exec_json = exec_json[0] if len(exec_json) > 0 else {}
                    tool_name = exec_json.get("name")

                    if tool_name == "create_table":
                        logger.warning(f"Executor tried unsafe create_table. Retrying (Attempt {attempt+1}/{max_retries})")
                        executor_prompt += "\n\nОшибка: Инструмент create_table небезопасен. Используй write_query для этой задачи."
                        continue
                    elif tool_name and tool_name not in valid_tools:
                        logger.warning(f"Executor hallucinated tool name: {tool_name}. Retrying (Attempt {attempt+1}/{max_retries})")
                        executor_prompt += f"\n\nОшибка: инструмента '{tool_name}' не существует. Доступные инструменты: {', '.join(valid_tools)}. Перепиши свой JSON, используя строго только разрешенные имена."
                        continue
                except json.JSONDecodeError:
                    pass

            break

    return executor_response


async def _execute_mcp_tool(active_mcp, executor_response: str) -> str:
    """Execute the parsed tool call on the MCP server. Returns updated executor_response."""
    json_match = re.search(r"```json\n(.*?)\n```", executor_response, re.DOTALL)
    if not json_match:
        json_match = re.search(r"{.*?}", executor_response, re.DOTALL)

    if not json_match:
        return executor_response

    try:
        exec_str = json_match.group(1) if "```" in executor_response else json_match.group(0)
        exec_str = exec_str.strip().replace("}\n{", "},{")
        if exec_str.startswith("{") and exec_str.endswith("}") and "},{" in exec_str:
            exec_str = f"[{exec_str}]"

        exec_json = json.loads(exec_str)
        if isinstance(exec_json, list):
            exec_json = exec_json[0] if len(exec_json) > 0 else {}
        tool_name = exec_json.get("name")
        tool_args = exec_json.get("arguments", {})

        if tool_name:
            # Normalize hallucinated argument names
            if tool_name == "write_query":
                for hallucinated_key in ["command", "sql"]:
                    if hallucinated_key in tool_args and "query" not in tool_args:
                        logger.info(f"Normalizing hallucinated argument '{hallucinated_key}' to 'query'")
                        tool_args["query"] = tool_args.pop(hallucinated_key)

            logger.info(f"Executing tool {tool_name} on MCP server with args: {tool_args}")
            tool_result = await active_mcp.call_tool(tool_name, tool_args)
            print(f"\n[MCP RAW OUTPUT]: {tool_result}")
            executor_response += f"\n\n[MCP Execution Result]:\n{tool_result}"
    except Exception as e:
        logger.error(f"Failed to execute tool on MCP: {e}")
        executor_response += f"\n\n[MCP Execution Error]:\n{e}"

    return executor_response


async def _verify_proof_of_work(active_mcp, extracted_json_str: str) -> str:
    """Run Proof of Work verification via MCP. Returns result text or empty string."""
    pow_result = ""
    try:
        if active_mcp and hasattr(active_mcp, '_tool_route_map'):
            print(f"Available tools for verification: {list(active_mcp._tool_route_map.keys())}")

        lower_json = extracted_json_str.lower()
        if "sqlite" in lower_json or "table" in lower_json:
            query_result = await active_mcp.call_tool("list_tables", {})
            pow_result = f"[DB Tables]:\n{query_result}"
        elif any(kw in lower_json for kw in ("pandera", "test", "python", "script", "bot")):
            if active_mcp and hasattr(active_mcp, '_tool_route_map') and "list_allowed_directories" in active_mcp._tool_route_map:
                dir_result = await active_mcp.call_tool("list_allowed_directories", {})
            else:
                dir_result = "No list directory tool available in current MCP."
            pow_result = f"[Dir Listing]:\n{dir_result}"
    except Exception as e:
        pow_result = f"Verification failed: {e}"

    return pow_result
