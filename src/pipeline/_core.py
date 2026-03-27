"""
Brigade: OpenClaw
Role: Pipeline Executor (Chain-of-Agents) — Core

Implements the workflow chains described in SOUL.md.
Delegates state management to _state.py, reflexion to _reflexion.py,
and tool execution to _tools_handler.py.
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
from src.mcp_client import OpenClawMCPClient
from src.task_queue import ModelTaskQueue
from src.ai.inference.metrics import InferenceMetricsCollector
from src.ai.inference.budget import AdaptiveTokenBudget
from src.ai.inference.router import SmartModelRouter
from src.ai.inference._shared import ModelProfile, RoutingTask

from src.pipeline_schemas import (
    GUARDRAIL_MAX_RETRIES,
    ROLE_GUARDRAILS,
    ROLE_SCHEMAS,
    ROLE_TOKEN_BUDGET,
    TOOL_ELIGIBLE_ROLES,
    PipelineStepResult,
    PipelineResult,
)
from src.pipeline_utils import (
    build_role_prompt,
    clean_response_for_user,
    compress_for_next_step,
    emergency_compress,
    group_chain,
    sanitize_file_content,
)
from src.code_validator import CodeValidator
from src.context_bridge import ContextBridge
from src.vllm_inference import (
    call_vllm,
    execute_stream,
    force_unload,
    vram_protection,
)
from src.openrouter_client import call_openrouter, reset_circuit_breakers
from src.ai.agents.react import ReActReasoner
from src.ai.agents.constitutional import ConstitutionalChecker
from src.tools.dynamic_sandbox import DynamicSandbox

from src.pipeline._state import init_smart_router, init_supermemory, recall_memory_context
from src.pipeline._reflexion import reflexion_fallback
from src.pipeline._tools_handler import handle_planner_handoff

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
        self.vllm_manager = vllm_manager
        self.gc_model = config.get("memory", {}).get("model", "google/gemma-3-12b-it")

        # OpenRouter configuration (primary inference)
        self.openrouter_config = config.get("system", {}).get("openrouter", {})
        self.openrouter_enabled = self.openrouter_config.get("enabled", False) and bool(self.openrouter_config.get("api_key", ""))
        self._use_local_models = self.openrouter_config.get("use_local_models", True)
        self.force_cloud = (
            self.openrouter_enabled
            and self.openrouter_config.get("force_cloud", False)
            and not self._use_local_models
        )

        self.default_chains = {
            "Dmarket-Dev": ["Planner", "Coder", "Auditor"],
            "OpenClaw-Core": ["Planner", "Foreman", "Executor_Tools", "Executor_Architect", "Auditor", "State_Manager", "Archivist"],
            "Research-Ops": ["Researcher", "Analyst", "Summarizer"],
        }

        self._ctx_budget = self.config.get("system", {}).get("vllm_max_model_len", 16384)

        # Initialize MCP Clients dynamically
        framework_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        self._framework_root = framework_root
        self.openclaw_mcp = OpenClawMCPClient(db_path=None, fs_allowed_dirs=[framework_root])

        dmarket_ws = config.get("brigades", {}).get("Dmarket", {}).get("workspace_dir", framework_root)
        dmarket_ws = os.path.abspath(dmarket_ws) if os.path.isdir(os.path.abspath(dmarket_ws)) else framework_root
        self.dmarket_mcp = OpenClawMCPClient(db_path=None, fs_allowed_dirs=[dmarket_ws])
        self.brigade_mcp_map: Dict[str, OpenClawMCPClient] = {}

        self.last_loaded_model: Optional[str] = None
        self.auto_rollback = AutoRollback(framework_root)
        self.code_validator = CodeValidator(framework_root, config)

        # Reuse shared singletons from llm_gateway
        from src.llm_gateway import get_metrics_collector, get_token_budget
        self.metrics_collector = get_metrics_collector() or InferenceMetricsCollector()
        vram_gb = config.get("system", {}).get("hardware", {}).get("vram_gb", 16.0)
        self.token_budget = get_token_budget() or AdaptiveTokenBudget(
            default_max_tokens=config.get("system", {}).get("vllm_max_model_len", 8192),
            vram_gb=vram_gb,
        )
        logger.info("InferenceMetrics + AdaptiveTokenBudget activated (shared)")

        self._supermemory = None
        self._rag_engine = None

        # SmartModelRouter (delegated to _state.py)
        self._smart_router = init_smart_router(config, self.force_cloud)

        # Context Bridge
        if self.force_cloud:
            self.context_bridge = ContextBridge({"context_bridge": {"enabled": False}})
            logger.info("Context Bridge DISABLED (cloud-only mode, no local model swaps)")
        else:
            self.context_bridge = ContextBridge(config.get("system", {}))

        self._react_reasoner = ReActReasoner(vllm_url=self.vllm_url, model="")
        self._constitutional = ConstitutionalChecker(vllm_url=self.vllm_url, model="")
        self._sandbox = DynamicSandbox()

    def _init_supermemory(self) -> None:
        init_supermemory(self)

    async def _recall_memory_context(self, prompt: str) -> str:
        return await recall_memory_context(self, prompt)

    async def _reflexion_fallback(self, prompt: str, error_response: str) -> Optional[str]:
        return await reflexion_fallback(self.vllm_url, self.config, prompt, error_response)

    async def initialize(self):
        """Initializes internal components like MCP.
        MCP failures are non-fatal — pipeline proceeds with reduced capabilities."""
        try:
            await self.openclaw_mcp.initialize()
        except Exception as e:
            logger.warning("OpenClaw MCP init failed (non-fatal)", error=str(e))
        try:
            await self.dmarket_mcp.initialize()
        except Exception as e:
            logger.warning("Dmarket MCP init failed (non-fatal)", error=str(e))
        logger.info("Pipeline MCP clients initialized (openclaw + dmarket contexts)")

        self._init_supermemory()

        if not self.force_cloud:
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
        brigade_config = self.config.get("brigades", {}).get(brigade, {})
        if "pipeline" in brigade_config:
            return brigade_config["pipeline"]
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
        """Execute the full pipeline for a brigade."""
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

        # Reset per-model circuit breakers at the start of each pipeline run
        # so stale failures from previous runs don't poison fresh queries.
        reset_circuit_breakers()

        budget = self.token_budget.estimate_budget(prompt, task_type or "general")
        logger.info("Token budget estimated", max_tokens=budget.max_tokens, reason=budget.budget_reason)

        memory_context = await self._recall_memory_context(prompt)

        chain_groups = group_chain(chain)
        steps_results = []
        context_briefing = memory_context
        step_index = 0

        for group in chain_groups:
            is_parallel = len(group) > 1

            if is_parallel:
                logger.info(f"Parallel executor batch: {group}")
                tasks = []
                for role_name in group:
                    tasks.append(self._run_single_step(
                        role_name=role_name, step_index=step_index, chain_len=len(chain),
                        brigade=brigade, prompt=prompt, context_briefing=context_briefing,
                        status_callback=status_callback, task_type=task_type,
                    ))
                    step_index += 1
                parallel_results = await asyncio.gather(*tasks, return_exceptions=True)
                for role_name, res in zip(group, parallel_results):
                    if isinstance(res, Exception):
                        logger.error(f"Parallel step {role_name} failed: {res}")
                        response = f"⚠️ {role_name} failed: {res}"
                    else:
                        response = res
                    steps_results.append({"role": role_name, "model": "parallel", "response": response})
                merged = "\n\n".join(
                    f"[{r['role']}]: {compress_for_next_step(r['role'], r['response'])}"
                    for r in steps_results if r['role'] in group
                )
                context_briefing = merged
                continue

            role_name = group[0]
            if task_type:
                model = self.config.get("system", {}).get("model_router", {}).get(task_type, "meta-llama/llama-3.3-70b-instruct:free")
                role_config = {"model": model}
                system_prompt = build_role_prompt(role_name, role_config, self._framework_root, task_type=task_type)
            else:
                role_config = (
                    self.config.get("brigades", {}).get(brigade, {}).get("roles", {}).get(role_name, {})
                )
                if not role_config:
                    logger.warning(f"Role '{role_name}' not found in config, skipping")
                    continue
                model = role_config.get("model", "meta-llama/llama-3.3-70b-instruct:free")
                system_prompt = build_role_prompt(role_name, role_config, self._framework_root)

            is_final_step = (step_index == len(chain) - 1)

            if step_index == 0:
                step_prompt = prompt
            else:
                step_prompt = (
                    f"[PIPELINE CONTEXT from previous step]\n"
                    f"{context_briefing}\n\n"
                    f"[ORIGINAL USER TASK]\n"
                    f"{prompt}\n\n"
                    f"Based on the above context and the previous step's analysis, "
                    f"perform your role as {role_name}."
                )

            total_input_chars = len(system_prompt) + len(step_prompt)
            estimated_tokens = total_input_chars // 4
            ctx_threshold = int(self._ctx_budget * 0.75)
            if estimated_tokens > ctx_threshold:
                logger.warning(f"Context overflow for {role_name}: ~{estimated_tokens} tokens > {ctx_threshold} threshold. Compressing.")
                step_prompt = emergency_compress(step_prompt, ctx_threshold, role_name)

            display_model = self._display_model(role_config, model)
            if status_callback:
                await status_callback(
                    role_name, display_model,
                    f"Шаг {step_index + 1}/{len(chain)}: {role_name} анализирует...",
                )

            logger.info(f"Pipeline step {step_index + 1}/{len(chain)}: {role_name} ({display_model})")

            prev_model = self.last_loaded_model

            if not self.force_cloud:
                if (prev_model and prev_model != model
                        and self.context_bridge.enabled and self.vllm_manager):
                    import uuid
                    _pipeline_id = str(uuid.uuid4())
                    _snapshot = self.context_bridge.build_handoff_summary(
                        pipeline_id=_pipeline_id, brigade=brigade, chain_position=step_index,
                        source_model=prev_model, target_model=model,
                        steps_results=steps_results, accumulated_context=context_briefing,
                    )
                    self.context_bridge.save_before_swap(_snapshot)
                    logger.info("Context Bridge: snapshot saved before model swap",
                                pipeline_id=_pipeline_id, source=prev_model, target=model)
                    _restored = self.context_bridge.restore_after_swap(_pipeline_id)
                    if _restored:
                        context_briefing = _restored
                        logger.info("Context Bridge: context restored for new model")

            did_handoff = False

            async with self._vram_protection(model, prev_model):
                preserve_think = any(role in role_name for role in ["Planner", "Foreman", "Orchestrator", "Auditor"])
                active_mcp = self.openclaw_mcp if brigade == "OpenClaw" else self.dmarket_mcp
                role_schema = ROLE_SCHEMAS.get(role_name) if not task_type else None

                response = await self._call_vllm(
                    model, system_prompt, step_prompt, role_name, role_config, active_mcp,
                    preserve_think=preserve_think, json_schema=role_schema
                )

                # --- GUARDRAIL VALIDATION WITH RETRY ---
                guardrail_fn = ROLE_GUARDRAILS.get(role_name)
                if guardrail_fn and not task_type:
                    for retry_i in range(GUARDRAIL_MAX_RETRIES):
                        is_valid, feedback = guardrail_fn(response)
                        if is_valid:
                            break
                        logger.warning(f"Guardrail failed for {role_name} (attempt {retry_i + 1}/{GUARDRAIL_MAX_RETRIES}): {feedback}")
                        if status_callback:
                            await status_callback(role_name, display_model, f"🔄 Гарантия качества: повтор {retry_i + 1} — {feedback[:60]}")
                        retry_prompt = f"{step_prompt}\n\n[GUARDRAIL FEEDBACK — исправь ответ]:\n{feedback}"
                        response = await self._call_vllm(
                            model, system_prompt, retry_prompt, role_name, role_config, active_mcp,
                            preserve_think=preserve_think, json_schema=role_schema
                        )

                # --- CODE STATIC ANALYSIS (Executor roles only) ---
                _validator_cfg = self.config.get("code_validator", {})
                if _validator_cfg.get("enabled", True) and role_name.startswith("Executor_") and not task_type:
                    try:
                        _cv_reports = await self.code_validator.validate_response(response)
                        _cv_fix_prompt = self.code_validator.build_fix_prompt(_cv_reports) if _cv_reports else ""
                        if _cv_fix_prompt:
                            _issues_count = sum(len(r.issues) for r in _cv_reports)
                            logger.warning(f"Code validation found {_issues_count} issues in {role_name} — auto-fix pass")
                            if status_callback:
                                await status_callback(role_name, display_model, f"🔍 Статический анализ: {_issues_count} проблем — исправляю...")
                            _cv_retry_prompt = f"{step_prompt}\n\n{_cv_fix_prompt}"
                            response = await self._call_vllm(
                                model, system_prompt, _cv_retry_prompt, role_name, role_config,
                                active_mcp, preserve_think=preserve_think, json_schema=role_schema,
                            )
                    except Exception as _cv_err:
                        logger.warning(f"CodeValidator error (skipping): {_cv_err}")

                self.last_loaded_model = model

            # --- HANDOFF AND ASK_USER INTERCEPTION ---
            json_match = re.search(r'```json\s*(.*?)\s*```', response, re.DOTALL)
            extracted_json_str = None
            if json_match:
                extracted_json_str = json_match.group(1)
            else:
                try:
                    _resp_stripped = (response or "").strip()
                    if _resp_stripped.startswith('{') or _resp_stripped.startswith('['):
                        json.loads(_resp_stripped)
                        extracted_json_str = _resp_stripped
                except (json.JSONDecodeError, AttributeError):
                    pass

            # AGGRESSIVE PARSER RETRY
            if not extracted_json_str and ("Planner" in role_name or "Foreman" in role_name):
                lower_resp = response.lower()
                if any(kw in lower_resp for kw in ["создай", "запиши", "выполни", "create", "write", "execute"]):
                    logger.warning(f"No JSON found from {role_name} but action keywords present. Forcing re-generation.")
                    if status_callback:
                        await status_callback(role_name, display_model, "Оркестратор забыл JSON. Требую по протоколу...")

                    retry_prompt = "Ошибка формата. Выдай только JSON-инструкцию для Исполнителя согласно протоколу."
                    retry_messages = [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": step_prompt},
                        {"role": "assistant", "content": response},
                        {"role": "user", "content": retry_prompt}
                    ]
                    try:
                        if self.force_cloud:
                            new_response = await call_openrouter(
                                system_prompt=system_prompt,
                                user_prompt=step_prompt + "\n\n" + retry_prompt,
                                role_name=role_name,
                                role_config=role_config,
                                config=self.config,
                            )
                        else:
                            _payload = {
                                "model": model,
                                "messages": retry_messages,
                                "stream": False,
                                "max_tokens": 2048,
                            }
                            async with aiohttp.ClientSession() as _sess:
                                async with _sess.post(f"{self.vllm_url}/chat/completions", json=_payload, timeout=aiohttp.ClientTimeout(total=60)) as retry_resp:
                                    if retry_resp.status == 200:
                                        r_data = await retry_resp.json()
                                        _raw = r_data.get("choices", [{}])[0].get("message", {}).get("content") or ""
                                        new_response = _raw.strip()
                                    else:
                                        new_response = ""
                        new_response = re.sub(r"<think>.*?</think>", "", (new_response or ""), flags=re.DOTALL).strip()
                        if new_response:
                            response += "\n\n[Correction]:\n" + new_response
                            json_match = re.search(r'```json\s*(.*?)\s*```', new_response, re.DOTALL)
                            if json_match:
                                extracted_json_str = json_match.group(1)
                            else:
                                try:
                                    if new_response.strip().startswith('{') or new_response.strip().startswith('['):
                                        json.loads(new_response.strip())
                                        extracted_json_str = new_response.strip()
                                except json.JSONDecodeError:
                                    pass
                    except Exception as e:
                        logger.error(f"Retry request failed: {e}")

            if extracted_json_str:
                try:
                    parsed_json = json.loads(extracted_json_str)
                    if isinstance(parsed_json, dict) and parsed_json.get("action") == "ask_user":
                        logger.info("Pipeline suspended for ask_user")
                        steps_results.append({"role": role_name, "model": model, "response": response})
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
                        steps_results.append({"role": role_name, "model": model, "response": response})
                        return {
                            "status": "create_offer",
                            "brigade": brigade,
                            "chain_executed": [s["role"] for s in steps_results],
                            "steps": steps_results,
                            "final_response": response + "\n\n[System]: Inventory verified. Proceeding to create_offer."
                        }

                    if "Planner" in role_name or "Foreman" in role_name:
                        did_handoff = await handle_planner_handoff(
                            self, extracted_json_str, role_name, model, brigade,
                            active_mcp, status_callback, steps_results, response,
                        )
                        if did_handoff:
                            break

                except json.JSONDecodeError:
                    steps_results.append({"role": role_name, "model": model, "response": response})
            else:
                steps_results.append({"role": role_name, "model": model, "response": response})

            if did_handoff:
                break

            if status_callback and not is_final_step:
                step_preview = response[:120].replace('\n', ' ').strip()
                await status_callback(
                    role_name, display_model,
                    f"✅ Шаг {step_index + 1}/{len(chain)} ({role_name}) завершён. Передаю контекст дальше..."
                )

            try:
                import subprocess
                commit_msg = f"Auto-commit [PoW]: Pipeline step {role_name} ({model}) completed"
                subprocess.run(["git", "commit", "-am", commit_msg], cwd=os.path.dirname(__file__), capture_output=True)
            except Exception as e:
                logger.debug(f"Git auto-commit failed: {e}")

            context_briefing = compress_for_next_step(role_name, response)
            step_index += 1

        raw_response = steps_results[-1]["response"] if steps_results else ""
        final_response = clean_response_for_user(raw_response)

        if not final_response or final_response.startswith("⚠️"):
            logger.warning("Pipeline produced empty/error response, attempting Reflexion fallback")
            reflexion_answer = await self._reflexion_fallback(prompt, raw_response)
            if reflexion_answer:
                final_response = reflexion_answer
                steps_results.append({"role": "Reflexion_Fallback", "model": "reflexion", "response": reflexion_answer})

        if final_response and not final_response.startswith("⚠️"):
            try:
                const_result = await self._constitutional.check(prompt, final_response)
                if not const_result.safe and const_result.revised_response:
                    logger.warning("Constitutional check triggered revision", violations=const_result.violations)
                    final_response = const_result.revised_response
                    steps_results.append({"role": "Constitutional_Guard", "model": "constitutional", "response": final_response})
            except Exception as e:
                logger.warning("Constitutional check failed (non-fatal)", error=str(e))

        logger.info(f"Pipeline COMPLETE: brigade={brigade}, steps={len(steps_results)}")

        try:
            validated = PipelineResult(
                final_response=final_response,
                brigade=brigade,
                chain_executed=[s["role"] for s in steps_results],
                steps=[PipelineStepResult(**s) for s in steps_results],
                status="completed",
            )
            return validated.model_dump()
        except Exception as val_err:
            logger.warning("Pipeline result validation failed (returning raw)", error=str(val_err))
            return {
                "final_response": final_response,
                "brigade": brigade,
                "chain_executed": [s["role"] for s in steps_results],
                "steps": steps_results,
                "status": "completed",
            }

    async def _run_single_step(self, role_name, step_index, chain_len, brigade, prompt, context_briefing, status_callback=None, task_type=None) -> str:
        """Run a single pipeline step (used for parallel Executor dispatch)."""
        role_config = self.config.get("brigades", {}).get(brigade, {}).get("roles", {}).get(role_name, {})
        if not role_config:
            return f"⚠️ Role '{role_name}' not found in config."
        model = role_config.get("model", "meta-llama/llama-3.3-70b-instruct:free")
        display_model = self._display_model(role_config, model)
        system_prompt = build_role_prompt(role_name, role_config, self._framework_root)
        step_prompt = (
            f"[PIPELINE CONTEXT from previous step]\n{context_briefing}\n\n"
            f"[ORIGINAL USER TASK]\n{prompt}\n\n"
            f"Based on the above context, perform your role as {role_name}."
        )
        if status_callback:
            await status_callback(role_name, display_model, f"⚡ Параллельно: {role_name} работает...")
        active_mcp = self.openclaw_mcp if brigade == "OpenClaw" else self.dmarket_mcp
        return await self._call_vllm(model, system_prompt, step_prompt, role_name, role_config, active_mcp)

    def _display_model(self, role_config: Dict[str, Any], fallback_model: str = "") -> str:
        if self.openrouter_enabled:
            or_model = role_config.get("openrouter_model")
            if or_model:
                return or_model
        return fallback_model or role_config.get("model", "unknown")

    async def _call_vllm(self, model, system_prompt, user_prompt, role_name, role_config, mcp_client, preserve_think=False, json_schema=None) -> str:
        or_model = role_config.get("openrouter_model")
        if not or_model and self._smart_router:
            task_type = "general"
            lower_prompt = user_prompt[:500].lower()
            if any(kw in lower_prompt for kw in ["код", "code", "функци", "class", "def ", "import "]):
                task_type = "code"
            elif any(kw in lower_prompt for kw in ["math", "матем", "вычисл", "формул"]):
                task_type = "math"
            elif any(kw in lower_prompt for kw in ["напиши", "сочини", "creativ", "story", "стих"]):
                task_type = "creative"
            routed_model = self._smart_router.route(RoutingTask(prompt=user_prompt[:300], task_type=task_type))
            if routed_model:
                or_model = routed_model
                logger.info("SmartRouter selected model", model=or_model, task_type=task_type, role=role_name)

        fallback = role_config.get("fallback_model", model)

        # --- AUDITOR ISOLATION: truncate context + fallback model ---
        is_auditor = "Auditor" in role_name
        if is_auditor:
            auditor_budget = ROLE_TOKEN_BUDGET.get("Auditor", 1536)
            max_prompt_chars = auditor_budget * 4  # ~4 chars per token
            if len(user_prompt) > max_prompt_chars:
                logger.warning(
                    "Auditor context truncated",
                    original_chars=len(user_prompt),
                    budget_chars=max_prompt_chars,
                )
                user_prompt = user_prompt[:max_prompt_chars] + "\n\n[... контекст сокращён для Auditor ...]"

        t0 = time.monotonic()
        if self.openrouter_enabled and or_model:
            result = await call_openrouter(
                openrouter_config=self.openrouter_config,
                vllm_url=self.vllm_url,
                model=or_model,
                fallback_model=fallback,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                role_name=role_name,
                role_config=role_config,
                mcp_client=mcp_client,
                config=self.config,
                vllm_manager=self.vllm_manager,
                preserve_think=preserve_think,
                json_schema=json_schema,
            )
        else:
            result = await call_vllm(
                vllm_url=self.vllm_url,
                model=model,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                role_name=role_name,
                role_config=role_config,
                mcp_client=mcp_client,
                config=self.config,
                vllm_manager=self.vllm_manager,
                preserve_think=preserve_think,
                json_schema=json_schema,
            )
        elapsed_ms = (time.monotonic() - t0) * 1000

        used_model = or_model or model
        prompt_tokens_est = (len(system_prompt) + len(user_prompt)) // 4
        completion_tokens_est = len(result) // 4
        self.metrics_collector.record_inference(
            model=used_model,
            prompt_tokens=prompt_tokens_est,
            completion_tokens=completion_tokens_est,
            total_latency_ms=elapsed_ms,
            first_token_ms=elapsed_ms * 0.15,
        )
        logger.debug("Inference metrics recorded", model=used_model, latency_ms=round(elapsed_ms), role=role_name)
        return result

    async def _force_unload(self, model: str):
        await force_unload(model)

    async def execute_stream(self, prompt, brigade="Dmarket", max_steps=5, status_callback=None, task_type=None):
        return await execute_stream(self, prompt, brigade, max_steps, status_callback, task_type)

    @asynccontextmanager
    async def _vram_protection(self, target_model: str, prev_model: Optional[str]):
        if self.force_cloud:
            yield
        else:
            async with vram_protection(target_model, prev_model):
                yield
