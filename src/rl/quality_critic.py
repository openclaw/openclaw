"""Quality Critic — multi-evaluation and quality filtering for prompt variants.

Inspired by:
- SAGE (arXiv:2603.15255): Critic agent scores and filters low-quality outputs
- AFlow (ICLR 2025): 5x evaluation per state for robustness
- Complementary RL (arXiv:2603.17621): co-evolution of experience extraction

Key innovations:
1. Multi-evaluation: run each variant N times, use mean (not single noisy eval)
2. Quality filtering: reject mutations that don't improve over parent
3. Confidence scoring: track variance to know when evaluation is reliable
4. Co-evolution tracker: which prompt+few-shot combos work best together
5. Automatic rollback: revert to previous best on quality collapse

References:
- SAGE: Multi-Agent Self-Evolution (arXiv:2603.15255)
- AFlow: Automating Agentic Workflow Generation (ICLR 2025)
- Complementary RL (arXiv:2603.17621)
"""

from __future__ import annotations

import math
import os
import sqlite3
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import structlog

logger = structlog.get_logger("QualityCritic")


# ---------------------------------------------------------------------------
# Multi-Evaluation Engine (AFlow: 5x evaluation for robustness)
# ---------------------------------------------------------------------------

@dataclass
class EvaluationResult:
    """Result of a single evaluation run."""
    score: float
    breakdown: Dict[str, float] = field(default_factory=dict)
    latency_ms: float = 0.0
    timestamp: float = field(default_factory=time.time)


@dataclass
class MultiEvalResult:
    """Aggregated result of multiple evaluations."""
    variant_id: str
    evaluations: List[EvaluationResult] = field(default_factory=list)

    @property
    def n_evals(self) -> int:
        return len(self.evaluations)

    @property
    def mean_score(self) -> float:
        if not self.evaluations:
            return 0.0
        return sum(e.score for e in self.evaluations) / len(self.evaluations)

    @property
    def std_score(self) -> float:
        if len(self.evaluations) < 2:
            return 0.0
        mean = self.mean_score
        variance = sum((e.score - mean) ** 2 for e in self.evaluations) / (len(self.evaluations) - 1)
        return math.sqrt(variance)

    @property
    def confidence(self) -> float:
        """Confidence in the mean score (0.0-1.0).
        Higher n_evals + lower std = higher confidence.
        """
        if self.n_evals == 0:
            return 0.0
        # Confidence increases with number of evals and decreases with variance
        n_factor = min(1.0, self.n_evals / 5.0)  # saturate at 5 evals
        std_factor = max(0.0, 1.0 - self.std_score * 2)
        return n_factor * 0.6 + std_factor * 0.4

    @property
    def min_score(self) -> float:
        return min((e.score for e in self.evaluations), default=0.0)

    @property
    def max_score(self) -> float:
        return max((e.score for e in self.evaluations), default=0.0)

    def add(self, score: float, breakdown: Optional[Dict[str, float]] = None,
            latency_ms: float = 0.0) -> None:
        self.evaluations.append(EvaluationResult(
            score=score,
            breakdown=breakdown or {},
            latency_ms=latency_ms,
        ))


class MultiEvaluator:
    """Run multiple evaluations for robustness (AFlow-inspired).

    AFlow insight: running evaluation 5 times and averaging reduces
    noise from LLM stochasticity, giving more reliable scores
    even though it costs more API calls per iteration.

    In our budget-conscious API setting, default is 3 evaluations.
    """

    def __init__(self, n_evaluations: int = 3) -> None:
        self._n_evaluations = n_evaluations
        self._results: Dict[str, MultiEvalResult] = {}

    def record(
        self,
        variant_id: str,
        score: float,
        breakdown: Optional[Dict[str, float]] = None,
        latency_ms: float = 0.0,
    ) -> MultiEvalResult:
        """Record a single evaluation for a variant."""
        if variant_id not in self._results:
            self._results[variant_id] = MultiEvalResult(variant_id=variant_id)
        result = self._results[variant_id]
        result.add(score, breakdown, latency_ms)
        return result

    def needs_more_evals(self, variant_id: str) -> bool:
        """Check if variant needs more evaluations."""
        result = self._results.get(variant_id)
        if not result:
            return True
        return result.n_evals < self._n_evaluations

    def get_result(self, variant_id: str) -> Optional[MultiEvalResult]:
        return self._results.get(variant_id)

    def get_reliable_results(self, min_confidence: float = 0.5) -> List[MultiEvalResult]:
        """Get results with sufficient confidence."""
        return [
            r for r in self._results.values()
            if r.confidence >= min_confidence
        ]

    def get_all_results(self) -> Dict[str, MultiEvalResult]:
        return dict(self._results)


