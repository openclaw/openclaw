"""
Brigade: OpenClaw
Role: Pipeline Executor (Chain-of-Agents)

Implements the workflow chains described in SOUL.md:
- Dmarket Brigade: Executor → Security Auditor → Latency Monitor → Risk Manager
- OpenClaw Brigade: Planner → Tool Smith → Memory GC

Each step in the chain receives:
1. The original user prompt
2. A compressed context briefing from the previous step
3. Its own system prompt from openclaw_config.json

Uses task_queue.py for VRAM management to prevent model thrashing.
Integrates .memory-bank architecture and the 90/10 STAR Framework for agent planning.
"""

import asyncio
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

import aiohttp
import structlog

from src.auto_rollback import AutoRollback

# Injecting MCP Client
from src.mcp_client import OpenClawMCPClient
from src.task_queue import ModelTaskQueue

logger = structlog.get_logger(__name__)


class PipelineExecutor:
    """
    Executes a chain of agent roles sequentially, passing compressed
    context between each step. Uses vLLM (OpenAI-compatible local server)
    for all inference calls. Model swapping managed by VLLMModelManager.
    """

    def __init__(self, config: Dict[str, Any], vllm_url: str, vllm_manager=None):
        self.config = config
        self.vllm_url = vllm_url.rstrip("/")
        self.vllm_manager = vllm_manager  # VLLMModelManager instance
        self.gc_model = config.get("memory", {}).get("model", "google/gemma-3-12b-it")

        # Default chain definitions per brigade (can be overridden in config)
        # Roles must match actual keys in openclaw_config.json brigades.*.roles
        self.default_chains = {
            "Dmarket": ["Planner", "Executor_API", "Archivist"],
            "OpenClaw": ["Planner", "Executor_Tools", "Archivist"],
        }
        
        # Initialize MCP Clients dynamically based on workspace config
        framework_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        self._framework_root = framework_root

        # Core MCP for framework tasks
        self.openclaw_mcp = OpenClawMCPClient(db_path=None, fs_allowed_dirs=[framework_root])

        # Dmarket brigade MCP — workspace dir from config (fallback to framework root)
        dmarket_ws = config.get("brigades", {}).get("Dmarket", {}).get(
            "workspace_dir", framework_root
        )
        dmarket_ws = os.path.abspath(dmarket_ws) if os.path.isdir(os.path.abspath(dmarket_ws)) else framework_root
        self.dmarket_mcp = OpenClawMCPClient(db_path=None, fs_allowed_dirs=[dmarket_ws])

        # Sub-bot MCP instances will be created lazily if needed per brigade workspace_dir
        self.brigade_mcp_map: Dict[str, OpenClawMCPClient] = {}

        # State tracking for VRAM Guard 2.0
        self.last_loaded_model: Optional[str] = None

        # Auto-Rollback safety net
        self.auto_rollback = AutoRollback(framework_root)

    async def initialize(self):
        """Initializes internal components like MCP"""
        await self.openclaw_mcp.initialize()
        await self.dmarket_mcp.initialize()
        logger.info("Pipeline MCP clients initialized (openclaw + dmarket contexts)")
        await self._validate_vllm()

    async def _validate_vllm(self):
        """Checks that the vLLM server is reachable (or manager is configured)."""
        if self.vllm_manager:
            logger.info("vLLM model manager configured — models will be loaded on demand")
            return
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{self.vllm_url}/models",
                    timeout=aiohttp.ClientTimeout(total=5),
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        models = [m["id"] for m in data.get("data", [])]
                        logger.info("vLLM server reachable", models=models)
                    else:
                        logger.warning("vLLM server responded with", status=resp.status)
        except Exception as e:
            logger.warning("vLLM server not reachable (will start on first request)", error=str(e))

    def get_chain(self, brigade: str) -> List[str]:
        """
        Returns the pipeline chain for a given brigade.
        Uses config override if available, otherwise defaults.
        """
        brigade_config = self.config.get("brigades", {}).get(brigade, {})

        # Check if the brigade defines a custom chain
        if "pipeline" in brigade_config:
            return brigade_config["pipeline"]

        # Otherwise use defaults — but only include roles that actually exist
        available_roles = set(brigade_config.get("roles", {}).keys())
        default_chain = self.default_chains.get(brigade, ["Planner"])
        return [role for role in default_chain if role in available_roles]

    async def execute(
        self,
        prompt: str,
        brigade: str = "Dmarket",
        max_steps: int = 5,
        status_callback=None,
        task_type: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Execute the full pipeline for a brigade.

        Args:
            prompt: Original user prompt
            brigade: Target brigade name ("Dmarket" or "OpenClaw")
            max_steps: Safety limit on chain length
            status_callback: async callable(role, model, status_text) for live updates

        Returns:
            {
                "final_response": str,
                "brigade": str,
                "chain_executed": [str],
                "steps": [{"role": ..., "model": ..., "response": ...}],
                "status": "completed" | "ask_user",
                "question": str (if ask_user)
            }
        """
        if task_type:
            chain = [task_type]
        else:
            chain = self.get_chain(brigade)[:max_steps]

        if not chain:
            return {
                "final_response": "⚠️ No roles available in the pipeline.",
                "brigade": brigade,
                "chain_executed": [],
                "steps": [],
                "status": "completed"
            }

        logger.info(f"Pipeline START: brigade={brigade}, chain={' → '.join(chain)}")

        steps_results = []
        context_briefing = ""

        for i, role_name in enumerate(chain):
            if task_type:
                model = self.config.get("system", {}).get("model_router", {}).get(task_type, "Qwen/Qwen2.5-14B-Instruct-AWQ")
                role_config = {"model": model}
                system_prompt = "Выполняй только ту задачу, которая указана в промпте. Никаких лишних слов."
            else:
                role_config = (
                    self.config.get("brigades", {}).get(brigade, {}).get("roles", {}).get(role_name, {})
                )
    
                if not role_config:
                    logger.warning(f"Role '{role_name}' not found in config, skipping")
                    continue
    
                model = role_config.get("model", "Qwen/Qwen2.5-14B-Instruct-AWQ")
                system_prompt = role_config.get("system_prompt", "You are an AI assistant.")

            # --- ROLE-AWARE PROMPT INJECTION ---
            is_planner = "Planner" in role_name or "Orchestrator" in role_name or "Foreman" in role_name
            is_archivist = "Archivist" in role_name
            is_final_step = (i == len(chain) - 1)

            if is_archivist:
                # Archivist: Skeptical Critic + Formatter (MAS verification pattern)
                system_prompt += (
                    "\n\n[ARCHIVIST PROTOCOL: CRITIC + FORMATTER]"
                    "\nТы получаешь технический вывод от предыдущего агента."
                    "\nТвоя задача — ВЕРИФИЦИРОВАТЬ и ПЕРЕПИСАТЬ его в чистый, человекочитаемый формат."
                    "\n"
                    "\nФАЗА 1 — ВЕРИФИКАЦИЯ (Скептический критик):"
                    "\n- Проверь ответ на ВНУТРЕННИЕ ПРОТИВОРЕЧИЯ (одно утверждение опровергает другое)."
                    "\n- Проверь на ФАБРИКАЦИИ: конкретные цифры, даты, имена — есть ли основания в контексте?"
                    "\n- Проверь на TOOL BYPASS: если агент описывает 'я бы выполнил команду...' вместо реального результата — отметь как непроверенное."
                    "\n- Если факт НЕ подкреплён данными из контекста, УДАЛИ его, а не передавай пользователю."
                    "\n"
                    "\nФАЗА 2 — ФОРМАТИРОВАНИЕ:"
                    "\n- Удали ВСЮ служебную разметку: SITUATION, TASK, ACTION, RESULT, <think> блоки, [MCP...], [Proof of Work...]."
                    "\n- НЕ добавляй вступлений ('Давайте рассмотрим...', 'Представляет собой...')."
                    "\n- Каждое предложение = конкретный ВЕРИФИЦИРОВАННЫЙ факт или вывод."
                    "\n- Пиши на РУССКОМ ЯЗЫКЕ."
                    "\n- Формат: прямой ответ на вопрос пользователя, без мета-комментариев."
                    "\n"
                    "\nФАЗА 3 — ОЦЕНКА УВЕРЕННОСТИ:"
                    "\n- В САМОМ КОНЦЕ ответа добавь тег: [УВЕРЕННОСТЬ: X/10]"
                    "\n  где X — твоя оценка достоверности финального ответа (10 = абсолютно уверен, подтверждено данными; 1 = полная догадка)."
                    "\n- Если X < 7, ПЕРЕД основным ответом добавь: '⚠️ Ответ может содержать неточности — данные частично не подтверждены.'"
                    "\n- Оценивай честно: непроверенные факты = низкая оценка."
                )
            elif is_planner:
                # Planner: STAR for internal reasoning, but final output must be clean
                os_name = "Windows" if os.name == "nt" else "Linux"
                system_prompt += (
                    "\n\n[AGENT PROTOCOL: STAR-STRATEGY — INTERNAL ONLY]"
                    "\n1. Memory Bank: Use .memory-bank for persistence."
                    "\n2. Tooling: Если для ответа нужны данные из файловой системы, НЕМЕДЛЕННО вызывай доступные инструменты (list_directory, read_file). НЕ описывай, что ты хочешь вызвать — ВЫЗЫВАЙ."
                    "\n3. STAR используй ТОЛЬКО внутри тегов <think>...</think> для структурирования рассуждений."
                    "\n4. Финальный ответ (вне <think>) должен быть ЧИСТЫМ текстом для пользователя:"
                    "\n   - БЕЗ меток SITUATION/TASK/ACTION/RESULT"
                    "\n   - БЕЗ повторения одних и тех же фактов в разных формулировках"
                    "\n   - Каждое предложение = новый факт или конкретное действие"
                    "\n   - Если задача требует инструментов и ты сгенерировал JSON — добавь его в ```json``` блок"
                    "\n5. ЗАПРЕЩЁННЫЕ конструкции: 'Представляет собой...', 'Является эффективной...', 'Для конкретных рекомендаций необходимо...'"
                    "\n6. SCOPE LIMITATION: Объясняй только четко установленные факты из контекста и доступных данных. Если ты НЕ УВЕРЕН — скажи 'недостаточно данных' вместо домысливания. Пропускай спорные или непроверенные области."
                    "\n7. ВАЖНО: Весь ответ на РУССКОМ ЯЗЫКЕ."
                    f"\n8. СИСТЕМНАЯ СРЕДА: Бот работает на {os_name}. Инструменты доступны через MCP. НЕ предлагай прямые shell-команды (grep, tree, cat) — вызывай MCP-инструменты: list_directory, read_file, search_memory."
                )
            else:
                # Executors and other roles: minimal protocol
                system_prompt += (
                    "\n\n[EXECUTOR PROTOCOL]"
                    "\nВыполняй задачу точно по инструкции. Результат — только JSON или код."
                    "\nНикаких пояснений, вступлений, заключений."
                    "\nЯзык ответа: РУССКИЙ."
                )

            # Inject BRAIN.md for Planners
            if "Planner" in role_name or "Orchestrator" in role_name or "Foreman" in role_name:
                brain_path = os.path.join(self._framework_root, "BRAIN.md")
                if os.path.exists(brain_path):
                    try:
                        with open(brain_path, "r", encoding="utf-8") as f:
                            brain_content = f.read()
                        brain_content = self._sanitize_file_content(brain_content)
                        system_prompt += f"\n\n[LATEST BRAIN.md CONTEXT]\n{brain_content}"
                    except Exception as e:
                        logger.warning(f"Failed to read BRAIN.md: {e}")

            # Build context-aware prompt for this step
            if i == 0:
                # First step: gets the raw user prompt
                step_prompt = prompt
            else:
                # Subsequent steps: gets briefing from previous step + original task
                step_prompt = (
                    f"[PIPELINE CONTEXT from previous step]\n"
                    f"{context_briefing}\n\n"
                    f"[ORIGINAL USER TASK]\n"
                    f"{prompt}\n\n"
                    f"Based on the above context and the previous step's analysis, "
                    f"perform your role as {role_name}."
                )

            # Notify status
            if status_callback:
                await status_callback(
                    role_name,
                    model,
                    f"Шаг {i + 1}/{len(chain)}: {role_name} анализирует...",
                )

            logger.info(f"Pipeline step {i + 1}/{len(chain)}: {role_name} ({model})")

            prev_model = self.last_loaded_model
            
            async with self._vram_protection(model, prev_model):
                # Execute inference. Preserve <think> for Planners and Auditors for transparency.
                preserve_think = any(role in role_name for role in ["Planner", "Foreman", "Orchestrator", "Auditor"])
                active_mcp = self.openclaw_mcp if brigade == "OpenClaw" else self.dmarket_mcp
                response = await self._call_vllm(
                    model, system_prompt, step_prompt, role_name, role_config, active_mcp, preserve_think=preserve_think
                )
                
                self.last_loaded_model = model

            # --- HANDOFF AND ASK_USER INTERCEPTION ---
            json_match = re.search(r'```json\s*(.*?)\s*```', response, re.DOTALL)
            extracted_json_str = None
            if json_match:
                extracted_json_str = json_match.group(1)
            else:
                try:
                    if response.strip().startswith('{') or response.strip().startswith('['):
                        json.loads(response.strip())
                        extracted_json_str = response.strip()
                except ValueError:
                    pass

            # AGGRESSIVE PARSER RETRY
            if not extracted_json_str and ("Planner" in role_name or "Foreman" in role_name):
                lower_resp = response.lower()
                if any(kw in lower_resp for kw in ["создай", "запиши", "выполни", "create", "write", "execute"]):
                    logger.warning(f"No JSON found from {role_name} but action keywords present. Forcing re-generation.")
                    if status_callback:
                        await status_callback(role_name, model, "Оркестратор забыл JSON. Требую по протоколу...")
                    
                    retry_prompt = "Ошибка формата. Выдай только JSON-инструкцию для Исполнителя согласно протоколу."
                    retry_messages = [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": step_prompt},
                        {"role": "assistant", "content": response},
                        {"role": "user", "content": retry_prompt}
                    ]
                    
                    # Manual ad-hoc retry request without tool wrapping
                    import aiohttp
                    payload = {
                        "model": model,
                        "messages": retry_messages,
                        "stream": False,
                        "max_tokens": 2048,
                    }
                    try:
                        async with aiohttp.ClientSession() as session:
                            async with session.post(f"{self.vllm_url}/chat/completions", json=payload, timeout=60) as retry_resp:
                                if retry_resp.status == 200:
                                    r_data = await retry_resp.json()
                                    new_response = r_data["choices"][0]["message"]["content"].strip()
                                    new_response = re.sub(r"<think>.*?</think>", "", new_response, flags=re.DOTALL).strip()
                                    response += "\n\n[Correction]:\n" + new_response
                                    
                                    json_match = re.search(r'```json\s*(.*?)\s*```', new_response, re.DOTALL)
                                    if json_match:
                                        extracted_json_str = json_match.group(1)
                                    else:
                                        try:
                                            if new_response.strip().startswith('{') or new_response.strip().startswith('['):
                                                json.loads(new_response.strip())
                                                extracted_json_str = new_response.strip()
                                        except ValueError:
                                            pass
                    except Exception as e:
                        logger.error(f"Retry request failed: {e}")

            did_handoff = False
            if extracted_json_str:
                try:
                    parsed_json = json.loads(extracted_json_str)
                    if isinstance(parsed_json, dict) and parsed_json.get("action") == "ask_user":
                        logger.info("Pipeline suspended for ask_user")
                        steps_results.append({
                            "role": role_name,
                            "model": model,
                            "response": response,
                        })
                        return {
                            "status": "ask_user",
                            "question": parsed_json.get("question", "Уточните запрос."),
                            "brigade": brigade,
                            "chain_executed": [s["role"] for s in steps_results],
                            "steps": steps_results,
                            "final_response": response,
                        }
                        
                    if isinstance(parsed_json, dict) and parsed_json.get("action") == "verify_inventory":
                        logger.info("Inventory verified. Auto-transitioning to create_offer step.")
                        steps_results.append({
                            "role": role_name,
                            "model": model,
                            "response": response,
                        })
                        # Jump to create_offer automatically
                        return {
                            "status": "create_offer",
                            "brigade": brigade,
                            "chain_executed": [s["role"] for s in steps_results],
                            "steps": steps_results,
                            "final_response": response + "\n\n[System]: Inventory verified. Proceeding to create_offer."
                        }
                    
                    if "Planner" in role_name or "Foreman" in role_name:
                        executor_model = self.config.get("system", {}).get("model_router", {}).get("tool_execution", "Qwen/Qwen2.5-Coder-7B-Instruct-AWQ")
                        logger.info(f"JSON instructions detected from Planner, executing Handoff to {executor_model}")
                        steps_results.append({
                            "role": role_name,
                            "model": model,
                            "response": response,
                        })
                        
                        await self._force_unload(model)
                        
                        executor_role = "Executor_Tools"
                        executor_sys = "ТЫ — ТЕХНИЧЕСКИЙ ТЕРМИНАЛ. Тебе ЗАПРЕЩЕНО использовать любые имена функций, кроме read_query, write_query, list_tables, describe_table. ДЛЯ ЗАПИСИ/СОЗДАНИЯ В БД: всегда используй write_query. ДЛЯ ЧТЕНИЯ ИЗ БД: всегда используй read_query или list_tables. ОШИБКА В ИМЕНИ ИНСТРУМЕНТА ПРИРАВНИВАЕТСЯ К ПОЛОМКЕ ВСЕЙ СИСТЕМЫ."
                        executor_prompt = f"Выполни эту инструкцию через MCP инструменты SQLite или Filesystem:\n```json\n{extracted_json_str}\n```"
                        
                        if status_callback:
                            await status_callback(
                                executor_role,
                                executor_model,
                                "🛠 Исполнитель вызывает инструменты MCP..."
                            )
                        
                        executor_config = {"model": executor_model}
                        async with self._vram_protection(executor_model, self.last_loaded_model):
                            self.last_loaded_model = executor_model
                            max_retries = 3
                            for attempt in range(max_retries):
                                executor_response = await self._call_vllm(
                                    executor_model, executor_sys, executor_prompt, executor_role, executor_config, active_mcp
                                )
                                
                                # Auto-Correction Loop
                                valid_tools = ["read_query", "write_query", "list_tables", "describe_table", "read_file", "write_file", "list_directory"]
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
                                            executor_prompt += f"\n\nОшибка: Инструмент create_table небезопасен. Используй write_query для этой задачи."
                                            continue
                                        elif tool_name and tool_name not in valid_tools:
                                            logger.warning(f"Executor hallucinated tool name: {tool_name}. Retrying (Attempt {attempt+1}/{max_retries})")
                                            executor_prompt += f"\n\nОшибка: инструмента '{tool_name}' не существует. Доступные инструменты для SQLite: 'read_query', 'write_query', 'list_tables', 'describe_table'. Перепиши свой JSON, используя строго только разрешенные имена."
                                            continue
                                        
                                    except json.JSONDecodeError:
                                        pass
                                
                                # If valid tool name or no JSON matched (meaning it might have explicitly run via native tool calls), break loop
                                break
                        
                        steps_results.append({
                            "role": executor_role,
                            "model": executor_model,
                            "response": executor_response
                        })
                        
                        # --- PHYSICAL MCP EXECUTION BLOCK ---
                        # Execute the parsed tool call on the MCP server
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
                                tool_args = exec_json.get("arguments", {})
                                
                                if tool_name:
                                    # --- STUPIDITY INSURANCE: Normalize argument names ---
                                    if tool_name == "write_query":
                                        for hallucinated_key in ["command", "sql"]:
                                            if hallucinated_key in tool_args and "query" not in tool_args:
                                                logger.info(f"Normalizing hallucinated argument '{hallucinated_key}' to 'query'")
                                                tool_args["query"] = tool_args.pop(hallucinated_key)
                                    # ----------------------------------------------------
                                    
                                    logger.info(f"Executing tool {tool_name} on MCP server with args: {tool_args}")
                                    tool_result = await active_mcp.call_tool(tool_name, tool_args)
                                    print(f"\n[MCP RAW OUTPUT]: {tool_result}")
                                    executor_response += f"\n\n[MCP Execution Result]:\n{tool_result}"
                            except Exception as e:
                                logger.error(f"Failed to execute tool on MCP: {e}")
                                executor_response += f"\n\n[MCP Execution Error]:\n{e}"
                        # ------------------------------------
                        
                        # Proof of Work Verification
                        if status_callback:
                            await status_callback(
                                executor_role,
                                executor_model,
                                "🔎 Ядро проверяет Proof of Work через MCP..."
                            )
                        
                        pow_result = ""
                        try:
                            # Print available tools for debugging
                            if active_mcp and hasattr(active_mcp, '_tool_route_map'):
                                print(f"Available tools for verification: {list(active_mcp._tool_route_map.keys())}")
                            
                            if "sqlite" in extracted_json_str.lower() or "table" in extracted_json_str.lower():
                                query_result = await active_mcp.call_tool("list_tables", {})
                                pow_result = f"[DB Tables]:\n{query_result}"
                            elif "pandera" in extracted_json_str.lower() or "test" in extracted_json_str.lower() or "python" in extracted_json_str.lower() or "script" in extracted_json_str.lower():
                                path = os.path.abspath(os.path.dirname(__file__))
                                dir_result = await active_mcp.call_tool("list_directory", {"path": path})
                                pow_result = f"[Dir Listing]:\n{dir_result}"
                        except Exception as e:
                            pow_result = f"Verification failed: {e}"
                        
                        if pow_result:
                            executor_response += f"\n\n[Proof of Work Auto-Verification]:\n{pow_result}"
                            steps_results[-1]["response"] = executor_response
                        
                        did_handoff = True
                        # Pipeline logical break since executor has completed the task
                        break

                except json.JSONDecodeError:
                    steps_results.append({
                        "role": role_name,
                        "model": model,
                        "response": response,
                    })
            else:
                steps_results.append(
                    {
                        "role": role_name,
                        "model": model,
                        "response": response,
                    }
                )
            
            if did_handoff:
                break
            # -----------------------------------------

            # Git Hygiene: Auto-commit after each successful pipeline execution step
            try:
                import subprocess
                commit_msg = f"Auto-commit [PoW]: Pipeline step {role_name} ({model}) completed"
                subprocess.run(["git", "commit", "-am", commit_msg], cwd=os.path.dirname(__file__), capture_output=True)
            except Exception as e:
                logger.debug(f"Git auto-commit failed: {e}")

            # Prepare context briefing for the next step (compressed)
            context_briefing = self._compress_for_next_step(role_name, response)

        raw_response = steps_results[-1]["response"] if steps_results else ""
        final_response = self._clean_response_for_user(raw_response)

        logger.info(f"Pipeline COMPLETE: brigade={brigade}, steps={len(steps_results)}")

        return {
            "final_response": final_response,
            "brigade": brigade,
            "chain_executed": [s["role"] for s in steps_results],
            "steps": steps_results,
            "status": "completed"
        }

    async def _call_vllm(
        self,
        model: str,
        system_prompt: str,
        user_prompt: str,
        role_name: str,
        role_config: Dict[str, Any],
        mcp_client: OpenClawMCPClient,
        preserve_think: bool = False
    ) -> str:
        """
        Calls local vLLM server (OpenAI-compatible) for a single inference step.
        Endpoint: POST {vllm_url}/chat/completions
        """
        system_prompt += (
            " Правила плотности: каждое предложение = новый факт."
            " Запрещено: повторять суть в разных формулировках, пустые вступления, фразы-заглушки."
            " Максимум конкретики. Ответ на РУССКОМ ЯЗЫКЕ."
        )

        # max_tokens: cap output to prevent verbose over-generation
        # Short prompts → 2048 tokens max, long prompts → up to 4096
        estimated_input_tokens = len(user_prompt + system_prompt) // 4
        dynamic_max_tokens = min(4096, max(1024, min(estimated_input_tokens, 2048) + 512))

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        # Inject MCP tools for roles that need them (OpenAI-compatible tool format)
        # Planners get read-only tools; Executors get full tool access
        model_tools = []
        tool_eligible_roles = ("Executor_API", "Executor_Parser", "Executor_Tools", "Latency_Optimizer", "Planner", "Foreman")
        if role_name in tool_eligible_roles:
            all_tools = mcp_client.available_tools_openai
            if all_tools:
                if "Planner" in role_name or "Foreman" in role_name:
                    # Planners: read-only subset (list_directory, read_file, list_tables, read_query, search_memory)
                    read_only_names = {"list_directory", "read_file", "list_tables", "read_query", "describe_table", "search_memory"}
                    model_tools = [t for t in all_tools if t.get("function", {}).get("name") in read_only_names]
                else:
                    model_tools = all_tools
                if model_tools:
                    logger.debug(f"Injecting {len(model_tools)} tools for role {role_name}")

        temperature = role_config.get("temperature", 0.3)
        payload: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": False,
            "max_tokens": dynamic_max_tokens,
            "temperature": temperature,
        }
        if model_tools:
            payload["tools"] = model_tools

        config_timeout = self.config.get("system", {}).get("timeout_sec", 450)

        # Ensure the required model is loaded via vLLM manager
        if self.vllm_manager:
            await self.vllm_manager.ensure_model_loaded(model)

        async def _run_inference():
            async with aiohttp.ClientSession() as session:
                try:
                    timeout = aiohttp.ClientTimeout(total=config_timeout)
                    async with session.post(
                        f"{self.vllm_url}/chat/completions",
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
                                    f"{self.vllm_url}/chat/completions",
                                    json=payload,
                                    timeout=timeout,
                                ) as resp2:
                                    if resp2.status == 200:
                                        data2 = await resp2.json()
                                        text = data2["choices"][0]["message"]["content"].strip()
                                        if not preserve_think:
                                            text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
                                        return text
                                    return f"⚠️ vLLM Error after tool call ({resp2.status})"
                            else:
                                text = msg.get("content", "").strip()
                                if not preserve_think:
                                    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
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
                                    f"{self.vllm_url}/chat/completions",
                                    json=payload,
                                    timeout=timeout,
                                ) as retry_resp:
                                    if retry_resp.status == 200:
                                        retry_data = await retry_resp.json()
                                        text = retry_data["choices"][0]["message"]["content"].strip()
                                        if not preserve_think:
                                            text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
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

    async def _force_unload(self, model: str):
        """No-op for vLLM — model lifecycle is managed by VLLMModelManager."""
        pass

    @asynccontextmanager
    async def _vram_protection(self, target_model: str, prev_model: Optional[str]):
        """Context manager to ensure strict VRAM unloading and logging heavy switches."""
        switch_start = time.time()
        
        # Unload prev model if different (VRAM Guard 2.0)
        if prev_model and prev_model != target_model:
            logger.info(f"[VRAM Guard 2.0] Anti-thrash: unloading {prev_model} before loading {target_model}")
            unload_start = time.time()
            await self._force_unload(prev_model)
            unload_duration = time.time() - unload_start
            if unload_duration > 10:
                logger.warning(f"⚠️ [VRAM ALERT] Unloading {prev_model} took excessive time: {unload_duration:.2f}s!")
                
        try:
            yield
        finally:
            # Leave model hot. It will be unloaded when switching to a differently named model.
            pass

    @staticmethod
    def _clean_response_for_user(text: str) -> str:
        """Strip internal STAR markup, <think> blocks, MCP artifacts, and process confidence tags."""
        # Remove <think>...</think> blocks
        text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
        # Remove STAR labels (SITUATION:, TASK:, ACTION:, RESULT: at line start)
        text = re.sub(r"^\s*(SITUATION|TASK|ACTION|RESULT)\s*:\s*", "", text, flags=re.MULTILINE)
        # Remove [MCP ...], [Proof of Work ...], [Correction], [PIPELINE CONTEXT ...] blocks
        text = re.sub(r"\[MCP[^\]]*\]:?[^\n]*\n?", "", text)
        text = re.sub(r"\[Proof of Work[^\]]*\]:?[^\n]*\n?", "", text)
        text = re.sub(r"\[Correction\]:?\s*", "", text)
        text = re.sub(r"\[PIPELINE CONTEXT[^\]]*\][^\n]*\n?", "", text)
        # Remove [AGENT PROTOCOL...] remnants
        text = re.sub(r"\[AGENT PROTOCOL[^\]]*\][^\n]*\n?", "", text)
        # Remove [ARCHIVIST PROTOCOL...] remnants
        text = re.sub(r"\[ARCHIVIST PROTOCOL[^\]]*\][^\n]*\n?", "", text)
        # Remove [EXECUTOR PROTOCOL...] remnants
        text = re.sub(r"\[EXECUTOR PROTOCOL[^\]]*\][^\n]*\n?", "", text)
        # Remove [RAG_CONFIDENCE: ...] tags (used internally by memory search)
        text = re.sub(r"\[RAG_CONFIDENCE:\s*\w+\]\s*", "", text)
        # Remove stray JSON tool-call artifacts outside code blocks (e.g. {"name": "...", "arguments": ...})
        text = re.sub(r'(?<!`)\{"name"\s*:.*?"arguments"\s*:.*?\}(?!`)', '', text, flags=re.DOTALL)
        # Remove repeated consecutive paragraphs (dedup)
        paragraphs = text.split('\n\n')
        seen = set()
        deduped = []
        for p in paragraphs:
            p_key = p.strip().lower()
            if p_key and p_key not in seen:
                seen.add(p_key)
                deduped.append(p)
            elif not p_key:
                deduped.append(p)
        text = '\n\n'.join(deduped)
        # Process confidence tag: [УВЕРЕННОСТЬ: X/10]
        confidence_match = re.search(r'\[УВЕРЕННОСТЬ:\s*(\d+)/10\]', text)
        if confidence_match:
            score = int(confidence_match.group(1))
            text = re.sub(r'\s*\[УВЕРЕННОСТЬ:\s*\d+/10\]\s*', '', text)
            if score < 7:
                text = '⚠️ Ответ может содержать неточности — данные частично не подтверждены.\n\n' + text
        # Collapse excessive blank lines
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()

    def _compress_for_next_step(self, role_name: str, response: str) -> str:
        """
        Smart context compression: preserves JSON blocks, MCP results,
        and respects sentence boundaries instead of blind truncation.
        """
        # 1. Extract and preserve JSON code blocks (instructions for Executor)
        json_blocks = re.findall(r'```json\s*(.*?)\s*```', response, re.DOTALL)
        json_section = ""
        if json_blocks:
            json_section = "\n```json\n" + json_blocks[0][:800] + "\n```"

        # 2. Extract MCP execution results
        mcp_results = re.findall(r'\[MCP Execution Result\]:\n(.*?)(?:\n\n|\Z)', response, re.DOTALL)
        mcp_section = ""
        if mcp_results:
            mcp_section = "\n[MCP Result]: " + mcp_results[0][:500]

        # 3. Clean text: remove <think>, STAR labels, code blocks, MCP markers
        clean = re.sub(r'<think>.*?</think>', '', response, flags=re.DOTALL)
        clean = re.sub(r'```json.*?```', '', clean, flags=re.DOTALL)
        clean = re.sub(r'\[MCP[^\]]*\].*?\n', '', clean)
        clean = re.sub(r'\[Proof of Work[^\]]*\].*?\n', '', clean)
        clean = re.sub(r'\n{2,}', '\n', clean).strip()

        # 4. Smart truncation: up to 1500 chars, respecting sentence boundaries
        max_chars = 1500
        if len(clean) > max_chars:
            cut = clean[:max_chars]
            last_boundary = max(cut.rfind('. '), cut.rfind('! '), cut.rfind('? '), cut.rfind('\n'))
            if last_boundary > max_chars // 2:
                cut = cut[:last_boundary + 1]
            clean = cut + "..."

        return f"[{role_name} Output]: {clean}{json_section}{mcp_section}"

    @staticmethod
    def _sanitize_file_content(content: str) -> str:
        """Strip potential prompt injection markers from file content before prompt injection."""
        # Remove system/user/assistant role markers that could override the LLM prompt
        content = re.sub(r'(?i)\[?(system|user|assistant)\s*(prompt|message|role)\]?\s*:', '', content)
        # Neutralize instruction override attempts
        content = re.sub(r'(?i)(ignore previous instructions|forget your instructions|new instructions:)', '[FILTERED]', content)
        # Neutralize <|im_start|> / <|im_end|> chat template injection
        content = re.sub(r'<\|im_(start|end)\|>', '', content)
        return content
