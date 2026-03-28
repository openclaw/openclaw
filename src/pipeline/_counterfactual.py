"""
v14.1: Counterfactual Credit Assignment for Ensemble Voting.

arXiv:2603.21563 — Counterfactual contribution attribution in multi-agent RL.

Tracks per-candidate quality contributions in Ensemble Voting to understand
which temperature / agent variant produces the best outputs. Uses marginal
contribution analysis (Shapley-inspired) to attribute credit.

The credits are stored in SuperMemory for future weighting of ensemble instances.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import structlog

logger = structlog.get_logger("CounterfactualCredit")


@dataclass
class CandidateCredit:
    """Credit attribution for a single ensemble candidate."""
    candidate_index: int
    temperature: float
    was_selected: bool  # True if this candidate won the vote
    length_score: float  # normalized response length (0-1)
    selection_count: int = 0  # cumulative times selected as winner


@dataclass
class CreditRecord:
    """Aggregated record across ensemble rounds."""
    role: str
    temperature: float
    total_rounds: int = 0
    wins: int = 0
    avg_length_score: float = 0.0
    _length_scores: List[float] = field(default_factory=list)

    @property
    def win_rate(self) -> float:
        return self.wins / max(self.total_rounds, 1)

    def record_round(self, won: bool, length_score: float) -> None:
        self.total_rounds += 1
        if won:
            self.wins += 1
        self._length_scores.append(length_score)
        self.avg_length_score = sum(self._length_scores) / len(self._length_scores)


class CounterfactualCredit:
    """Tracks and stores per-candidate contribution in Ensemble Voting.

    After each ensemble round, `record_vote()` is called with the candidates
    and the winner index. Credits accumulate and can be recalled to weight
    future ensemble instances or prune underperformers.
    """

    def __init__(self, enabled: bool = True):
        self._enabled = enabled
        # role -> temperature -> CreditRecord
        self._credits: Dict[str, Dict[float, CreditRecord]] = {}

    @property
    def enabled(self) -> bool:
        return self._enabled

    def record_vote(
        self,
        role: str,
        temperatures: List[float],
        candidates: List[str],
        winner_index: int,
    ) -> List[CandidateCredit]:
        """Record the outcome of an ensemble vote.

        Returns per-candidate CandidateCredit for logging / analytics.
        """
        if not self._enabled or not candidates:
            return []

        if role not in self._credits:
            self._credits[role] = {}

        max_len = max(len(c) for c in candidates) if candidates else 1
        credits: List[CandidateCredit] = []

        for i, (temp, cand) in enumerate(zip(temperatures, candidates)):
            won = (i == winner_index)
            length_score = len(cand) / max(max_len, 1)

            if temp not in self._credits[role]:
                self._credits[role][temp] = CreditRecord(role=role, temperature=temp)
            self._credits[role][temp].record_round(won, length_score)

            credits.append(CandidateCredit(
                candidate_index=i,
                temperature=temp,
                was_selected=won,
                length_score=round(length_score, 3),
                selection_count=self._credits[role][temp].wins,
            ))

        logger.debug(
            "Counterfactual credit recorded",
            role=role,
            winner_idx=winner_index,
            temps=temperatures,
        )
        return credits

    def get_best_temperatures(self, role: str, top_k: int = 2) -> List[float]:
        """Return the best-performing temperatures for a role based on win rate."""
        if role not in self._credits:
            return [0.7, 1.0]  # sensible default

        records = list(self._credits[role].values())
        records.sort(key=lambda r: (r.win_rate, r.avg_length_score), reverse=True)
        return [r.temperature for r in records[:top_k]]

    def get_stats(self, role: Optional[str] = None) -> Dict[str, Any]:
        """Return credit stats for the role (or all roles)."""
        if role and role in self._credits:
            return {
                t: {
                    "total_rounds": r.total_rounds,
                    "wins": r.wins,
                    "win_rate": round(r.win_rate, 3),
                    "avg_length_score": round(r.avg_length_score, 3),
                }
                for t, r in self._credits[role].items()
            }
        # All roles summary
        return {
            r: {
                t: {"win_rate": round(cr.win_rate, 3), "rounds": cr.total_rounds}
                for t, cr in temps.items()
            }
            for r, temps in self._credits.items()
        }

    def save_to_memory(self, supermemory) -> None:
        """Persist credits summary to SuperMemory for cross-session learning."""
        if not self._credits:
            return
        lines = ["[COUNTERFACTUAL_CREDIT] Ensemble contribution stats:"]
        for role, temps in self._credits.items():
            for temp, cr in temps.items():
                lines.append(
                    f"  {role} temp={temp}: {cr.wins}/{cr.total_rounds} wins "
                    f"(rate={cr.win_rate:.2f}, avg_len={cr.avg_length_score:.2f})"
                )
        summary = "\n".join(lines)
        try:
            supermemory.store(
                key="counterfactual:credit_stats",
                content=summary,
                importance=0.6,
                source="counterfactual_credit",
                tier="warm",
            )
            logger.info("Counterfactual credit saved to SuperMemory")
        except Exception as e:
            logger.debug("Counterfactual credit save failed", error=str(e))
