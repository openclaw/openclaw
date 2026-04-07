"""
Brigade: OpenClaw
Role: Pipeline Executor (Chain-of-Agents) — Core

Implements the workflow chains described in SOUL.md.
Delegates state management to _state.py, reflexion to _reflexion.py,
and tool execution to _tools_handler.py.
"""

import asyncio
import json
import os
import re
import time
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

import structlog

from src.core.auto_rollback import AutoRollback
from src.mcp_tools.client import OpenClawMCPClient
from src.core.task_queue import ModelTaskQueue
from src.ai.inference.metrics import InferenceMetricsCollector
from src.utils.async_utils import taskgroup_gather
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
    CAPABILITIES_BLOCK,
    build_role_prompt,
    clean_response_for_user,
    compress_for_next_step,
    emergency_compress,
    group_chain,
    sanitize_file_content,
)
from src.validators.code_validator import CodeValidator
from src.llm.gateway import route_llm
from src.llm.openrouter import call_openrouter, reset_circuit_breakers_async
from src.ai.agents.react import ReActReasoner
from src.ai.agents.constitutional import ConstitutionalChecker
from src.tools.dynamic_sandbox import DynamicSandbox

from src.pipeline._state import init_smart_router, init_supermemory, recall_memory_context
from src.pipeline._reflexion import reflexion_fallback
from src.pipeline._tools_handler import handle_planner_handoff

# v11.7 SOTA modules
from src.pipeline._lats_search import LATSEngine, classify_complexity
from src.safety.hallucination import MARCHProtocol

# v13.2: AFlow dynamic chain generation + Ensemble Voting
from src.pipeline._aflow import AFlowEngine

# v14.0: SAGE self-evolution + MAC constitution
from src.pipeline._sage import SAGEEngine
from src.safety.mac_constitution import MACConstitution

# v14.1: Counterfactual Credit + ProRL rollout evaluation
from src.pipeline._counterfactual import CounterfactualCredit
from src.pipeline._prorl import ProRLEngine

# v14.2: Tool Call Text Parser — intercept XML/MD tool leakage from free models
from src.pipeline._tool_call_parser import (
    parse_tool_calls,
    strip_tool_calls,
    execute_parsed_tool_calls,
    format_observations,
)

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# v14.4: Multi-Task Decomposer  (P1-1 / P1-3 hotfix)
# ---------------------------------------------------------------------------

_NUMBERED_RE = re.compile(
    r"(?:^|\n)\s*(\d+)\.\s+(.+?)(?=\n\s*\d+\.\s|\Z)",
    re.DOTALL,
)

# v15.3: Action verbs that signal a new sub-task in unnumbered paragraphs
_ACTION_VERBS_RE = re.compile(
    r"^(?:Сделай|Проанализируй|Напиши|Найди|Создай|Проверь|Check|Create|Write|Find|Analyze|Build|Implement|Audit|Auditor:)",
    re.IGNORECASE,
)
# Minimum prompt length to attempt semantic paragraph splitting
_SEMANTIC_MIN_LEN = 300

# Keyword → brigade mapping (reused from intent_classifier)
_BRIGADE_KEYWORDS: dict[str, list[str]] = {
    "Dmarket-Dev": [
        "dmarket", "buy", "sell", "trade", "price", "skin", "inventory",
        "купить", "продать", "торговля", "скин", "инвентарь", "арбитраж",
        "pyo3", "подпис", "hft", "latency",
    ],
    "Research-Ops": [
        "research", "найди", "поищи", "youtube", "видео", "video",
        "url", "http", "ссылк", "статью", "интернет", "анализ",
        "vision", "проанализируй",
    ],
    "OpenClaw-Core": [
        "config", "pipeline", "model", "bot", "openclaw", "gateway",
        "конфиг", "бригад", "бот", "память", "memory", "mcp",
        "code", "python", "rust", "напиши", "функци",
    ],
}


def _route_subtask(text: str) -> str:
    """Route a single sub-task to the most relevant brigade by keywords."""
    lower = text.lower()
    scores: dict[str, int] = {}
    for brigade, keywords in _BRIGADE_KEYWORDS.items():
        scores[brigade] = sum(1 for kw in keywords if kw in lower)
    best = max(scores, key=scores.get)  # type: ignore[arg-type]
    return best if scores[best] > 0 else "OpenClaw-Core"


def _decompose_multi_task(prompt: str) -> list[tuple[str, str]]:
    """Split a prompt into (sub_task_text, brigade) pairs.

    v15.3: Two-pass strategy:
    1. Try numbered-list regex ("1. ... 2. ...").
    2. Fallback: semantic paragraph splitting — split on \n\n or \n,
       keeping paragraphs that start with an action verb as separate tasks.

    Returns an empty list if the prompt doesn't look like a multi-task.
    """
    # --- Pass 1: numbered-list regex ---
    matches = _NUMBERED_RE.findall(prompt)
    if len(matches) >= 2:
        sub_tasks: list[tuple[str, str]] = []
        for _num, body in matches:
            body = body.strip()
            if body:
                brigade = _route_subtask(body)
                sub_tasks.append((body, brigade))
        return sub_tasks

    # --- Pass 2: semantic paragraph splitting (v15.3) ---
    # Strip any [CHAT HISTORY] prefix before analysing paragraphs
    analysis_text = prompt
    if "[CURRENT TASK]:" in prompt:
        analysis_text = prompt.split("[CURRENT TASK]:", 1)[1].strip()

    if len(analysis_text) < _SEMANTIC_MIN_LEN:
        return []

    # Split on double-newline first; fallback to single-newline
    paragraphs = [p.strip() for p in re.split(r"\n\n+", analysis_text) if p.strip()]
    if len(paragraphs) < 2:
        paragraphs = [p.strip() for p in analysis_text.split("\n") if p.strip()]

    # Keep only paragraphs that look like actionable tasks (action verb at start)
    action_paragraphs: list[str] = []
    # First paragraph is always the context/intro — include it as a task too
    # if it contains a URL or is long enough
    for para in paragraphs:
        if _ACTION_VERBS_RE.search(para):
            action_paragraphs.append(para)
        elif re.search(r"https?://", para) and len(para) > 40:
            # URL-bearing paragraphs are implicit research tasks
            action_paragraphs.append(para)

    if len(action_paragraphs) < 2:
        return []

    sub_tasks = []
    for para in action_paragraphs:
        brigade = _route_subtask(para)
        sub_tasks.append((para, brigade))
    logger.info("Semantic decomposer activated (v15.3)",
                n_paragraphs=len(paragraphs), n_tasks=len(sub_tasks))
    return sub_tasks


async def _async_save_trajectory(supermemory, prompt, chain, complexity, steps_results, response):
    """v14.0: Complementary RL — сохранение траектории успешной сложной задачи в SuperMemory."""
    try:
        await asyncio.to_thread(
            supermemory.save_success_trajectory,
            task=prompt[:200],
            chain=chain,
            complexity=complexity,
            reward=0.85,
            response_preview=response[:120],
        )
        logger.debug("Complementary RL: trajectory saved", chain=chain, complexity=complexity)
    except Exception as _err:
        logger.debug("Complementary RL: trajectory save non-fatal error", error=str(_err))


# ---------------------------------------------------------------------------
# Module-level singleton cache: avoids re-creating heavy objects per PipelineExecutor
# ---------------------------------------------------------------------------
_shared_sandbox: Optional[DynamicSandbox] = None
_shared_react: Optional[ReActReasoner] = None
_shared_constitutional: Optional[ConstitutionalChecker] = None
_shared_march: Optional[MARCHProtocol] = None


def _get_shared_sandbox() -> DynamicSandbox:
    global _shared_sandbox
    if _shared_sandbox is None:
        _shared_sandbox = DynamicSandbox()
    return _shared_sandbox


def _get_shared_react() -> ReActReasoner:
    global _shared_react
    if _shared_react is None:
        _shared_react = ReActReasoner(model="")
    return _shared_react


def _get_shared_constitutional() -> ConstitutionalChecker:
    global _shared_constitutional
    if _shared_constitutional is None:
        _shared_constitutional = ConstitutionalChecker(model="")
    return _shared_constitutional


