"""LATS — Language Agent Tree Search for complex pipeline tasks.

Reference:
- Zhou et al., "Language Agent Tree Search Unifies Reasoning Acting
  and Planning in Language Models", arXiv:2310.04406
- Adapted from MARCH/LATS research collected in data/research/v11.6

v13.1 — TaskGroup parallel expansion, early exit, depth cap, model tiering.
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import structlog

from src.ai.agents._shared import call_vllm

logger = structlog.get_logger("LATS")

# Early-exit threshold (0.0–1.0 scale, 0.9 = 9/10)
_EARLY_EXIT_SCORE = 0.9

# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class ThoughtNode:
    """A single node in the search tree."""
    node_id: int
    thought: str
    score: float = 0.0
    parent_id: Optional[int] = None
    children_ids: List[int] = field(default_factory=list)
    depth: int = 0
    action: str = ""
    observation: str = ""
    is_terminal: bool = False


@dataclass
class LATSResult:
    """Aggregated result of the tree-search process."""
    best_answer: str
    best_response: str  # alias kept for _core.py compat
    best_score: float
    nodes_explored: int
    depth_reached: int
    branches_generated: int
    elapsed_sec: float
    early_exit: bool = False
    tree_trace: List[ThoughtNode] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Complexity classifier (heuristic, no LLM call)
# ---------------------------------------------------------------------------

_COMPLEX_KEYWORDS = frozenset([
    "rust", "async", "concurrency", "парсер", "parser", "ffi", "pyo3",
    "refactor", "migrate", "security", "cryptograph", "multi-file",
    "architecture", "design", "optimize", "performance",
    "graph", "tree", "algorithm", "benchmark",
])

_EXTREME_KEYWORDS = frozenset([
    "multi-file", "architecture", "migrate", "refactor",
    "ffi", "pyo3", "cryptograph",
])


def classify_complexity(prompt: str) -> str:
    """Return 'extreme', 'complex', or 'simple' based on keyword heuristics."""
    lower = prompt.lower()
    hits = sum(1 for kw in _COMPLEX_KEYWORDS if kw in lower)
    extreme_hits = sum(1 for kw in _EXTREME_KEYWORDS if kw in lower)
    if extreme_hits >= 2 or (hits >= 3 and len(prompt) > 3000):
        return "extreme"
    if hits >= 2 or len(prompt) > 2000:
        return "complex"
    return "simple"


# ---------------------------------------------------------------------------
# LATS Engine
# ---------------------------------------------------------------------------

class LATSEngine:
    """Tree-search reasoning engine for complex pipeline tasks.

    v13.1 features:
    - TaskGroup parallel branch expansion (all N branches simultaneously)
    - Early exit when any branch scores >= 0.9
    - Depth cap: 2 for complex, 3 only for extreme
    - Model tiering: lightweight model for expand, heavy for evaluate
    """

    _DEFAULT_BRANCHES = 3

    def __init__(
        self,
        vllm_url: str = "",
        model: str = "",
        n_branches: int = _DEFAULT_BRANCHES,
        max_depth: int = 3,
    ):
        self.vllm_url = vllm_url.rstrip("/") if vllm_url else ""
        self.model = model or "meta-llama/llama-3.3-70b-instruct:free"
        self.n_branches = max(2, min(n_branches, 5))
        self.max_depth = max(1, min(max_depth, 5))
        self._node_counter = 0
        self._nodes: Dict[int, ThoughtNode] = {}

        # Model tiering defaults (overridden at search time from config)
        self._expand_model = "google/gemma-3-12b-it:free"     # lightweight
        self._evaluate_model = self.model                      # heavy

    def _next_id(self) -> int:
        self._node_counter += 1
        return self._node_counter

    async def search(
        self,
        prompt: str,
        system_prompt: str = "",
        auditor_system: str = "",
        *,
        model: str = "",
        config: Optional[Dict[str, Any]] = None,
    ) -> LATSResult:
        """Run tree search: expand → evaluate → select best branch.

        Accepts both positional (system_prompt, auditor_system) and
        keyword (model, config) arguments for backward compatibility.
        """
        start = time.monotonic()
        self._node_counter = 0
        self._nodes = {}

        # Override models from config if provided
        if model:
            self._evaluate_model = model
        if config:
            router_cfg = config.get("model_router", {})
            self._expand_model = router_cfg.get(
                "expand", "google/gemma-3-12b-it:free",
            )

        # Depth cap: 2 for standard complex, 3 only for extreme
        complexity = classify_complexity(prompt)
        effective_depth = 3 if complexity == "extreme" else 2
        effective_depth = min(effective_depth, self.max_depth)
        logger.info("lats_config", depth=effective_depth, complexity=complexity,
                     expand_model=self._expand_model, eval_model=self._evaluate_model)

        # Root node
        root = ThoughtNode(node_id=self._next_id(), thought="[ROOT]", depth=0)
        self._nodes[root.node_id] = root

        best_answer = ""
        best_score = -1.0
        total_branches = 0
        early_exit = False

        current_nodes = [root]

        for depth in range(1, effective_depth + 1):
            next_level_nodes: List[ThoughtNode] = []

            for parent in current_nodes:
                # --- Expansion: generate N candidates IN PARALLEL via TaskGroup ---
                candidates = await self._expand_parallel(prompt, parent, system_prompt)
                total_branches += len(candidates)

                for cand in candidates:
                    cand.parent_id = parent.node_id
                    cand.depth = depth
                    parent.children_ids.append(cand.node_id)
                    self._nodes[cand.node_id] = cand

                # --- Evaluation: score ALL candidates IN PARALLEL ---
                scores = await self._evaluate_parallel(
                    prompt, candidates, auditor_system or system_prompt,
                )
                for cand, score in zip(candidates, scores):
                    cand.score = score
                    if score > best_score:
                        best_score = score
                        best_answer = cand.thought

                    # --- EARLY EXIT: score >= 0.9 → stop immediately ---
                    if score >= _EARLY_EXIT_SCORE:
                        logger.info(
                            "[LATS] Early exit triggered",
                            score=round(score * 10, 1),
                            depth=depth,
                        )
                        early_exit = True
                        break

                if early_exit:
                    break

                # --- Selection: keep top-1 branch ---
                if candidates:
                    best_cand = max(candidates, key=lambda n: n.score)
                    next_level_nodes.append(best_cand)
                    logger.info(
                        "lats_select",
                        depth=depth,
                        best_score=round(best_cand.score, 3),
                        candidates=len(candidates),
                    )

            if early_exit or not next_level_nodes:
                break
            current_nodes = next_level_nodes

        elapsed = time.monotonic() - start
        logger.info("lats_done", elapsed=round(elapsed, 2), nodes=len(self._nodes),
                     best_score=round(best_score, 3), early_exit=early_exit)
        return LATSResult(
            best_answer=best_answer,
            best_response=best_answer,
            best_score=round(best_score, 3),
            nodes_explored=len(self._nodes),
            depth_reached=min(effective_depth, max((n.depth for n in self._nodes.values()), default=0)),
            branches_generated=total_branches,
            elapsed_sec=round(elapsed, 2),
            early_exit=early_exit,
            tree_trace=list(self._nodes.values()),
        )

    # ------------------------------------------------------------------
    # Parallel expansion — generate N branches simultaneously
    # ------------------------------------------------------------------

    async def _expand_parallel(
        self,
        prompt: str,
        parent: ThoughtNode,
        system_prompt: str,
    ) -> List[ThoughtNode]:
        """Generate self.n_branches candidate thoughts using TaskGroup."""
        context = self._build_path_context(parent)

        async def _gen_one(idx: int) -> ThoughtNode:
            gen_prompt = (
                f"Task:\n{prompt}\n\n"
                f"Previous reasoning path:\n{context}\n\n"
                f"Generate approach #{idx + 1} to solve this task. "
                f"Be specific and concrete in 2-4 sentences."
            )
            raw = await call_vllm(
                self.vllm_url,
                self._expand_model,
                [
                    {"role": "system", "content": system_prompt or "You are an expert problem-solver."},
                    {"role": "user", "content": gen_prompt},
                ],
                temperature=0.7 + idx * 0.1,  # diversity via temperature spread
                max_tokens=512,
            )
            return ThoughtNode(
                node_id=self._next_id(),
                thought=raw.strip()[:800] or f"[Approach {idx + 1}]",
            )

        tasks = [_gen_one(i) for i in range(self.n_branches)]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        nodes = []
        for r in results:
            if isinstance(r, ThoughtNode):
                nodes.append(r)
            else:
                logger.warning("lats_expand_error", error=str(r))
                nodes.append(ThoughtNode(
                    node_id=self._next_id(),
                    thought="[expansion failed]",
                ))
        return nodes

    # ------------------------------------------------------------------
    # Parallel evaluation — score all candidates simultaneously
    # ------------------------------------------------------------------

    async def _evaluate_parallel(
        self,
        prompt: str,
        candidates: List[ThoughtNode],
        auditor_system: str,
    ) -> List[float]:
        """Score all candidates in parallel using TaskGroup."""

        async def _score_one(node: ThoughtNode) -> float:
            eval_prompt = (
                f"Task:\n{prompt}\n\n"
                f"Proposed approach:\n{node.thought}\n\n"
                "Rate this approach from 0.0 (terrible) to 1.0 (excellent). "
                "Consider: correctness, feasibility, completeness, efficiency.\n"
                "Reply with ONLY a single float number, e.g. 0.75"
            )
            raw = await call_vllm(
                self.vllm_url,
                self._evaluate_model,
                [
                    {"role": "system", "content": auditor_system or "You are a strict code reviewer scoring approaches."},
                    {"role": "user", "content": eval_prompt},
                ],
                temperature=0.1,
                max_tokens=32,
            )
            return self._parse_score(raw)

        tasks = [_score_one(c) for c in candidates]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        scores = []
        for r in results:
            if isinstance(r, float):
                scores.append(r)
            else:
                logger.warning("lats_eval_error", error=str(r))
                scores.append(0.5)
        return scores

    @staticmethod
    def _parse_score(raw: str) -> float:
        """Extract a float score from LLM output."""
        m = re.search(r"(0\.\d+|1\.0|0|1)", raw.strip())
        if m:
            try:
                return max(0.0, min(1.0, float(m.group(1))))
            except ValueError:
                pass
        return 0.5  # default middle score

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _build_path_context(self, node: ThoughtNode) -> str:
        """Reconstruct the reasoning path from root to this node."""
        path: List[str] = []
        current: Optional[ThoughtNode] = node
        while current and current.thought != "[ROOT]":
            path.append(current.thought)
            current = self._nodes.get(current.parent_id) if current.parent_id else None
        path.reverse()
        return "\n→ ".join(path) if path else "[Start]"