# ---------------------------------------------------------------------------
# Quality Critic (SAGE Critic-inspired)
# ---------------------------------------------------------------------------

class QualityCritic:
    """Filters low-quality prompt mutations.

    SAGE insight: a dedicated Critic agent prevents the system from
    drifting toward degenerate solutions. In our setting, the Critic
    is rule-based (no extra LLM call) to save API costs.

    Rejection criteria:
    1. Score below parent's mean (no improvement)
    2. Score below absolute minimum threshold
    3. High variance (unreliable mutation)
    4. Prompt became degenerate (too short/long, lost structure)
    """

    def __init__(
        self,
        min_absolute_score: float = 0.25,
        improvement_threshold: float = -0.05,  # allow slight regression
        max_variance_threshold: float = 0.15,
        min_prompt_length: int = 20,
        max_prompt_length: int = 3000,
    ) -> None:
        self._min_score = min_absolute_score
        self._improvement_threshold = improvement_threshold
        self._max_variance = max_variance_threshold
        self._min_prompt_len = min_prompt_length
        self._max_prompt_len = max_prompt_length
        self._decisions: List[Dict[str, Any]] = []

    def evaluate(
        self,
        candidate: MultiEvalResult,
        parent: Optional[MultiEvalResult],
        prompt_text: str,
    ) -> Tuple[bool, str]:
        """Evaluate whether a prompt variant should be accepted.

        Returns (accepted: bool, reason: str).
        """
        decision: Dict[str, Any] = {
            "variant_id": candidate.variant_id,
            "score": candidate.mean_score,
            "n_evals": candidate.n_evals,
            "timestamp": time.time(),
        }

        # Check 1: Absolute score minimum
        if candidate.mean_score < self._min_score:
            decision.update(accepted=False, reason="below_min_score")
            self._decisions.append(decision)
            return False, f"Отклонено: score {candidate.mean_score:.3f} < min {self._min_score}"

        # Check 2: Prompt degeneracy
        if len(prompt_text) < self._min_prompt_len:
            decision.update(accepted=False, reason="prompt_too_short")
            self._decisions.append(decision)
            return False, f"Отклонено: промпт слишком короткий ({len(prompt_text)} символов)"

        if len(prompt_text) > self._max_prompt_len:
            decision.update(accepted=False, reason="prompt_too_long")
            self._decisions.append(decision)
            return False, f"Отклонено: промпт слишком длинный ({len(prompt_text)} символов)"

        # Check 3: Improvement over parent
        if parent and parent.n_evals > 0:
            improvement = candidate.mean_score - parent.mean_score
            if improvement < self._improvement_threshold:
                decision.update(accepted=False, reason="no_improvement",
                                improvement=improvement)
                self._decisions.append(decision)
                return False, (
                    f"Отклонено: нет улучшения "
                    f"({candidate.mean_score:.3f} vs parent {parent.mean_score:.3f}, "
                    f"Δ={improvement:+.3f})"
                )

        # Check 4: High variance (unreliable)
        if candidate.n_evals >= 3 and candidate.std_score > self._max_variance:
            decision.update(accepted=False, reason="high_variance",
                            std=candidate.std_score)
            self._decisions.append(decision)
            return False, f"Отклонено: высокая вариативность (std={candidate.std_score:.3f})"

        # Accepted
        decision.update(accepted=True, reason="passed_all_checks")
        self._decisions.append(decision)
        return True, f"Принято: score={candidate.mean_score:.3f} (±{candidate.std_score:.3f})"

    def get_acceptance_rate(self) -> float:
        """Proportion of accepted variants."""
        if not self._decisions:
            return 0.0
        accepted = sum(1 for d in self._decisions if d.get("accepted"))
        return accepted / len(self._decisions)

    def get_rejection_reasons(self) -> Dict[str, int]:
        """Count of rejection reasons."""
        reasons: Dict[str, int] = {}
        for d in self._decisions:
            if not d.get("accepted"):
                reason = d.get("reason", "unknown")
                reasons[reason] = reasons.get(reason, 0) + 1
        return reasons

    def get_stats(self) -> Dict[str, Any]:
        return {
            "total_evaluated": len(self._decisions),
            "acceptance_rate": self.get_acceptance_rate(),
            "rejection_reasons": self.get_rejection_reasons(),
        }