def _get_shared_march() -> MARCHProtocol:
    global _shared_march
    if _shared_march is None:
        _shared_march = MARCHProtocol()
    return _shared_march


class PipelineExecutor:
    """
    Executes a chain of agent roles sequentially, passing compressed
    context between each step. Uses cloud LLM routing for all inference calls.
    """

    def __init__(self, config: Dict[str, Any]):
        self.config = config

        # OpenRouter configuration (primary inference)
        self.openrouter_config = config.get("system", {}).get("openrouter", {})
        self.openrouter_enabled = self.openrouter_config.get("enabled", False) and bool(self.openrouter_config.get("api_key", ""))
        self.force_cloud = True  # Cloud-only mode (OpenRouter)

        self.default_chains = {
            "Dmarket-Dev": ["Planner", "Coder", "Auditor"],
            "OpenClaw-Core": ["Planner", "Foreman", "Executor_Tools", "Executor_Architect", "Auditor", "State_Manager", "Archivist"],
            "Research-Ops": ["Researcher", "Analyst", "Summarizer"],
        }

        self._ctx_budget = self.config.get("system", {}).get("max_model_len", 16384)

        # Initialize MCP Clients dynamically
        framework_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        self._framework_root = framework_root
        _default_db = os.path.join(framework_root, "data", "openclaw.db")
        self.openclaw_mcp = OpenClawMCPClient(db_path=_default_db, fs_allowed_dirs=[framework_root])

        dmarket_ws = config.get("brigades", {}).get("Dmarket-Dev", {}).get("workspace_dir", framework_root)
        dmarket_ws = os.path.abspath(dmarket_ws) if os.path.isdir(os.path.abspath(dmarket_ws)) else framework_root
        self.dmarket_mcp = OpenClawMCPClient(db_path=None, fs_allowed_dirs=[dmarket_ws])
        self.brigade_mcp_map: Dict[str, OpenClawMCPClient] = {}

        self.last_loaded_model: Optional[str] = None
        self.auto_rollback = AutoRollback(framework_root)
        self.code_validator = CodeValidator(framework_root, config)

        # Reuse shared singletons from llm_gateway
        from src.llm.gateway import get_metrics_collector, get_token_budget
        self.metrics_collector = get_metrics_collector() or InferenceMetricsCollector()
        vram_gb = config.get("system", {}).get("hardware", {}).get("vram_gb", 16.0)
        self.token_budget = get_token_budget() or AdaptiveTokenBudget(
            default_max_tokens=config.get("system", {}).get("max_model_len", 8192),
            vram_gb=vram_gb,
        )
        logger.info("InferenceMetrics + AdaptiveTokenBudget activated (shared)")

        self._supermemory = None
        self._rag_engine = None

        # SmartModelRouter: reuse shared instance from llm_gateway (v17.2 — avoid double init)
        from src.llm.gateway import get_smart_router
        self._smart_router = get_smart_router() or init_smart_router(config, self.force_cloud)

        self._react_reasoner = _get_shared_react()
        self._constitutional = _get_shared_constitutional()
        self._sandbox = _get_shared_sandbox()

        # v17.2: Lazy-init config for heavy engines (created on first use)
        self._lats_engine = None
        self._march_protocol = None
        self._aflow = None
        self._sage = None
        self._mac = None
        self._counterfactual = None
        self._prorl = None
        self._lazy_config = {
            "lats_model": self.config.get("system", {}).get("model_router", {}).get("research", "qwen/qwen3.6-plus:free"),
            "aflow_model": self.config.get("system", {}).get("model_router", {}).get("intent", "qwen/qwen3.6-plus:free"),
            "sage_cfg": self.config.get("system", {}).get("sage", {}),
            "mac_cfg": self.config.get("system", {}).get("mac", {}),
            "mac_model": self.config.get("system", {}).get("model_router", {}).get("expand", "qwen/qwen3.6-plus:free"),
            "cc_cfg": self.config.get("system", {}).get("counterfactual_credit", {}),
            "prorl_cfg": self.config.get("system", {}).get("prorl", {}),
        }

    def _get_lats(self) -> "LATSEngine":
        if self._lats_engine is None:
            self._lats_engine = LATSEngine(model=self._lazy_config["lats_model"])
        return self._lats_engine

    def _get_march(self):
        if self._march_protocol is None:
            self._march_protocol = _get_shared_march()
        return self._march_protocol

    def _get_aflow(self) -> "AFlowEngine":
        if self._aflow is None:
            self._aflow = AFlowEngine(
                model=self._lazy_config["aflow_model"],
                default_chains=self.default_chains,
            )
        return self._aflow

    def _get_sage(self) -> "SAGEEngine":
        if self._sage is None:
            cfg = self._lazy_config["sage_cfg"]
            self._sage = SAGEEngine(
                model=self._lazy_config["aflow_model"],
                enabled=cfg.get("enabled", True),
            )
        return self._sage

    def _get_mac(self) -> "MACConstitution":
        if self._mac is None:
            cfg = self._lazy_config["mac_cfg"]
            self._mac = MACConstitution(
                model=self._lazy_config["mac_model"],
                enabled=cfg.get("enabled", True),
            )
        return self._mac

    def _get_counterfactual(self) -> "CounterfactualCredit":
        if self._counterfactual is None:
            cfg = self._lazy_config["cc_cfg"]
            self._counterfactual = CounterfactualCredit(enabled=cfg.get("enabled", True))
        return self._counterfactual

    def _get_prorl(self) -> "ProRLEngine":
        if self._prorl is None:
            cfg = self._lazy_config["prorl_cfg"]
            self._prorl = ProRLEngine(enabled=cfg.get("enabled", True))
        return self._prorl

    def _init_supermemory(self) -> None:
        init_supermemory(self)

    async def _recall_memory_context(self, prompt: str) -> str:
        return await recall_memory_context(self, prompt)

    async def _reflexion_fallback(self, prompt: str, error_response: str) -> Optional[str]:
        return await reflexion_fallback(self.config, prompt, error_response)

    async def _quick_inference(self, prompt: str) -> str:
        """v16.4: Fast LLM inference for autonomous reflection (Self-Healing)."""
        try:
            return await route_llm(
                prompt,
                system="You are a debugging assistant. Be concise. Answer in Russian.",
                model="qwen/qwen3.6-plus:free",
                max_tokens=512,
                temperature=0.3,
            )
        except Exception as e:
            logger.warning("v16.4 quick inference failed", error=str(e))
            return ""

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

    async def _validate_cloud(self):
        """Checks that the cloud LLM gateway is configured."""
        logger.info("Cloud-only mode: LLM gateway configured via OpenRouter")

    def get_chain(self, brigade: str) -> List[str]:
        brigade_config = self.config.get("brigades", {}).get(brigade, {})
        if not brigade_config:
            logger.warning("Brigade not found in config", brigade=brigade)
            return self.default_chains.get(brigade, ["Planner"])
        if "pipeline" in brigade_config:
            return brigade_config["pipeline"]
        available_roles = set(brigade_config.get("roles", {}).keys())
        default_chain = self.default_chains.get(brigade, ["Planner"])
        return [role for role in default_chain if role in available_roles]

    async def get_chain_dynamic(
        self,
        prompt: str,
        brigade: str,
        max_steps: int = 7,
    ) -> tuple[List[str], str]:
        """v13.2 AFlow: generate optimal chain for this prompt.

        Returns (chain, source) where source is "heuristic"|"llm"|"lats"|"fallback"|"standard".
        Falls back to static get_chain() on any error.

        v17.2: 3-level routing — skip AFlow/ProRL for simple tasks.
          - simple  → 3-role chain [Planner, Executor, Auditor]  ("standard")
          - complex → AFlow + ProRL
          - extreme → AFlow + ProRL
        """
        # Если в конфиге явно задан pipeline — уважаем его (не override)
        brigade_config = self.config.get("brigades", {}).get(brigade, {})
        if "pipeline" in brigade_config:
            return brigade_config["pipeline"][:max_steps], "config"

        available_roles = list(brigade_config.get("roles", {}).keys())
        if not available_roles:
            return self.get_chain(brigade)[:max_steps], "fallback"

        # v17.2: Standard 3-role shortcut for simple tasks — saves ~4 LLM calls
        _complexity = classify_complexity(prompt)
        if _complexity == "simple":
            _standard_chain: list[str] = []
            for r in ("Planner", "Coder", "Executor_Tools", "Auditor"):
                if r in available_roles:
                    _standard_chain.append(r)
            if len(_standard_chain) >= 2:
                logger.info("v17.2 standard-path: simple task → 3-role chain", chain=_standard_chain)
                return _standard_chain[:max_steps], "standard"

        try:
            aflow_result = await self._get_aflow().generate_chain(
                prompt=prompt,
                brigade=brigade,
                available_roles=available_roles,
                config=self.config,
                max_chain_len=max_steps,
            )
            chain = aflow_result.chain or self.get_chain(brigade)

            # v14.1: ProRL — evaluate AFlow chain vs static fallback
            # v17.2: only run ProRL for chains with 3+ steps (gating)
            static_chain = self.get_chain(brigade)[:max_steps]
            if len(chain) >= 3:
                try:
                    prorl_result = self._get_prorl().evaluate_candidates(
                        candidates=[
                            (chain[:max_steps], aflow_result.source),
                            (static_chain, "static"),
                        ],
                        complexity=_complexity,
                    )
                    chain = prorl_result.selected_chain
                    source = prorl_result.selected_source
                    logger.info(
                        "ProRL: chain selected",
                        chain=chain, source=source,
                        score=prorl_result.best_score,
                    )
                    return chain, source
                except Exception as _prorl_err:
                    logger.debug("ProRL evaluation failed (non-fatal)", error=str(_prorl_err))

            logger.info(
                "AFlow chain generated",
                chain=chain,
                source=aflow_result.source,
                confidence=round(aflow_result.confidence, 2),
            )
            return chain[:max_steps], aflow_result.source
        except Exception as e:
            logger.warning("AFlow chain generation failed, using static chain", error=str(e))
            return self.get_chain(brigade)[:max_steps], "fallback"

    async def execute(
        self,
        prompt: str,
        brigade: str = "Dmarket-Dev",
        max_steps: int = 5,
        status_callback=None,
        task_type: Optional[str] = None,
        shared_observations: Optional[dict] = None
    ) -> Dict[str, Any]:
        """Execute the full pipeline for a brigade."""
        _pipeline_start_ts = time.time()

        # --- v14.4: Multi-Task Decomposer (P1-1 / P1-3 hotfix) ---
        # If the prompt contains a numbered list (1. ... 2. ...) and is long enough,
        # decompose into sub-tasks and route each to the best-matching brigade.
        if not task_type and len(prompt) > 200:
            sub_tasks = _decompose_multi_task(prompt)
            if len(sub_tasks) >= 2:
                logger.info(
                    "Multi-task decomposer activated",
                    n_subtasks=len(sub_tasks),
                    brigades=[s[1] for s in sub_tasks],
                )
                if status_callback:
                    await status_callback(
                        "Decomposer", "system",
                        f"🧩 Обнаружено {len(sub_tasks)} подзадач — запускаю параллельно...",
                    )
                return await self._execute_multi_task(
                    sub_tasks, prompt, max_steps, status_callback,
                )

        # П7-fix: инициализируем _traj_context безусловно, чтобы избежать
        # UnboundLocalError на строке ниже при task_type != None
        _traj_context = ""
        if task_type:
            chain = [task_type]
            chain_source = "task_type"
        else:
            # v14.0: Complementary RL — few-shot trajectories для AFlow
            if self._supermemory and classify_complexity(prompt) in ("complex", "extreme"):
                try:
                    _traj_context = self._supermemory.recall_similar_trajectories(prompt, top_k=3)
                    if _traj_context:
                        logger.info("Complementary RL: trajectories injected for AFlow")
                except Exception as _traj_err:
                    logger.debug("Trajectory recall failed (non-fatal)", error=str(_traj_err))

            # v13.2: AFlow — dynamic chain generation
            chain, chain_source = await self.get_chain_dynamic(prompt, brigade, max_steps)

        if not chain:
            return {
                "final_response": "⚠️ No roles available in the pipeline.",
                "brigade": brigade,
                "chain_executed": [],
                "steps": [],
                "status": "completed"
            }

        logger.info(f"Pipeline START: brigade={brigade}, chain={' → '.join(chain)}, source={chain_source}")

        # Reset per-model circuit breakers at the start of each pipeline run
        # so stale failures from previous runs don't poison fresh queries.
        await reset_circuit_breakers_async()

        # --- v13.1: LATS tree search for complex tasks (TaskGroup + early exit) ---
        # v15.4: Skip LATS entirely when prompt contains a URL — force tool-execution chain
        complexity = classify_complexity(prompt)
        _has_url = bool(re.search(r"https?://", prompt))
        if (
            complexity in ("complex", "extreme")
            and not task_type
            and brigade in ("Dmarket", "Dmarket-Dev")
            and not _has_url
        ):
            logger.info("LATS activated", complexity=complexity)
            if status_callback:
                await status_callback("LATS", "tree-search", "🌳 LATS: задача сложная — запускаю дерево поиска решений...")
            try:
                lats_model = self.config.get("brigades", {}).get(brigade, {}).get(
                    "roles", {}
                ).get("Planner", {}).get("model", "qwen/qwen3.6-plus:free")
                lats_result = await self._get_lats().search(
                    prompt=prompt, model=lats_model, config=self.config,
                )
                if lats_result.best_answer:
                    logger.info("LATS completed", depth=lats_result.depth_reached,
                                score=lats_result.best_score, early_exit=lats_result.early_exit)
                    # v15.3: Wrap LATS reasoning trace in <think> so it's hidden from user
                    _lats_answer = lats_result.best_answer
                    # v15.4: Leakage containment — if the best answer itself
                    # contains planning preamble, wrap the entire preamble in
                    # <think> so prompt_handler strips it before the user sees it.
                    # ReDoS-safe: bounded quantifiers instead of unbounded .*?
                    _PLANNING_RE = re.compile(
                        r"^((?:.{0,500}(?:Approach\s{0,5}#\d|Plan\s{0,5}:|Подход\s{0,5}#?\d|План\s{0,5}:).{0,500}\n){1,20})",
                        re.IGNORECASE | re.DOTALL,
                    )
                    _plan_m = _PLANNING_RE.match(_lats_answer)
                    if _plan_m:
                        _lats_answer = (
                            f"<think>\n{_plan_m.group(1).strip()}\n</think>\n\n"
                            + _lats_answer[_plan_m.end():]
                        )
                    _lats_trace = "\n".join(
                        f"[D{n.depth}] {n.thought[:120]}"
                        for n in lats_result.tree_trace
                        if n.thought != "[ROOT]" and n.thought != _lats_answer
                    )
                    if _lats_trace:
                        _lats_answer = f"<think>\n{_lats_trace}\n</think>\n\n{_lats_answer}"
                    return {
                        "final_response": _lats_answer,
                        "brigade": brigade,
                        "chain_executed": ["LATS_TreeSearch"],
                        "steps": [{"role": "LATS_TreeSearch", "model": lats_model, "response": lats_result.best_answer}],
                        "status": "completed",
                        "meta": {"lats_depth": lats_result.depth_reached, "lats_score": lats_result.best_score,
                                 "lats_early_exit": lats_result.early_exit},
                    }
            except Exception as e:
                logger.warning("LATS failed, falling back to linear pipeline", error=str(e))

        budget = self.token_budget.estimate_budget(prompt, task_type or "general")
        logger.info("Token budget estimated", max_tokens=budget.max_tokens, reason=budget.budget_reason)

        memory_context = await self._recall_memory_context(prompt)

        # ── v17: Single-shot mode for simple tasks ──────────────────────
        # Skip the full chain-of-agents loop and answer in a single LLM call.
        # Saves 2-6 API round-trips for straightforward questions.
        if (
            complexity == "simple"
            and chain_source == "standard"
            and not task_type
            and not _has_url
        ):
            _ss_brigade_cfg = self.config.get("brigades", {}).get(brigade, {})
            _ss_first_role = chain[0] if chain else "Planner"
            _ss_role_cfg = _ss_brigade_cfg.get("roles", {}).get(_ss_first_role, {})
            _ss_model = _ss_role_cfg.get("model", "qwen/qwen3.6-plus:free")
            _ss_sys = (
                _ss_role_cfg.get("system_prompt", "You are a helpful assistant.")
                + "\n\nОтвечай прямо и лаконично. Не планируй, не делегируй — просто дай ответ."
                + CAPABILITIES_BLOCK
            )
            if memory_context:
                _ss_sys += f"\n\n[Контекст из памяти]:\n{memory_context[:2000]}"

            logger.info("Single-shot mode activated", brigade=brigade, model=_ss_model)
            if status_callback:
                await status_callback("SingleShot", _ss_model, "⚡ Быстрый ответ...")

            import time as _time_mod
            _ss_t0 = _time_mod.monotonic()
            try:
                _ss_mcp = self.openclaw_mcp if brigade == "OpenClaw-Core" else (self.dmarket_mcp or self.openclaw_mcp)
                _ss_response = await self._call_llm(
                    model=_ss_model,
                    system_prompt=_ss_sys,
                    user_prompt=prompt,
                    role_name="SingleShot",
                    role_config=_ss_role_cfg,
                    mcp_client=_ss_mcp,
                )
                _ss_elapsed = int((_time_mod.monotonic() - _ss_t0) * 1000)

                # Validate: no internal markup leaks (Archivist guardrail)
                _ss_guard = ROLE_GUARDRAILS.get("Archivist")
                _ss_valid = True
                if _ss_guard:
                    _ss_result = _ss_guard(_ss_response)
                    # guardrail returns (bool, str) tuple
                    _ss_valid = _ss_result[0] if isinstance(_ss_result, tuple) else bool(_ss_result)
                if not _ss_valid:
                    logger.warning("Single-shot failed Archivist guardrail, falling through to full chain")
                else:
                    _ss_response = clean_response_for_user(_ss_response)
                    return {
                        "final_response": _ss_response,
                        "brigade": brigade,
                        "chain_executed": ["SingleShot"],
                        "steps": [{"role": "SingleShot", "model": _ss_model,
                                   "response": _ss_response, "duration_ms": _ss_elapsed}],
                        "status": "completed",
                        "meta": {"mode": "single_shot", "complexity": "simple"},
                    }
            except Exception as e:
                logger.warning("Single-shot failed, falling through to full chain", error=str(e))
        # ── end single-shot ──────────────────────────────────────────────

        # v14.2: YouTube — если в промпте есть YouTube URL, извлекаем транскрипт
        _yt_metadata_only = False  # флаг: субтитры недоступны, но есть метаданные
        _yt_transcript_injected = False  # флаг: полный транскрипт успешно инжектирован
        try:
            from src.tools.youtube_parser import is_youtube_url, analyze_youtube_video
            if is_youtube_url(prompt):
                logger.info("YouTube URL detected in prompt, fetching transcript")
                if status_callback:
                    await status_callback("System", "youtube", "🎥 YouTube: извлекаю транскрипт видео...")
                yt_result = await analyze_youtube_video(prompt)
                if yt_result.success:
                    _yt_ctx = yt_result.to_context()
                    memory_context = (_yt_ctx + "\n\n" + memory_context) if memory_context else _yt_ctx
                    _yt_transcript_injected = True
                    logger.info("YouTube transcript injected", video_id=yt_result.video_id, chars=len(yt_result.transcript))
                    # П6-fix: пересчитать budget с учётом реального контекста после YouTube inject
                    effective_prompt = prompt + "\n" + _yt_ctx
                    budget = self.token_budget.estimate_budget(effective_prompt, "research")
                    logger.info("Token budget re-estimated after YouTube inject",
                                max_tokens=budget.max_tokens, chars=len(_yt_ctx))
                elif yt_result.title:
                    # П1/П2-fix: субтитры недоступны, но видео существует — сообщаем явно
                    _yt_metadata_only = True
                    _meta_ctx = yt_result.to_context()  # содержит "(Субтитры недоступны)"
                    
                    if status_callback:
                        await status_callback("System", "youtube", "Поиск текстового описания видео в сети...")
                    
                    from src.research._searcher import web_search
                    try:
                        web_result = await web_search(self.openclaw_mcp or self.dmarket_mcp, yt_result.title + " transcript text")
                        _meta_ctx += f"\n\n[Web Search Fallback for '{yt_result.title}']:\n{web_result}"
                    except Exception as e:
                        logger.warning("web_search fallback failed", error=str(e))
                        
                    memory_context = (_meta_ctx + "\n\n" + memory_context) if memory_context else _meta_ctx
                    logger.warning("YouTube subtitles unavailable, metadata only",
                                   video_id=yt_result.video_id, title=yt_result.title)
                    if status_callback:
                        await status_callback("System", "youtube",
                            f"⚠️ Субтитры недоступны для видео «{yt_result.title}». "
                            "Анализ по метаданным и Web Search.")
                else:
                    logger.warning("YouTube fetch failed", error=yt_result.error)
        except Exception as _yt_err:
            logger.debug("YouTube detection failed (non-fatal)", error=str(_yt_err))

        # v14.0: Complementary RL — инжекция few-shot траекторий в начальный контекст
        if _traj_context and memory_context:
            memory_context = _traj_context + "\n\n" + memory_context
        elif _traj_context:
            memory_context = _traj_context

        # v16.1: Deep Source Injection (NotebookLM simulation)
        if complexity == "extreme":
            try:
                from src.mcp_tools.memory_search import export_vault_content
                _mega_source = export_vault_content()
                if _mega_source and "No markdown files" not in _mega_source and "not found" not in _mega_source:
                    memory_context = (_mega_source + "\n\n" + memory_context) if memory_context else _mega_source
                    logger.info("NotebookLM Deep Source Injection applied (Complexity: extreme)")
            except Exception as _deep_err:
                logger.debug("Deep Source Injection failed", error=str(_deep_err))

        # v16.1: Semantic Cross-Linking (GraphRAG approximation)
        try:
            from src.pipeline._logic_provider import get_neural_connection
            _neural_cx = get_neural_connection(prompt)
            if _neural_cx:
                memory_context = (_neural_cx + "\n\n" + memory_context) if memory_context else _neural_cx
        except Exception as _ns_err:
            logger.debug("Neural Synthesis failed", error=str(_ns_err))

        # v16.3: Persistent Knowledge Hook — fresh entries get top priority
        try:
            from src.pipeline._logic_provider import get_recent_knowledge
            _fresh = get_recent_knowledge(max_age_seconds=3600)
            if _fresh:
                memory_context = (_fresh + "\n\n" + memory_context) if memory_context else _fresh
                logger.info("v16.3 fresh knowledge injected", chars=len(_fresh))
        except Exception as _fk_err:
            logger.debug("Fresh knowledge hook failed", error=str(_fk_err))

        chain_groups = group_chain(chain)
        steps_results = []
        context_briefing = memory_context
        step_index = 0

        # v17.2: Pre-compute enrichment strings once (not per-step)
        _mac_enrichment = ""
        try:
            _mac = self._get_mac()
            _mac_enrichment = _mac.get_enrichment_text() if hasattr(_mac, 'get_enrichment_text') else ""
        except Exception as _e:
            logger.debug("MAC enrichment failed (non-fatal)", error=str(_e))

        _obsidian_logic_cache: str = ""
        try:
            from src.pipeline._logic_provider import get_brigade_logic
            _obsidian_logic_cache = get_brigade_logic(brigade) or ""
        except Exception as _e:
            logger.debug("Obsidian logic load failed (non-fatal)", error=str(_e))

        _learning_log_cache: str = ""
        try:
            from src.pipeline._logic_provider import check_learning_log
            _learning_log_cache = check_learning_log(prompt) or ""
        except Exception as _e:
            logger.debug("Learning log check failed (non-fatal)", error=str(_e))

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
                parallel_results = await taskgroup_gather(*tasks, return_exceptions=True)
                for role_name, res in zip(group, parallel_results):
                    if isinstance(res, Exception):
                        logger.error(f"Parallel step {role_name} failed: {res}")
                        response = f"[PARALLEL_ERROR] ⚠️ {role_name} failed: {res}"
                    else:
                        response = res
                    steps_results.append({"role": role_name, "model": "parallel", "response": response})
                merged = "\n\n".join(
                    f"[{r['role']}]: {r['response']}"
                    if r['response'].startswith("[PARALLEL_ERROR]")
                    else f"[{r['role']}]: {compress_for_next_step(r['role'], r['response'])}"
                    for r in steps_results if r['role'] in group
                )
                context_briefing = merged
                continue

            role_name = group[0]
            if task_type:
                model = self.config.get("system", {}).get("model_router", {}).get(task_type, "qwen/qwen3.6-plus:free")
                role_config = {"model": model}
                system_prompt = build_role_prompt(role_name, role_config, self._framework_root, task_type=task_type)
            else:
                role_config = (
                    self.config.get("brigades", {}).get(brigade, {}).get("roles", {}).get(role_name, {})
                )
                if not role_config:
                    logger.warning(f"Role '{role_name}' not found in config, skipping")
                    step_index += 1
                    continue
                model = role_config.get("model", "qwen/qwen3.6-plus:free")
                system_prompt = build_role_prompt(role_name, role_config, self._framework_root)

            is_final_step = (step_index == len(chain) - 1)

            # v17.2: Use pre-computed enrichment (was per-step, now pipeline-level)
            if _mac_enrichment:
                system_prompt += _mac_enrichment
            if _obsidian_logic_cache:
                system_prompt += _obsidian_logic_cache
            if _learning_log_cache:
                system_prompt += _learning_log_cache

            # v17.3: Inject available tool names for tool-eligible roles
            # П8-fix: вычисляем active_mcp ДО использования (ранее присваивалась только внутри _vram_protection)
            active_mcp = self.openclaw_mcp if brigade == "OpenClaw-Core" else self.dmarket_mcp
            # C2-fix: validate MCP client is still alive
            if active_mcp and hasattr(active_mcp, '_session') and active_mcp._session is None:
                logger.warning("MCP client session is dead, setting active_mcp to None", brigade=brigade)
                active_mcp = None
            if role_name in TOOL_ELIGIBLE_ROLES and active_mcp and hasattr(active_mcp, 'available_tools_openai'):
                _tool_names = [t.get("function", {}).get("name", "") for t in active_mcp.available_tools_openai]
                _tool_names = [n for n in _tool_names if n]
                if _tool_names:
                    system_prompt += (
                        "\n\n[ДОСТУПНЫЕ MCP ИНСТРУМЕНТЫ]\n"
                        "Ты можешь вызывать следующие инструменты:\n"
                        + ", ".join(_tool_names[:40]) + "\n"
                        "Используй их через function calling когда задача требует данных или действий.\n"
                    )

            # П4-fix v14.8 → усилено в v14.9: антигаллюцинационная директива для YouTube
            if _yt_transcript_injected and role_name in ("Researcher", "Analyst", "Summarizer"):
                _yt_directive = (
                    "[КРИТИЧЕСКОЕ ПРАВИЛО — YOUTUBE TRANSCRIPT GROUNDING]\n"
                    "⛔ ЗАПРЕЩЕНО делать ЛЮБЫЕ утверждения о содержании видео, которых НЕТ в транскрипте ниже.\n"
                    "⛔ ЗАПРЕЩЕНО использовать знания из обучающих данных об этом видео, канале или авторе.\n"
                    "✅ Отвечай СТРОГО на основе предоставленного транскрипта.\n"
                    "✅ Если информации нет в транскрипте — явно скажи: «В транскрипте это не упоминается».\n"
                    "Несоблюдение этого правила = галлюцинация = провал задачи.\n"
                )
                # Вставляем В НАЧАЛО system_prompt чтобы модель увидела правило первым
                system_prompt = _yt_directive + "\n" + system_prompt
                logger.debug("YouTube grounding directive injected into system_prompt", role=role_name)

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

            if shared_observations:
                shared_str = "\n".join(f"- {k}: {str(v)[:1000]}..." for k, v in shared_observations.items())
                step_prompt += f"\n\n[SHARED OBSERVATIONS (Parallel Subtasks)]\n{shared_str}"

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

            did_handoff = False
            _autoheal_used = False  # v16.4: one self-healing retry per step

            async with self._vram_protection(model, prev_model):
                preserve_think = any(role in role_name for role in ["Planner", "Foreman", "Orchestrator", "Auditor"])
                role_schema = ROLE_SCHEMAS.get(role_name) if not task_type else None

                # v13.2→v17.2: Ensemble Voting only for extreme complexity (saves 1 LLM call on complex tasks)
                _ensemble_cfg = self.config.get("system", {}).get("ensemble_voting", {})
                _ensemble_enabled = _ensemble_cfg.get("enabled", True)
                _is_executor = role_name.startswith("Executor_") or role_name in ("Coder",)
                _is_extreme = classify_complexity(prompt) == "extreme"
                _use_ensemble = _ensemble_enabled and _is_executor and _is_extreme and not task_type

                if _use_ensemble:
                    _auditor_cfg = (
                        self.config.get("brigades", {}).get(brigade, {}).get("roles", {}).get("Auditor", {})
                    )
                    logger.info("Ensemble Voting activated", role=role_name, instances=2)
                    if status_callback:
                        await status_callback(role_name, display_model,
                                              "🗳️ Ensemble: запускаю N экземпляров с разной температурой...")
                    response = await self._ensemble_vote(
                        role_name=role_name,
                        model=model,
                        system_prompt=system_prompt,
                        step_prompt=step_prompt,
                        role_config=role_config,
                        active_mcp=active_mcp,
                        n_instances=_ensemble_cfg.get("n_instances", 2),
                        auditor_role_config=_auditor_cfg,
                    )
                else:
                    try:
                        response = await self._call_llm(
                            model, system_prompt, step_prompt, role_name, role_config, active_mcp,
                            preserve_think=preserve_think, json_schema=role_schema
                        )
                    except Exception as _llm_err:
                        logger.error("_call_llm failed in pipeline step", role=role_name, error=str(_llm_err))
                        response = f"⚠️ LLM call failed for {role_name}: {_llm_err}"

                # --- v14.2: TOOL CALL TEXT INTERCEPTION ---
                # Free models may emit raw XML/MD tool calls instead of native JSON.
                # Parse them, execute, inject Observation, strip raw tags from response.
                try:
                    _parsed_calls = parse_tool_calls(response)
                    if _parsed_calls:
                        if role_name in TOOL_ELIGIBLE_ROLES:
                            # П5-fix: исполняем инструменты только у eligible ролей.
                            # Summarizer/Analyst/Researcher не должны вызывать инструменты.
                            logger.info(
                                "Tool leakage intercepted",
                                role=role_name, n_calls=len(_parsed_calls),
                                tools=[c.name for c in _parsed_calls],
                            )
                            if status_callback:
                                await status_callback(
                                    role_name, display_model,
                                    f"🔧 Перехвачен вызов инструмента: {_parsed_calls[0].name}. Выполняю...",
                                )
                            _tc_results = await execute_parsed_tool_calls(
                                _parsed_calls, active_mcp, self._sandbox,
                            )
                            if shared_observations is not None:
                                for call, tc_res in zip(_parsed_calls, _tc_results):
                                    shared_observations[call.name] = (tc_res.get("output") or tc_res.get("error") or "")[:2000]
                            _observation = format_observations(_tc_results)

                            # C5-fix: if ALL tool calls returned errors, warn in observation
                            _all_failed = all(
                                (r.get("error") or ("error" in str(r.get("output", "")).lower()[:50]))
                                for r in _tc_results
                            ) if _tc_results else False
                            if _all_failed:
                                _observation += "\n\n⚠️ Все вызванные инструменты вернули ошибки. Ответь пользователю без данных инструментов."

                            # --- v16.4: Autonomous Error Catcher + Self-Healing ---
                            try:
                                from src.pipeline._logic_provider import is_tool_error, autonomous_reflection
                                _tool_errors = [
                                    (c.name, r.get("output") or r.get("error") or "")
                                    for c, r in zip(_parsed_calls, _tc_results)
                                    if is_tool_error(r.get("output") or r.get("error") or "")
                                ]
                                if _tool_errors and not _autoheal_used:
                                    _autoheal_used = True
                                    _err_summary = "; ".join(f"{n}: {e[:200]}" for n, e in _tool_errors)
                                    logger.warning(
                                        "v16.4 Self-Healing: tool errors detected",
                                        errors=len(_tool_errors),
                                        summary=_err_summary[:200],
                                    )
                                    _fix_rule = await autonomous_reflection(
                                        task=prompt,
                                        code=response[:500],
                                        stderr=_err_summary,
                                        inference_fn=self._quick_inference,
                                    )
                                    if _fix_rule:
                                        _observation += (
                                            f"\n\n[SELF-HEALING — ОБНАРУЖЕНА ОШИБКА]\n"
                                            f"Ошибка: {_err_summary[:300]}\n"
                                            f"Правило фикса: {_fix_rule}"
                                        )
                                        if status_callback:
                                            await status_callback(
                                                role_name, display_model,
                                                f"🔄 Self-Healing: {_fix_rule[:80]}...",
                                            )
                            except Exception as _heal_err:
                                logger.debug("v16.4 tool error detection failed (non-fatal)", error=str(_heal_err))

                            # Strip raw tool-call XML from response so user never sees it
                            response = strip_tool_calls(response, _parsed_calls)
                            # Re-query the model with Observation context for a clean answer
                            _tc_followup = (
                                f"{step_prompt}\n\n"
                                f"[TOOL RESULTS]\n{_observation}\n\n"
                                "Используй результаты инструментов выше для финального ответа. "
                                "Не выводи XML-теги tool_call."
                            )
                            response = await self._call_llm(
                                model, system_prompt, _tc_followup, role_name,
                                role_config, active_mcp,
                                preserve_think=preserve_think, json_schema=role_schema,
                            )
                        else:
                            # Роль не должна вызывать инструменты — просто стрипаем теги
                            logger.warning(
                                "Tool leakage stripped (non-eligible role)",
                                role=role_name, n_calls=len(_parsed_calls),
                                tools=[c.name for c in _parsed_calls],
                            )
                            response = strip_tool_calls(response, _parsed_calls)
                except Exception as _tc_err:
                    logger.debug("Tool call interception failed (non-fatal)", error=str(_tc_err))

                # --- GUARDRAIL VALIDATION WITH RETRY ---
                guardrail_fn = ROLE_GUARDRAILS.get(role_name)
                if guardrail_fn and not task_type:
                    # B3-fix: передаём task_hint для context-aware валидации (Analyst)
                    _guardrail_kwargs: Dict[str, Any] = {}
                    if role_name == "Analyst" and (_yt_transcript_injected or _yt_metadata_only):
                        _guardrail_kwargs["task_hint"] = "youtube video"
                    for retry_i in range(GUARDRAIL_MAX_RETRIES):
                        is_valid, feedback = guardrail_fn(response, **_guardrail_kwargs)
                        if is_valid:
                            break
                        logger.warning(f"Guardrail failed for {role_name} (attempt {retry_i + 1}/{GUARDRAIL_MAX_RETRIES}): {feedback}")
                        if status_callback:
                            await status_callback(role_name, display_model, f"🔄 Гарантия качества: повтор {retry_i + 1} — {feedback[:60]}")
                        retry_prompt = f"{step_prompt}\n\n[GUARDRAIL FEEDBACK — исправь ответ]:\n{feedback}"
                        response = await self._call_llm(
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
                            response = await self._call_llm(
                                model, system_prompt, _cv_retry_prompt, role_name, role_config,
                                active_mcp, preserve_think=preserve_think, json_schema=role_schema,
                            )
                    except Exception as _cv_err:
                        logger.warning(f"CodeValidator error (skipping): {_cv_err}")

                # --- v16.4: General step error detection + self-healing retry ---
                if not _autoheal_used and response:
                    _resp_lower = response.lower() if response else ""
                    _has_error_markers = (
                        (response and response.startswith("⚠️"))
                        or "traceback" in _resp_lower
                        or "exception:" in _resp_lower
                        or re.search(r"^(exception|error):", _resp_lower, re.MULTILINE)
                        or "failed to execute" in _resp_lower
                    )
                    if _has_error_markers:
                        _autoheal_used = True
                        _step_err = response[:500]
                        logger.warning(
                            "v16.4 Self-Healing: step error detected",
                            role=role_name,
                            error_preview=_step_err[:100],
                        )
                        try:
                            from src.pipeline._logic_provider import autonomous_reflection, get_recent_knowledge
                            _fix_rule = await autonomous_reflection(
                                task=prompt,
                                code=response[:500],
                                stderr=_step_err,
                                inference_fn=self._quick_inference,
                            )
                            if _fix_rule:
                                _fresh = get_recent_knowledge(max_age_seconds=60) or ""
                                _heal_prompt = (
                                    f"{step_prompt}\n\n"
                                    f"[SELF-HEALING CONTEXT]\n{_fresh}\n\n"
                                    f"[FIX RULE]: {_fix_rule}\n\n"
                                    "Предыдущий ответ содержал ошибку. Используй правило фикса и исправь."
                                )
                                response = await self._call_llm(
                                    model, system_prompt, _heal_prompt, role_name, role_config,
                                    active_mcp, preserve_think=preserve_think, json_schema=role_schema,
                                )
                                if status_callback:
                                    await status_callback(
                                        role_name, display_model,
                                        f"🔄 Self-Healing retry: {_fix_rule[:60]}...",
                                    )
                        except Exception as _heal_step_err:
                            logger.debug("v16.4 step self-healing failed (non-fatal)", error=str(_heal_step_err))

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
                        new_response = await route_llm(
                            step_prompt + "\n\n" + retry_prompt,
                            system=system_prompt,
                            model=model,
                            messages=retry_messages,
                            max_tokens=2048,
                        )
                        new_response = re.sub(r"<think>.*?</think>", "", (new_response or ""), flags=re.DOTALL)
                        new_response = re.sub(r"<think>.*$", "", new_response, flags=re.DOTALL).strip()
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

                    # B1-fix: всегда сохраняем шаг в steps_results, даже если
                    # ответ содержит валидный JSON, не совпавший с action-паттерном.
                    # Без этого Analyst/Researcher/Summarizer молча терялись.
                    if not did_handoff:
                        steps_results.append({"role": role_name, "model": model, "response": response})

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

            # v17.3: Auto git commit removed — destructive side-effect that could
            # commit secrets or unrelated changes. Use explicit commits instead.

            context_briefing = compress_for_next_step(role_name, response)

            # v14.1: SLEA-RL — сохраняем step-level experience
            if self._supermemory and response and not response.startswith("⚠️"):
                try:
                    _step_reward = 0.7  # default for non-error steps
                    if "error" in response.lower() or "fail" in response.lower():
                        _step_reward = 0.3
                    import functools
                    _save_fn = functools.partial(
                        self._supermemory.save_step_experience,
                        episode_id=f"run:{int(time.time())}",
                        step_index=step_index,
                        role=role_name,
                        action=prompt[:200],
                        observation=response[:300],
                        reward=_step_reward,
                    )
                    await asyncio.get_running_loop().run_in_executor(None, _save_fn)
                except Exception as _slea_err:
                    logger.debug("SLEA-RL step save failed (non-fatal)", error=str(_slea_err))
            step_index += 1

        raw_response = steps_results[-1]["response"] if steps_results else None
        final_response = clean_response_for_user(raw_response) if raw_response else ""

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

            # --- v11.7: MARCH hallucination cross-verification ---
            if self._supermemory and len(steps_results) >= 2:
                try:
                    # Find executor role response (not just [-2] which may be wrong role)
                    executor_resp = ""
                    for sr in reversed(steps_results[:-1]):
                        if sr.get("role", "").startswith("Executor_") or sr.get("role") == "Coder":
                            executor_resp = sr["response"]
                            break
                    if not executor_resp:
                        executor_resp = steps_results[-2]["response"] if len(steps_results) >= 2 else ""
                    archivist_resp = final_response
                    march_result = await self._get_march().cross_verify_agents(
                        executor_response=executor_resp,
                        archivist_response=archivist_resp,
                        memory=self._supermemory,
                        config=self.config,
                    )
                    total_claims = len(march_result.verified_claims) + len(march_result.discrepancies)
                    disc_rate = len(march_result.discrepancies) / max(total_claims, 1)
                    if not march_result.is_consistent:
                        logger.warning(
                            "MARCH cross-verification failed",
                            discrepancy_rate=disc_rate,
                            unverified=len(march_result.discrepancies),
                        )
                        if march_result.corrected_response:
                            final_response = march_result.corrected_response
                            steps_results.append({
                                "role": "MARCH_Verification",
                                "model": "march",
                                "response": final_response,
                            })
                    else:
                        logger.info("MARCH cross-verification passed", rate=disc_rate)
                except Exception as e:
                    logger.warning("MARCH verification failed (non-fatal)", error=str(e))

        # v14.0: SAGE — анализ низкокачественных шагов
        if steps_results:
            try:
                sage_result = self._get_sage().analyze_steps(steps_results, chain)
                if sage_result.needs_rebuild:
                    logger.warning(
                        "SAGE: low-quality step detected — correction saved",
                        step=sage_result.low_score_step,
                        score=sage_result.detected_score,
                        suggested_chain=sage_result.suggested_chain,
                    )
                    if self._supermemory:
                        self._get_sage().save_to_memory(self._supermemory, sage_result)
            except Exception as _sage_err:
                logger.debug("SAGE analysis failed (non-fatal)", error=str(_sage_err))

        # v14.0: Complementary RL — сохраняем траекторию успешных сложных задач
        _complexity = classify_complexity(prompt)
        _is_success = final_response and not final_response.startswith("⚠️")
        if _is_success and _complexity in ("complex", "extreme") and self._supermemory:
            try:
                _traj_task = asyncio.ensure_future(
                    _async_save_trajectory(
                        self._supermemory, prompt, chain, _complexity,
                        steps_results, final_response,
                    )
                )
                _traj_task.add_done_callback(
                    lambda t: t.exception() and logger.debug(
                        "Trajectory save background error", error=str(t.exception())
                    ) if not t.cancelled() and t.exception() else None
                )
            except Exception as _trl_err:
                logger.debug("Trajectory save failed (non-fatal)", error=str(_trl_err))

        # v14.1: Counterfactual Credit — persist stats to SuperMemory
        if self._supermemory:
            try:
                self._get_counterfactual().save_to_memory(self._supermemory)
            except Exception as _cc_err:
                logger.debug("Counterfactual credit save failed (non-fatal)", error=str(_cc_err))

        # v16.0 & v16.1: Learning Log and Dynamic Auto-Tagging
        try:
            from src.pipeline._logic_provider import record_learning, auto_tag_snippet
            if final_response and not final_response.startswith("⚠️"):
                record_learning(prompt, "", final_response)
                auto_tag_snippet(prompt, final_response)
            else:
                record_learning(prompt, final_response, "Execution failed or produced warnings")
        except Exception as _ll_err:
            logger.debug("Obsidian LearningLog / AutoTag write failed", error=str(_ll_err))

        logger.info(f"Pipeline COMPLETE: brigade={brigade}, steps={len(steps_results)}")

        # v18.0: CognitiveEvolution — record execution outcome
        if hasattr(self, 'evolution_engine') and self.evolution_engine:
            try:
                from src.cognitive_evolution import ExecutionOutcome
                _evo_last_role = steps_results[-1]["role"] if steps_results else "unknown"
                _evo_last_model = steps_results[-1].get("model", "unknown") if steps_results else "unknown"
                _evo_duration = time.time() - _pipeline_start_ts
                self.evolution_engine.record_outcome(ExecutionOutcome(
                    task_id=f"pipe_{int(_pipeline_start_ts)}",
                    task_description=prompt[:200],
                    role=_evo_last_role,
                    intended_action=prompt[:100],
                    observed_result=final_response[:200] if final_response else "",
                    success=bool(_is_success),
                    quality_score=0.8 if _is_success else 0.3,
                    duration_sec=_evo_duration,
                    model_used=_evo_last_model,
                ))
            except Exception as _evo_err:
                logger.debug("CognitiveEvolution record failed (non-fatal)", error=str(_evo_err))

        # v18.0: RL Orchestrator — record pipeline episode for reward learning
        if hasattr(self, 'rl_orchestrator') and self.rl_orchestrator:
            try:
                _rl_duration = time.time() - _pipeline_start_ts
                self.rl_orchestrator.on_pipeline_complete(
                    episode_id=f"ep_{int(_pipeline_start_ts)}",
                    task_type=task_type or "general",
                    success=bool(_is_success),
                    auditor_score=0.8 if _is_success else 0.3,
                    latency_ms=_rl_duration * 1000,
                    input_tokens=len(prompt) // 4,
                    output_tokens=sum(len(s.get("response", "")) // 4 for s in steps_results),
                    steps=[
                        {"role": s.get("role", ""), "model": s.get("model", ""), "response": s.get("response", "")[:2000]}
                        for s in steps_results
                    ],
                )
            except Exception as _rl_err:
                logger.debug("RL on_pipeline_complete failed (non-fatal)", error=str(_rl_err))

        # Ensure final_response is never empty (would cause TelegramBadRequest)
        if not final_response or not final_response.strip():
            final_response = "⚠️ Пайплайн не смог сгенерировать ответ. Попробуйте переформулировать запрос."

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
        model = role_config.get("model", "qwen/qwen3.6-plus:free")
        display_model = self._display_model(role_config, model)
        system_prompt = build_role_prompt(role_name, role_config, self._framework_root)
        step_prompt = (
            f"[PIPELINE CONTEXT from previous step]\n{context_briefing}\n\n"
            f"[ORIGINAL USER TASK]\n{prompt}\n\n"
            f"Based on the above context, perform your role as {role_name}."
        )
        if status_callback:
            await status_callback(role_name, display_model, f"⚡ Параллельно: {role_name} работает...")
        active_mcp = self.openclaw_mcp if brigade == "OpenClaw-Core" else self.dmarket_mcp
        return await self._call_llm(model, system_prompt, step_prompt, role_name, role_config, active_mcp)

    def _display_model(self, role_config: Dict[str, Any], fallback_model: str = "") -> str:
        if self.openrouter_enabled:
            or_model = role_config.get("openrouter_model")
            if or_model:
                return or_model
        return fallback_model or role_config.get("model", "unknown")

    # ------------------------------------------------------------------
    # v13.2: Ensemble Voting — parallel Executor instances with consensus
    # ------------------------------------------------------------------

    async def _ensemble_vote(
        self,
        role_name: str,
        model: str,
        system_prompt: str,
        step_prompt: str,
        role_config: Dict[str, Any],
        active_mcp,
        n_instances: int = 2,
        auditor_role_config: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Run N Executor instances in parallel with temperature diversity,
        then select the best response via Auditor consensus scoring.

        v13.2: uses asyncio.TaskGroup for parallel inference.
        - Instance 0: temperature=0.7 (balanced)
        - Instance 1: temperature=1.0 (creative / alternative view)
        - Auditor (if available): scores all candidates and picks winner
          or synthesises a final composite answer.

        Falls back to single-instance call on any errors.
        """
        temperatures = [0.7, 1.0, 0.5][:n_instances]

        async def _run_at_temp(temp: float) -> str:
            # Patch role_config temperature inline — non-destructive copy
            patched_config = dict(role_config)
            patched_config["temperature"] = temp
            try:
                return await self._call_llm(
                    model, system_prompt, step_prompt,
                    role_name, patched_config, active_mcp,
                    preserve_think=False,
                )
            except Exception as e:
                logger.warning("Ensemble instance failed", temp=temp, error=str(e))
                return ""

        # Launch all instances concurrently
        candidates: List[str] = []
        try:
            async with asyncio.TaskGroup() as tg:
                futures = [tg.create_task(_run_at_temp(t)) for t in temperatures]
            candidates = [f.result() for f in futures if f.result()]
        except* Exception as eg:
            logger.warning("Ensemble TaskGroup error", errors=str(eg))
            # Graceful fallback via gather (create fresh coroutines)
            raw = await asyncio.gather(*[_run_at_temp(t) for t in temperatures], return_exceptions=True)
            candidates = [r for r in raw if isinstance(r, str) and r]

        if not candidates:
            logger.warning("Ensemble: all instances failed, single fallback")
            return await self._call_llm(
                model, system_prompt, step_prompt, role_name, role_config, active_mcp,
            )

        if len(candidates) == 1:
            return candidates[0]

        # --- Auditor consensus scoring ---
        auditor_cfg = auditor_role_config or {}
        auditor_model = auditor_cfg.get("model") or auditor_cfg.get("openrouter_model") or model

        candidates_block = "\n\n".join(
            f"[CANDIDATE {i + 1}]:\n{c[:1500]}"
            for i, c in enumerate(candidates)
        )
        vote_prompt = (
            f"You are an expert judge. The following are {len(candidates)} candidate responses "
            f"to the same task. Analyse each, then either:\n"
            f"a) Select the best candidate verbatim (output: 'WINNER: <N>'), or\n"
            f"b) Synthesise a superior composite answer using the best parts.\n\n"
            f"TASK:\n{step_prompt[:600]}\n\n"
            f"{candidates_block}\n\n"
            f"Your verdict (winner or composite):"
        )
        vote_system = (
            "You are a senior technical reviewer. Evaluate response quality, correctness, "
            "completeness and absence of hallucinations. Output the best answer directly."
        )

        try:
            verdict = await self._call_llm(
                auditor_model,
                vote_system,
                vote_prompt,
                "Ensemble_Auditor",
                auditor_cfg or role_config,
                active_mcp,
            )
            # If verdict references a specific winner, return that candidate
            m = re.search(r'WINNER:\s*(\d+)', verdict or "")
            if m:
                idx = int(m.group(1)) - 1
                if 0 <= idx < len(candidates):
                    logger.info("Ensemble: Auditor selected winner", idx=idx + 1)
                    # v14.1: Counterfactual Credit — record vote outcome
                    try:
                        self._get_counterfactual().record_vote(
                            role=role_name, temperatures=temperatures,
                            candidates=candidates, winner_index=idx,
                        )
                    except Exception:
                        pass
                    return candidates[idx]
            # Otherwise return the synthesised composite
            if verdict and len(verdict.strip()) > 30:
                logger.info("Ensemble: Auditor synthesised composite answer")
                # v14.1: Counterfactual Credit — composite = first candidate wins by default
                try:
                    self._get_counterfactual().record_vote(
                        role=role_name, temperatures=temperatures,
                        candidates=candidates, winner_index=0,
                    )
                except Exception:
                    pass
                return verdict
        except Exception as e:
            logger.warning("Ensemble Auditor failed, using longest candidate", error=str(e))

        # Last resort: return longest (most complete) candidate
        if candidates:
            return max(candidates, key=len)
        return ""

    async def _call_llm(self, model, system_prompt, user_prompt, role_name, role_config, mcp_client, preserve_think=False, json_schema=None) -> str:
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

        # v17.3: Collect MCP tools for tool-eligible roles
        _tools_payload = None
        if role_name in TOOL_ELIGIBLE_ROLES and mcp_client and hasattr(mcp_client, 'available_tools_openai'):
            _all_tools = mcp_client.available_tools_openai
            if _all_tools:
                if "Planner" in role_name or "Foreman" in role_name:
                    _readonly = {
                        "list_directory", "read_file", "list_tables", "read_query",
                        "describe_table", "search_memory", "web_search", "web_news_search",
                    }
                    _tools_payload = [t for t in _all_tools if t.get("function", {}).get("name") in _readonly]
                else:
                    _tools_payload = _all_tools
                if _tools_payload:
                    logger.debug(f"Injecting {len(_tools_payload)} MCP tools for {role_name}")

        if self.openrouter_enabled and or_model:
            result = await call_openrouter(
                openrouter_config=self.openrouter_config,
                model=or_model,
                fallback_model=fallback,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                role_name=role_name,
                role_config=role_config,
                mcp_client=mcp_client,
                config=self.config,
                preserve_think=preserve_think,
                json_schema=json_schema,
                tools=_tools_payload,
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
        result = result or ""

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

    # ------------------------------------------------------------------
    # v14.4: Multi-Task parallel execution
    # ------------------------------------------------------------------

    async def _execute_multi_task(
        self,
        sub_tasks: list[tuple[str, str]],
        original_prompt: str,
        max_steps: int,
        status_callback,
    ) -> Dict[str, Any]:
        """Run decomposed sub-tasks concurrently, each routed to its brigade."""

        # v15.2: Extract [CHAT HISTORY] from original prompt so each sub-task
        # retains multi-turn context (prevents amnesia during decomposition).
        _history_block = ""
        if "[CURRENT TASK]:" in original_prompt:
            _history_block = original_prompt.split("[CURRENT TASK]:")[0] + "[CURRENT TASK]:\n"

        shared_observations = {}

        async def _run_one(idx: int, text: str, brigade: str) -> Dict[str, Any]:
            if status_callback:
                await status_callback(
                    "Decomposer", "system",
                    f"🔀 Подзадача {idx + 1}/{len(sub_tasks)} → {brigade}",
                )
            # Prepend chat history to each sub-task
            enriched_text = _history_block + text if _history_block else text
            # task_type prevents re-decomposition (infinite recursion guard)
            return await self.execute(
                prompt=enriched_text,
                brigade=brigade,
                max_steps=max_steps,
                status_callback=status_callback,
                task_type="decomposed_subtask",
                shared_observations=shared_observations,
            )

        tasks = [
            _run_one(i, text, brigade)
            for i, (text, brigade) in enumerate(sub_tasks)
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Merge results into one response
        merged_parts: list[str] = []
        all_steps: list[dict] = []
        all_chains: list[str] = []
        for i, (text, brigade) in enumerate(sub_tasks):
            res = results[i]
            if isinstance(res, Exception):
                merged_parts.append(f"**Задача {i + 1}** ({brigade}): ⚠️ Ошибка: {res}")
            else:
                resp = res.get("final_response", "")
                merged_parts.append(f"**Задача {i + 1}** ({brigade}):\n{resp}")
                all_steps.extend(res.get("steps", []))
                all_chains.extend(res.get("chain_executed", []))

        final = "\n\n---\n\n".join(merged_parts)
        logger.info(
            "Multi-task decomposer complete",
            n_subtasks=len(sub_tasks),
            n_steps=len(all_steps),
        )
        return {
            "final_response": final,
            "brigade": "Multi-Task",
            "chain_executed": all_chains,
            "steps": all_steps,
            "status": "completed",
            "meta": {"decomposed": True, "n_subtasks": len(sub_tasks)},
        }

    async def _force_unload(self, model: str):
        pass  # No-op in cloud-only mode

    async def execute_stream(self, prompt, brigade="Dmarket-Dev", max_steps=5, status_callback=None, task_type=None):
        """Execute pipeline with streaming enabled for the final response."""
        result = await self.execute(prompt, brigade=brigade, max_steps=max_steps, status_callback=status_callback, task_type=task_type)

        # If execution succeeded, attach a stream generator for progressive Telegram delivery
        if result.get("status") != "error" and result.get("final_response"):
            async def _stream_final():
                """Yield the final response in chunks for progressive display."""
                text = result["final_response"]
                chunk_size = 120
                for i in range(0, len(text), chunk_size):
                    yield text[i:i + chunk_size]
            result["stream"] = _stream_final()

        return result

    @asynccontextmanager
    async def _vram_protection(self, target_model: str, prev_model: Optional[str]):
        yield  # No-op in cloud-only mode
