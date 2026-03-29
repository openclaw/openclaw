"""AFlow — Automated Workflow Generation for OpenClaw v13.2.

Reference:
- Hu et al., "AFlow: Automating Agentic Workflow Generation", arXiv:2410.10762
- Adapted from data/research/v11.6 collection

Replaces hardcoded pipeline chains with LLM-generated optimal sequences.
LATSEngine evaluates candidate chains and selects the best one.

Design:
- Fast heuristic pre-filters (no LLM call for known patterns)
- LLM-generated chain for unknown/complex multi-role tasks
- Auditor inclusion based on task complexity score
- Fallback to static default_chains on any failure
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import structlog

from src.ai.agents._shared import call_vllm
from src.pipeline._lats_search import classify_complexity

logger = structlog.get_logger("AFlow")

# ---------------------------------------------------------------------------
# Available roles per brigade (used to constrain generation)
# ---------------------------------------------------------------------------

_BRIGADE_ROLE_SETS: Dict[str, List[str]] = {
    "Dmarket-Dev": [
        "Planner", "Coder", "Auditor", "Executor_Tools",
        "Executor_Architect", "State_Manager", "Archivist",
    ],
    "OpenClaw-Core": [
        "Planner", "Foreman", "Executor_Tools", "Executor_Architect",
        "Auditor", "State_Manager", "Archivist", "Research_Ops",
    ],
    "Research-Ops": [
        "Researcher", "Analyst", "Summarizer", "Auditor",
    ],
}

# Roles that are expensive / heavy — only include when task justifies it
_HEAVY_ROLES = frozenset(["Auditor", "State_Manager", "Archivist", "Research_Ops"])

# Roles that MUST appear first in any chain
_ORCHESTRATOR_ROLES = frozenset(["Planner", "Foreman", "Researcher"])

# ---------------------------------------------------------------------------
# Heuristic fast-path chains (no LLM call)
# ---------------------------------------------------------------------------

_HEURISTIC_CHAINS: List[tuple[re.Pattern, List[str]]] = [
    # Pure code generation / refactor
    # B6-fix: добавлены Executor_Architect и Executor_Tools как альтернативы для Coder
    # (Coder есть только в Dmarket-Dev; OpenClaw-Core использует Executor_*)
    (re.compile(r"\b(напиши|реализуй|implement|create\s+function|refactor|рефактор|fix\s+bug|исправь)\b", re.I),
     ["Planner", "Coder", "Executor_Architect", "Auditor"]),
    # Trading / market analysis
    (re.compile(r"\b(trade|buy|sell|price|market|dmarket|арбитраж|hft|listing)\b", re.I),
     ["Planner", "Executor_Tools", "Auditor"]),
    # YouTube — must appear BEFORE generic URL pattern; Researcher must be first (has youtube_parser)
    (re.compile(r"youtube\.com|youtu\.be", re.I),
     ["Researcher", "Analyst", "Summarizer"]),
    # Research / web (generic)
    (re.compile(r"\b(найди|research|поищи|browse|fetch|url|http|deep\s+research)\b", re.I),
     ["Researcher", "Analyst", "Summarizer"]),
    # Config / system
    (re.compile(r"\b(config|конфиг|настрой|configure|deploy|pipeline|brigade)\b", re.I),
     ["Planner", "Executor_Tools", "State_Manager"]),
]

# Regex for detecting any URL in a prompt — used for pre-flight chain validation
_URL_PATTERN = re.compile(r"https?://", re.I)

# Roles considered tool-capable for URL/fetch tasks
_TOOL_CAPABLE_ROLES = frozenset(["Researcher", "Executor_Tools"])

# v15.0: Vague prompt indicators — prompts matching these need enrichment, not ask_user
_VAGUE_INDICATORS = re.compile(
    r"^(напиши|сделай|проверь|расскажи|покажи|найди|создай|помоги|объясни)"
    r"\s+(что-нибудь|что-то|как-нибудь|нормально|круто|прикольное|интересное)",
    re.I,
)

# v15.0: Brigade-specific enrichment context — used to concretize vague prompts
_BRIGADE_ENRICHMENT: Dict[str, str] = {
    "Dmarket-Dev": "в контексте DMarket — торговля скинами CS2, API интеграция, арбитраж, автоматизация",
    "OpenClaw-Core": "в контексте OpenClaw — мульти-агентный AI-фреймворк, pipeline, бригады, инструменты",
    "Research-Ops": "в контексте исследования — deep research, анализ данных, сбор информации из web",
}


@dataclass
class AFlowResult:
    """Result of AFlow chain generation."""
    chain: List[str]
    source: str       # "heuristic" | "llm" | "lats" | "fallback"
    confidence: float
    reasoning: str = ""
    candidates_explored: int = 0


# ---------------------------------------------------------------------------
# AFlow Engine
# ---------------------------------------------------------------------------

class AFlowEngine:
    """Automated workflow generation engine.

    v13.2: Replaces hardcoded brigade chains with dynamically generated ones.
    Uses a three-stage approach:
    1. Fast heuristic matching (no LLM)
    2. LLM-generated chain with role constraints
    3. LATS-based evaluation of multiple chain candidates
    """

    def __init__(
        self,
        vllm_url: str = "",
        model: str = "meta-llama/llama-3.3-70b-instruct:free",
        default_chains: Optional[Dict[str, List[str]]] = None,
    ):
        self.vllm_url = vllm_url.rstrip("/") if vllm_url else ""
        self.model = model
        self.default_chains: Dict[str, List[str]] = default_chains or {
            "Dmarket-Dev": ["Planner", "Coder", "Auditor"],
            "OpenClaw-Core": ["Planner", "Foreman", "Executor_Tools", "Executor_Architect", "Auditor", "State_Manager", "Archivist"],
            "Research-Ops": ["Researcher", "Analyst", "Summarizer"],
        }

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    async def generate_chain(
        self,
        prompt: str,
        brigade: str,
        available_roles: List[str],
        config: Optional[Dict[str, Any]] = None,
        max_chain_len: int = 7,
    ) -> AFlowResult:
        """Generate optimal agent chain for the given prompt and brigade.

        Algorithm:
        1. v15.0: Vague prompt enrichment — concretize ambiguous requests
        2. Heuristic fast-path → immediate return, no LLM call
        3. LLM generation with candidate expansion (asyncio.TaskGroup)
        4. Fallback to static default_chain on errors
        """
        # v15.0: Enrich vague prompts with brigade context instead of punting to ask_user
        enriched_prompt = prompt
        if _VAGUE_INDICATORS.search(prompt):
            enrichment = _BRIGADE_ENRICHMENT.get(brigade, "")
            if enrichment:
                enriched_prompt = f"{prompt} ({enrichment})"
                logger.info(
                    "AFlow v15.0: vague prompt enriched",
                    original=prompt[:80],
                    enriched=enriched_prompt[:120],
                    brigade=brigade,
                )

        # v16.0: Obsidian dynamic instructions override
        try:
            from src.pipeline._logic_provider import get_instruction_override
            custom_chain, instruction_ctx = get_instruction_override(prompt)
            if instruction_ctx:
                prompt = prompt + instruction_ctx
                enriched_prompt = enriched_prompt + instruction_ctx
            
            if custom_chain:
                _valid_custom = [r for r in custom_chain if r in available_roles]
                if len(_valid_custom) >= 2:
                    logger.info("AFlow: using Obsidian override chain", chain=_valid_custom)
                    return AFlowResult(
                        chain=_valid_custom,
                        source="obsidian_override",
                        confidence=1.0,
                        reasoning="Overridden by Obsidian #instruction tag",
                    )
        except Exception as _obs_err:
            logger.debug("Obsidian logic provider failed (non-fatal)", error=str(_obs_err))

        # Stage 1: Heuristic fast-path
        heuristic = self._match_heuristic(enriched_prompt, available_roles)
        if heuristic:
            # URL pre-flight: if prompt contains a URL, guarantee a tool-capable role is first
            if _URL_PATTERN.search(prompt):
                heuristic = self._ensure_tool_capable_first(heuristic, available_roles)
            logger.info("AFlow: heuristic chain selected", chain=heuristic, brigade=brigade)
            return AFlowResult(
                chain=heuristic,
                source="heuristic",
                confidence=0.85,
                reasoning="Heuristic keyword match",
            )

        # Stage 2: LLM-generated chain (with aggressive timeout for free-tier)
        # B4-fix: на free-tier моделях Stage 2 тратит 20-40с впустую.
        # Ограничиваем 8с — если не успели, сразу fallback к static chain.
        try:
            result = await asyncio.wait_for(
                self._llm_generate_chain(
                    prompt=enriched_prompt,
                    brigade=brigade,
                    available_roles=available_roles,
                    config=config,
                    max_chain_len=max_chain_len,
                ),
                timeout=8.0,
            )
            if result and result.chain:
                logger.info("AFlow: LLM chain generated", chain=result.chain,
                            source=result.source, confidence=result.confidence)
                return result
        except asyncio.TimeoutError:
            logger.info("AFlow: LLM chain generation timed out (8s), using static chain")
        except Exception as e:
            logger.warning("AFlow LLM generation failed, falling back", error=str(e))

        # Stage 3: Fallback
        fallback = self.default_chains.get(brigade, ["Planner"])
        fallback = [r for r in fallback if r in available_roles] or fallback[:3]
        logger.info("AFlow: fallback to static chain", chain=fallback, brigade=brigade)
        return AFlowResult(
            chain=fallback,
            source="fallback",
            confidence=0.6,
            reasoning="Fallback to static default_chain",
        )

    # ------------------------------------------------------------------
    # Stage 1: Heuristic matching
    # ------------------------------------------------------------------

    def _match_heuristic(self, prompt: str, available_roles: List[str]) -> Optional[List[str]]:
        """Return a predefined chain based on keyword patterns, or None."""
        for pattern, chain in _HEURISTIC_CHAINS:
            if pattern.search(prompt):
                # Filter to only available roles
                filtered = [r for r in chain if r in available_roles]
                if filtered:
                    return filtered
        return None

    def _ensure_tool_capable_first(self, chain: List[str], available_roles: List[str]) -> List[str]:
        """If the chain doesn't start with a tool-capable role, prepend one.

        This is the v14.6 anti-laziness guarantee: any prompt that contains a URL
        MUST be routed to a role that has tool access (Researcher or Executor_Tools)
        as the FIRST handler — never to a pure-text role like Summarizer or Analyst.
        Inspired by MetaGPT BY_ORDER mode: remove optionality, enforce execution path.
        """
        if chain and chain[0] in _TOOL_CAPABLE_ROLES:
            return chain
        # Find the first tool-capable role available and prepend it
        for role in ("Researcher", "Executor_Tools"):
            if role in available_roles and role not in chain:
                logger.info(
                    "AFlow URL pre-flight: prepending tool-capable role",
                    prepended=role,
                    original_chain=chain,
                )
                return [role] + chain
        # If already in chain but not first, move it to front
        for role in ("Researcher", "Executor_Tools"):
            if role in chain:
                reordered = [role] + [r for r in chain if r != role]
                logger.info(
                    "AFlow URL pre-flight: reordered chain to put tool role first",
                    reordered=reordered,
                )
                return reordered
        return chain

    # ------------------------------------------------------------------
    # Stage 2: LLM-based chain generation
    # ------------------------------------------------------------------

    async def _llm_generate_chain(
        self,
        prompt: str,
        brigade: str,
        available_roles: List[str],
        config: Optional[Dict[str, Any]] = None,
        max_chain_len: int = 7,
    ) -> AFlowResult:
        """Generate N chain candidates in parallel via asyncio.TaskGroup,
        then select the best one by complexity-weighted scoring."""
        complexity = classify_complexity(prompt)
        n_candidates = 3 if complexity in ("complex", "extreme") else 2

        roles_str = ", ".join(available_roles)
        sys_prompt = (
            "You are an AI workflow architect. Given a user task and a list of available agents, "
            "output an optimal sequence of agents as a JSON array of role names. "
            "Rules:\n"
            "- FIRST role MUST be an orchestrator: Planner, Foreman, or Researcher\n"
            "- Include Auditor only for complex/risky tasks\n"
            "- Include Archivist/State_Manager only if task requires persistence\n"
            "- Minimum 2 roles, maximum 7 roles\n"
            "- Output ONLY a JSON array, no explanations\n"
            f"Available roles: {roles_str}"
        )
        user_prompt = (
            f"Task: {prompt[:600]}\n"
            f"Brigade: {brigade}\n"
            f"Complexity: {complexity}\n\n"
            f"Output the optimal agent chain as a JSON array:"
        )

        # Generate N candidates concurrently with temperature diversity
        async def _gen_candidate(idx: int) -> Optional[List[str]]:
            temp = 0.3 + idx * 0.2  # 0.3, 0.5, 0.7
            raw = await call_vllm(
                self.vllm_url,
                self.model,
                [
                    {"role": "system", "content": sys_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=temp,
                max_tokens=128,
            )
            return self._parse_chain(raw, available_roles, max_chain_len)

        tasks = [_gen_candidate(i) for i in range(n_candidates)]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        candidates: List[List[str]] = [
            r for r in results
            if isinstance(r, list) and r
        ]

        if not candidates:
            return AFlowResult(chain=[], source="llm", confidence=0.0)

        # Score candidates: penalize missing orchestrator, reward appropriate length
        best_chain, best_score = self._score_candidates(candidates, complexity)

        # Decide whether to trust the LLM result (confidence threshold)
        confidence = min(0.95, 0.6 + best_score * 0.35)
        source = "lats" if n_candidates >= 3 else "llm"

        return AFlowResult(
            chain=best_chain,
            source=source,
            confidence=confidence,
            reasoning=f"Generated {len(candidates)} candidates, selected best (score={best_score:.2f})",
            candidates_explored=len(candidates),
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _parse_chain(
        self,
        raw: str,
        available_roles: List[str],
        max_len: int,
    ) -> Optional[List[str]]:
        """Parse LLM output into a valid role sequence."""
        import json
        raw = raw.strip()
        # Extract JSON array from response
        match = re.search(r'\[.*?\]', raw, re.DOTALL)
        if not match:
            return None
        try:
            parsed = json.loads(match.group(0))
        except (json.JSONDecodeError, ValueError):
            return None

        if not isinstance(parsed, list):
            return None

        # Validate roles — only keep roles that exist
        raw_validated = [r for r in parsed if isinstance(r, str) and r in available_roles]

        # Stage 3 (v15.5): Запрет повторного цикла Researcher -> Analyst
        # и ограничение Research-цепочки максимум 3 шагами
        validated = []
        seen_roles = set()
        for r in raw_validated:
            if r in ("Researcher", "Analyst"):
                if r in seen_roles:
                    continue  # Пропускаем дубликат
                seen_roles.add(r)
            validated.append(r)

        if "Researcher" in validated:
            validated = validated[:3]
        else:
            validated = validated[:max_len]

        if len(validated) < 2:
            return None

        return validated

    def _score_candidates(
        self,
        candidates: List[List[str]],
        complexity: str,
    ) -> tuple[List[str], float]:
        """Score chain candidates and return (best_chain, best_score)."""
        best_chain: List[str] = candidates[0]
        best_score = -1.0

        for chain in candidates:
            score = 0.0

            # Must start with an orchestrator
            if chain and chain[0] in _ORCHESTRATOR_ROLES:
                score += 0.4

            # Auditor inclusion appropriate for complexity
            has_auditor = "Auditor" in chain
            if complexity in ("complex", "extreme") and has_auditor:
                score += 0.2
            elif complexity == "simple" and not has_auditor:
                score += 0.1

            # Penalize excessively long chains for simple tasks
            if complexity == "simple" and len(chain) > 3:
                score -= 0.1 * (len(chain) - 3)
            elif complexity == "extreme" and len(chain) >= 4:
                score += 0.15

            # Chain doesn't duplicate roles (deduplication)
            if len(chain) == len(set(chain)):
                score += 0.1

            if score > best_score:
                best_score = score
                best_chain = chain

        return best_chain, max(best_score, 0.0)
