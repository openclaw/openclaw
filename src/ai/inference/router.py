"""Smart model router — task-aware model selection.

References: Phi-3 Technical Report, Small Language Models Survey, Scaling Laws.
UCB1 exploration: Auer et al., "Finite-time Analysis of the Multiarmed Bandit Problem".
"""

import math
import re
from collections import defaultdict
from typing import Any, Dict, List

from src.ai.inference._shared import (
    ModelProfile,
    RoutingTask,
    VRAM_TOTAL_GB,
    logger,
)

_CODE_KEYWORDS = re.compile(
    r"\b(code|function|class|debug|refactor|implement|bug|error|traceback|python"
    r"|javascript|typescript|rust|sql|api|endpoint|regex|algorithm)\b",
    re.IGNORECASE,
)
_MATH_KEYWORDS = re.compile(
    r"\b(math|calcul|equation|integral|derivative|probability|statistic"
    r"|matrix|vector|proof|theorem|solve)\b",
    re.IGNORECASE,
)
_CREATIVE_KEYWORDS = re.compile(
    r"\b(write|story|poem|creative|essay|blog|article|fiction|novel"
    r"|brainstorm|imagine)\b",
    re.IGNORECASE,
)

_COMPLEXITY_SIMPLE = "simple"
_COMPLEXITY_MODERATE = "moderate"
_COMPLEXITY_COMPLEX = "complex"


class SmartModelRouter:
    """Intelligent model routing based on task characteristics.

    Includes UCB1 exploration bonus to encourage trying under-explored
    model–task combinations, preventing the router from getting stuck
    on a single model indefinitely.
    """

    # UCB1 exploration parameters
    _UCB1_C = 1.4           # Exploration constant (sqrt(2) ≈ 1.414)
    _UCB1_MAX_EXPLORE_BONUS = 3.0  # Cap on exploration bonus

    def __init__(self, available_models: Dict[str, ModelProfile]) -> None:
        self._models = dict(available_models)
        self._outcomes: Dict[str, Dict[str, Dict[str, float]]] = defaultdict(
            lambda: defaultdict(lambda: {"successes": 0.0, "total": 0.0, "quality_sum": 0.0}),
        )
        self._route_counts: Dict[str, int] = defaultdict(int)
        self._total_routes: int = 0  # Total routes across all models

        logger.info(
            "SmartModelRouter initialised",
            models=[m.name for m in self._models.values()],
        )

    def route(self, task: RoutingTask) -> str:
        if task.preferred_model and task.preferred_model in self._models:
            self._route_counts[task.preferred_model] += 1
            self._total_routes += 1
            return task.preferred_model

        task_type = self._classify_task(task)
        complexity = self._estimate_complexity(task)

        scored: List[tuple[float, str]] = []
        for name, profile in self._models.items():
            score = self._score_model(profile, task_type, complexity)
            # UCB1 exploration bonus for under-explored models
            score += self._ucb1_bonus(name)
            scored.append((score, name))

        scored.sort(key=lambda t: t[0], reverse=True)
        chosen = scored[0][1] if scored else next(iter(self._models))

        self._route_counts[chosen] += 1
        self._total_routes += 1
        logger.info(
            "Model routed",
            model=chosen,
            task_type=task_type,
            complexity=complexity,
            score=round(scored[0][0], 3) if scored else 0,
        )
        return chosen

    def record_outcome(
        self, model: str, task_type: str, success: bool, quality_score: float
    ) -> None:
        entry = self._outcomes[model][task_type]
        entry["total"] += 1
        entry["quality_sum"] += quality_score
        if success:
            entry["successes"] += 1

    def get_routing_stats(self) -> Dict[str, Any]:
        stats: Dict[str, Any] = {"route_counts": dict(self._route_counts)}
        per_model: Dict[str, Any] = {}
        for model, tasks in self._outcomes.items():
            model_stats: Dict[str, Any] = {}
            for ttype, vals in tasks.items():
                total = vals["total"]
                model_stats[ttype] = {
                    "total": int(total),
                    "success_rate": vals["successes"] / total if total else 0.0,
                    "avg_quality": vals["quality_sum"] / total if total else 0.0,
                }
            per_model[model] = model_stats
        stats["model_outcomes"] = per_model
        return stats

    def _classify_task(self, task: RoutingTask) -> str:
        if task.task_type and task.task_type != "general":
            return task.task_type
        text = task.prompt
        if _CODE_KEYWORDS.search(text):
            return "code"
        if _MATH_KEYWORDS.search(text):
            return "math"
        if _CREATIVE_KEYWORDS.search(text):
            return "creative"
        return "general"

    @staticmethod
    def _estimate_complexity(task: RoutingTask) -> str:
        if task.complexity_hint:
            return task.complexity_hint
        length = len(task.prompt)
        if length < 60:
            return _COMPLEXITY_SIMPLE
        if length < 300:
            return _COMPLEXITY_MODERATE
        return _COMPLEXITY_COMPLEX

    def _score_model(self, profile: ModelProfile, task_type: str, complexity: str) -> float:
        score = 0.0
        # Stronger specialization bonus for capability match
        if task_type in profile.capabilities:
            score += 4.0

        speed_map = {"fast": 2.0, "medium": 1.0, "slow": 0.5}
        quality_map = {"high": 2.5, "medium": 1.0, "low": 0.5}

        if complexity == _COMPLEXITY_SIMPLE:
            score += speed_map.get(profile.speed_tier, 1.0) * 1.5
            score += quality_map.get(profile.quality_tier, 1.0) * 0.5
        elif complexity == _COMPLEXITY_COMPLEX:
            # Strongly prefer quality for complex tasks
            score += speed_map.get(profile.speed_tier, 1.0) * 0.3
            score += quality_map.get(profile.quality_tier, 1.0) * 2.0
        else:
            score += speed_map.get(profile.speed_tier, 1.0)
            score += quality_map.get(profile.quality_tier, 1.0)

        if profile.vram_gb > VRAM_TOTAL_GB * 0.9:
            score -= 1.0

        history = self._outcomes.get(profile.name, {}).get(task_type)
        if history and history["total"] >= 3:
            avg_q = history["quality_sum"] / history["total"]
            score += avg_q

        return score

    def _ucb1_bonus(self, model_name: str) -> float:
        """UCB1 exploration bonus: encourages trying under-explored models.

        Returns higher bonus when a model has been tried fewer times
        relative to the total number of routes.
        """
        if self._total_routes < 2:
            return 0.0
        n_i = max(self._route_counts.get(model_name, 0), 1)
        bonus = self._UCB1_C * math.sqrt(math.log(self._total_routes) / n_i)
        return min(bonus, self._UCB1_MAX_EXPLORE_BONUS)