# ---------------------------------------------------------------------------
# Co-Evolution Tracker (Complementary RL inspired)
# ---------------------------------------------------------------------------

class CoEvolutionTracker:
    """Track which prompt + few-shot combinations work best together.

    Complementary RL insight: the experience extractor (few-shot selector)
    should be optimized based on whether its selected examples actually
    IMPROVE the actor's (model) performance with the given prompt.

    This tracker records (prompt_variant, few_shot_set, score) triples
    and learns which combinations are synergistic.
    """

    def __init__(self, db_path: str = "data/rl/coevolution.db") -> None:
        self._db_path = db_path
        self._conn: Optional[sqlite3.Connection] = None

    def initialize(self) -> None:
        os.makedirs(os.path.dirname(self._db_path) or ".", exist_ok=True)
        self._conn = sqlite3.connect(self._db_path)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS coevolution (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                prompt_variant_id TEXT NOT NULL,
                few_shot_ids TEXT NOT NULL,
                task_type TEXT NOT NULL,
                score REAL NOT NULL,
                score_delta REAL DEFAULT 0.0,
                timestamp REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_coevo_prompt
                ON coevolution(prompt_variant_id);
            CREATE INDEX IF NOT EXISTS idx_coevo_task
                ON coevolution(task_type);
        """)
        self._conn.commit()

    def _ensure_init(self) -> None:
        if self._conn is None:
            self.initialize()

    def record(
        self,
        prompt_variant_id: str,
        few_shot_ids: List[str],
        task_type: str,
        score: float,
        baseline_score: float = 0.0,
    ) -> None:
        """Record a prompt+few-shot combination result."""
        self._ensure_init()
        assert self._conn is not None

        score_delta = score - baseline_score
        self._conn.execute(
            """INSERT INTO coevolution
               (prompt_variant_id, few_shot_ids, task_type, score, score_delta, timestamp)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                prompt_variant_id,
                ",".join(few_shot_ids),
                task_type,
                score,
                score_delta,
                time.time(),
            ),
        )
        self._conn.commit()

    def get_best_few_shots_for_prompt(
        self, prompt_variant_id: str, task_type: str = "", top_n: int = 3,
    ) -> List[Tuple[List[str], float]]:
        """Get the best few-shot combinations for a given prompt variant.

        Returns list of (few_shot_ids, mean_score).
        """
        self._ensure_init()
        assert self._conn is not None

        query = """
            SELECT few_shot_ids, AVG(score) as mean_score, COUNT(*) as n
            FROM coevolution
            WHERE prompt_variant_id = ?
        """
        params: list = [prompt_variant_id]
        if task_type:
            query += " AND task_type = ?"
            params.append(task_type)

        query += " GROUP BY few_shot_ids HAVING n >= 1 ORDER BY mean_score DESC LIMIT ?"
        params.append(top_n)

        rows = self._conn.execute(query, params).fetchall()
        return [
            (row[0].split(",") if row[0] else [], row[1])
            for row in rows
        ]

    def get_synergy_score(
        self, prompt_variant_id: str, few_shot_ids: List[str],
    ) -> float:
        """Get the average score delta when using this specific combination."""
        self._ensure_init()
        assert self._conn is not None

        fs_key = ",".join(sorted(few_shot_ids))
        row = self._conn.execute(
            "SELECT AVG(score_delta) FROM coevolution WHERE prompt_variant_id = ? AND few_shot_ids = ?",
            (prompt_variant_id, fs_key),
        ).fetchone()
        return row[0] if row and row[0] is not None else 0.0

    def get_stats(self) -> Dict[str, Any]:
        """Co-evolution statistics."""
        self._ensure_init()
        assert self._conn is not None

        total = self._conn.execute("SELECT COUNT(*) FROM coevolution").fetchone()[0]
        positive = self._conn.execute(
            "SELECT COUNT(*) FROM coevolution WHERE score_delta > 0"
        ).fetchone()[0]
        mean_delta = self._conn.execute(
            "SELECT AVG(score_delta) FROM coevolution"
        ).fetchone()[0] or 0.0

        return {
            "total_records": total,
            "positive_synergies": positive,
            "negative_synergies": total - positive,
            "mean_score_delta": mean_delta,
            "synergy_rate": positive / total if total > 0 else 0.0,
        }

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None
