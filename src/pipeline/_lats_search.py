"""LATS — Language Agent Tree Search for complex pipeline tasks.

Reference:
- Zhou et al., "Language Agent Tree Search Unifies Reasoning Acting
  and Planning in Language Models", arXiv:2310.04406
- Adapted from MARCH/LATS research collected in data/research/v11.6

When Complexity=Complex, the agent generates N candidate "Thought" branches,
scores them via the Auditor (value function), and continues only with the
best-scoring branch.  Falls back to linear ReAct for simple tasks.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import structlog

from src.ai.agents._shared import call_vllm

logger = structlog.get_logger("LATS")


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
    best_score: float
    nodes_explored: int
    depth_reached: int
    branches_generated: int
    elapsed_sec: float
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


def classify_complexity(prompt: str) -> str:
    """Return 'complex' or 'simple' based on keyword heuristics."""
    lower = prompt.lower()
    hits = sum(1 for kw in _COMPLEX_KEYWORDS if kw in lower)
    if hits >= 2 or len(prompt) > 2000:
        return "complex"
    return "simple"


# ---------------------------------------------------------------------------
# LATS Engine
# ---------------------------------------------------------------------------

class LATSEngine:
    """Tree-search reasoning engine for complex pipeline tasks.

    Usage inside PipelineExecutor.execute():
        engine = LATSEngine(vllm_url, model)
        if classify_complexity(prompt) == "complex":
            result = await engine.search(prompt, system_prompt)
            # use result.best_answer
    """

    _DEFAULT_BRANCHES = 3
    _MAX_DEPTH = 3

    def __init__(
        self,
        vllm_url: str = "",
        model: str = "",
        n_branches: int = _DEFAULT_BRANCHES,
        max_depth: int = _MAX_DEPTH,
    ):
        self.vllm_url = vllm_url.rstrip("/") if vllm_url else ""
        self.model = model or "meta-llama/llama-3.3-70b-instruct:free"
        self.n_branches = max(2, min(n_branches, 5))
        self.max_depth = max(1, min(max_depth, 5))
        self._node_counter = 0
        self._nodes: Dict[int, ThoughtNode] = {}

    def _next_id(self) -> int:
        self._node_counter += 1
        return self._node_counter

    async def search(
        self,
        prompt: str,
        system_prompt: str = "",
        auditor_system: str = "",
    ) -> LATSResult:
        """Run tree search: expand → evaluate → select best branch."""
        start = time.monotonic()
        self._node_counter = 0
        self._nodes = {}

        # Root node
        root = ThoughtNode(node_id=self._next_id(), thought="[ROOT]", depth=0)
        self._nodes[root.node_id] = root

        best_answer = ""
        best_score = -1.0
        total_branches = 0

        current_nodes = [root]

        for depth in range(1, self.max_depth + 1):
            next_level_nodes: List[ThoughtNode] = []

            for parent in current_nodes:
                # --- Expansion: generate N candidate thoughts ---
                candidates = await self._expand(prompt, parent, system_prompt)
                total_branches += len(candidates)

                for cand in candidates:
                    cand.parent_id = parent.node_id
                    cand.depth = depth
                    parent.children_ids.append(cand.node_id)
                    self._nodes[cand.node_id] = cand

                # --- Evaluation: score each candidate via auditor ---
                for cand in candidates:
                    cand.score = await self._evaluate(
                        prompt, cand, auditor_system or system_prompt,
                    )
                    if cand.score > best_score:
                        best_score = cand.score
                        best_answer = cand.thought

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

            if not next_level_nodes:
                break
            current_nodes = next_level_nodes

        elapsed = time.monotonic() - start
        return LATSResult(
            best_answer=best_answer,
            best_score=round(best_score, 3),
            nodes_explored=len(self._nodes),
            depth_reached=min(self.max_depth, max((n.depth for n in self._nodes.values()), default=0)),
            branches_generated=total_branches,
            elapsed_sec=round(elapsed, 2),
            tree_trace=list(self._nodes.values()),
        )

    # ------------------------------------------------------------------
    # Expansion — generate N diverse thoughts
    # ------------------------------------------------------------------

    async def _expand(
        self,
        prompt: str,
        parent: ThoughtNode,
        system_prompt: str,
    ) -> List[ThoughtNode]:
        """Generate self.n_branches candidate thoughts for a parent node."""
        context = self._build_path_context(parent)
        expand_prompt = (
            f"Task:\n{prompt}\n\n"
            f"Previous reasoning path:\n{context}\n\n"
            f"Generate {self.n_branches} DIFFERENT approaches to solve this task. "
            f"Label each approach as [Approach 1], [Approach 2], etc. "
            f"Each approach should be 2-4 sentences describing the strategy."
        )

        raw = await call_vllm(
            self.vllm_url,
            self.model,
            [
                {"role": "system", "content": system_prompt or "You are an expert problem-solver."},
                {"role": "user", "content": expand_prompt},
            ],
            temperature=0.7,
            max_tokens=1024,
        )

        return self._parse_branches(raw)

    def _parse_branches(self, raw: str) -> List[ThoughtNode]:
        """Parse numbered approaches from LLM output."""
        nodes: List[ThoughtNode] = []
        current_text = ""
        for line in raw.splitlines():
            stripped = line.strip()
            if stripped.lower().startswith(("[approach", "approach")):
                if current_text.strip():
                    nodes.append(ThoughtNode(
                        node_id=self._next_id(),
                        thought=current_text.strip(),
                    ))
                current_text = stripped
            else:
                current_text += " " + stripped

        if current_text.strip():
            nodes.append(ThoughtNode(
                node_id=self._next_id(),
                thought=current_text.strip(),
            ))

        # Ensure at least 1 node
        if not nodes:
            nodes.append(ThoughtNode(
                node_id=self._next_id(),
                thought=raw.strip()[:500] or "[No approach parsed]",
            ))

        return nodes[:self.n_branches]

    # ------------------------------------------------------------------
    # Evaluation — score via auditor value function
    # ------------------------------------------------------------------

    async def _evaluate(
        self,
        prompt: str,
        node: ThoughtNode,
        auditor_system: str,
    ) -> float:
        """Score a thought node 0.0-1.0 using the auditor as value function."""
        eval_prompt = (
            f"Task:\n{prompt}\n\n"
            f"Proposed approach:\n{node.thought}\n\n"
            "Rate this approach from 0.0 (terrible) to 1.0 (excellent). "
            "Consider: correctness, feasibility, completeness, efficiency.\n"
            "Reply with ONLY a single float number, e.g. 0.75"
        )

        raw = await call_vllm(
            self.vllm_url,
            self.model,
            [
                {"role": "system", "content": auditor_system or "You are a strict code reviewer scoring approaches."},
                {"role": "user", "content": eval_prompt},
            ],
            temperature=0.1,
            max_tokens=32,
        )

        return self._parse_score(raw)

    @staticmethod
    def _parse_score(raw: str) -> float:
        """Extract a float score from LLM output."""
        import re
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
