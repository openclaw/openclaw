"""
v14.1: ProRL — Lightweight Rollout-as-a-Service.

arXiv:2603.18815 — ProRL: Rollout generation for policy refinement.

Full paper proposes heavy Rollout-as-a-Service infra for RL training.
This is a lightweight adaptation: parallel AFlow chain candidate evaluation
via heuristic scoring to pick the best chain before executing the full pipeline.

Does NOT require training infrastructure — purely inference-time chain selection.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import structlog

logger = structlog.get_logger("ProRL")


@dataclass
class RolloutCandidate:
    """A single rollout candidate (chain variant with score)."""
    chain: List[str]
    source: str  # "aflow" | "heuristic" | "history"
    score: float = 0.0
    latency_ms: float = 0.0


@dataclass
class RolloutResult:
    """Result of parallel rollout evaluation."""
    selected_chain: List[str]
    selected_source: str
    candidates_evaluated: int
    best_score: float
    total_latency_ms: float


# Heuristic weights for chain quality scoring
_ROLE_QUALITY_WEIGHTS: Dict[str, float] = {
    "Planner": 0.9,
    "Foreman": 0.85,
    "Coder": 0.8,
    "Researcher": 0.85,
    "Analyst": 0.75,
    "Executor_Tools": 0.7,
    "Executor_Architect": 0.75,
    "Auditor": 0.95,  # High value — quality check
    "Summarizer": 0.6,
    "State_Manager": 0.5,
    "Archivist": 0.5,
}


class ProRLEngine:
    """Lightweight rollout evaluation for chain selection.

    Given N candidate chains (from AFlow, history, heuristic), scores them
    using heuristic role-quality weights and selects the best one.

    Optionally uses SuperMemory trajectory data to boost chains
    that previously succeeded on similar tasks.
    """

    def __init__(self, enabled: bool = True):
        self._enabled = enabled
        self._evaluation_history: List[RolloutResult] = []

    @property
    def enabled(self) -> bool:
        return self._enabled

    def score_chain(self, chain: List[str], complexity: str = "simple") -> float:
        """Score a chain heuristically based on role quality weights.

        Factors:
        - Sum of role quality weights (normalized by chain length)
        - Bonus for having Auditor (quality gate)
        - Penalty for very long chains on simple tasks
        - Bonus for Planner at start
        """
        if not chain:
            return 0.0

        # Base score from role weights
        role_scores = [_ROLE_QUALITY_WEIGHTS.get(r, 0.5) for r in chain]
        base = sum(role_scores) / len(role_scores)

        # Bonuses / penalties
        has_auditor = any("Auditor" in r for r in chain)
        starts_with_planner = chain[0] in ("Planner", "Foreman")
        is_overlong = len(chain) > 5 and complexity == "simple"

        score = base
        if has_auditor:
            score += 0.1
        if starts_with_planner:
            score += 0.05
        if is_overlong:
            score -= 0.15

        return round(min(1.0, max(0.0, score)), 3)

    def evaluate_candidates(
        self,
        candidates: List[tuple[List[str], str]],  # (chain, source) pairs
        complexity: str = "simple",
        trajectory_bonus: Optional[Dict[str, float]] = None,
    ) -> RolloutResult:
        """Evaluate multiple chain candidates and select the best one.

        trajectory_bonus: dict mapping chain_key -> bonus score from SuperMemory
        (chains that previously succeeded get a boost).

        Returns RolloutResult with the selected chain.
        """
        if not self._enabled or not candidates:
            chain, source = candidates[0] if candidates else (["Planner"], "fallback")
            return RolloutResult(
                selected_chain=chain,
                selected_source=source,
                candidates_evaluated=0,
                best_score=0.0,
                total_latency_ms=0.0,
            )

        t0 = time.monotonic()
        trajectory_bonus = trajectory_bonus or {}

        scored: List[RolloutCandidate] = []
        for chain, source in candidates:
            score = self.score_chain(chain, complexity)

            # Trajectory history bonus
            chain_key = " → ".join(chain)
            if chain_key in trajectory_bonus:
                score = min(1.0, score + trajectory_bonus[chain_key] * 0.2)

            # Source bonus: AFlow-generated chains get a small boost
            if source == "llm":
                score = min(1.0, score + 0.05)

            scored.append(RolloutCandidate(
                chain=chain, source=source, score=score,
            ))

        scored.sort(key=lambda c: -c.score)
        best = scored[0]

        elapsed_ms = (time.monotonic() - t0) * 1000
        result = RolloutResult(
            selected_chain=best.chain,
            selected_source=best.source,
            candidates_evaluated=len(scored),
            best_score=best.score,
            total_latency_ms=round(elapsed_ms, 2),
        )
        self._evaluation_history.append(result)

        logger.debug(
            "ProRL: rollout evaluated",
            candidates=len(scored),
            best_chain=best.chain,
            best_score=best.score,
            source=best.source,
        )
        return result

    def get_stats(self) -> Dict[str, Any]:
        """Return evaluation statistics."""
        if not self._evaluation_history:
            return {"evaluations": 0}
        return {
            "evaluations": len(self._evaluation_history),
            "avg_candidates": round(
                sum(r.candidates_evaluated for r in self._evaluation_history)
                / len(self._evaluation_history), 1
            ),
            "avg_best_score": round(
                sum(r.best_score for r in self._evaluation_history)
                / len(self._evaluation_history), 3
            ),
        }
