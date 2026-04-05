"""Difficulty Curriculum — staged training with adaptive task difficulty.

Inspired by:
- SAGE (arXiv:2603.15255): Challenger agent generates progressively harder tasks
- Demystifying RL for Tool-Using Agents (arXiv:2603.21972): balanced difficulty
  mixture with ~1K sweet spot, staged rewards for smaller models
- AFlow: 5x multi-evaluation for robustness, data split 80/20

Key innovations:
1. Difficulty tiers: EASY → MEDIUM → HARD per category
2. Staged rewards: smaller/weaker models get partial credit for partial success
3. Difficulty-balanced sampling: avoid training collapse on easy tasks
4. Progressive curriculum: start with easy, gradually increase difficulty
5. Stability monitoring: detect and prevent policy degradation

References:
- SAGE: Multi-Agent Self-Evolution (arXiv:2603.15255)
- Demystifying RL Recipe for Tool-Using Agents (arXiv:2603.21972)
"""

from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple

import structlog

from src.rl.benchmark import BENCHMARK_TASKS, BenchmarkCategory, BenchmarkTask

logger = structlog.get_logger("DifficultyCurriculum")


# ---------------------------------------------------------------------------
# Difficulty levels
# ---------------------------------------------------------------------------

class DifficultyLevel(str, Enum):
    EASY = "easy"
    MEDIUM = "medium"
    HARD = "hard"


@dataclass
class DifficultyTask(BenchmarkTask):
    """BenchmarkTask with explicit difficulty annotation."""
    difficulty: DifficultyLevel = DifficultyLevel.MEDIUM
    difficulty_score: float = 0.5  # 0.0 (trivial) to 1.0 (very hard)
    # Per-difficulty staged reward multipliers
    staged_reward_base: float = 0.5  # minimum reward for partial success


# ---------------------------------------------------------------------------
# Task difficulty classifier
# ---------------------------------------------------------------------------

def classify_task_difficulty(task: BenchmarkTask) -> Tuple[DifficultyLevel, float]:
    """Classify a benchmark task's difficulty based on heuristics.

    Factors: prompt length, expected output length, requires code,
    requires analysis, multi-step reasoning.
    """
    score = 0.0

    # Prompt complexity (longer = harder)
    prompt_len = len(task.prompt)
    if prompt_len > 500:
        score += 0.3
    elif prompt_len > 200:
        score += 0.15
    else:
        score += 0.05

    # Code generation is harder
    if task.expects_code:
        score += 0.2

    # More required keywords = more constraints = harder
    n_keywords = len(task.required_keywords)
    score += min(0.15, n_keywords * 0.05)

    # Large min_length = complex output expected
    if task.min_length > 200:
        score += 0.15
    elif task.min_length > 100:
        score += 0.08

    # Multi-part prompts (contains newlines/code blocks)
    if "\n" in task.prompt and "```" in task.prompt:
        score += 0.15

    # Reference answer suggests precise evaluation
    if task.reference:
        score += 0.1

    score = min(1.0, score)

    if score <= 0.3:
        level = DifficultyLevel.EASY
    elif score <= 0.6:
        level = DifficultyLevel.MEDIUM
    else:
        level = DifficultyLevel.HARD

    return level, score


def create_difficulty_tasks() -> List[DifficultyTask]:
    """Convert all benchmark tasks to difficulty-annotated tasks."""
    result = []
    for task in BENCHMARK_TASKS:
        level, score = classify_task_difficulty(task)
        dt = DifficultyTask(
            task_id=task.task_id,
            category=task.category,
            prompt=task.prompt,
            required_keywords=task.required_keywords,
            forbidden_keywords=task.forbidden_keywords,
            min_length=task.min_length,
            max_length=task.max_length,
            expects_code=task.expects_code,
            expects_json=task.expects_json,
            expects_russian=task.expects_russian,
            reference=task.reference,
            weight=task.weight,
            difficulty=level,
            difficulty_score=score,
        )
        result.append(dt)
    return result


# ---------------------------------------------------------------------------
# Additional harder tasks (SAGE Challenger-inspired)
# ---------------------------------------------------------------------------

HARD_TASKS: List[DifficultyTask] = [
    DifficultyTask(
        task_id="hard_code_01_concurrent_cache",
        category=BenchmarkCategory.CODE,
        prompt=(
            "Реализуй thread-safe LRU-кэш на Python с фиксированной ёмкостью.\n"
            "Требования:\n"
            "- get(key) и put(key, value) за O(1)\n"
            "- Потокобезопасность через threading.Lock\n"
            "- Тесты (минимум 3 теста)\n"
            "- Type hints и docstring обязательны"
        ),
        required_keywords=["class", "def get", "def put", "Lock", "OrderedDict"],
        expects_code=True,
        min_length=300,
        difficulty=DifficultyLevel.HARD,
        difficulty_score=0.85,
    ),
    DifficultyTask(
        task_id="hard_code_02_parser",
        category=BenchmarkCategory.CODE,
        prompt=(
            "Напиши рекурсивный парсер для простого математического выражения.\n"
            "Поддержка: +, -, *, /, скобки, целые числа.\n"
            "Пример: parse('(2 + 3) * 4') → 20\n"
            "Без eval/exec. Только рекурсивный спуск."
        ),
        required_keywords=["def parse", "def", "return"],
        expects_code=True,
        min_length=200,
        difficulty=DifficultyLevel.HARD,
        difficulty_score=0.9,
    ),
    DifficultyTask(
        task_id="hard_research_01_tradeoffs",
        category=BenchmarkCategory.RESEARCH,
        prompt=(
            "Сравни 4 подхода к масштабированию LLM-инференса:\n"
            "1. Tensor Parallelism\n"
            "2. Pipeline Parallelism\n"
            "3. Speculative Decoding\n"
            "4. vLLM PagedAttention\n\n"
            "Для каждого: когда использовать, latency/throughput tradeoff, "
            "ограничения. Таблица сравнения обязательна."
        ),
        required_keywords=["Tensor", "Pipeline", "Speculative", "PagedAttention"],
        expects_russian=True,
        min_length=400,
        weight=1.5,
        difficulty=DifficultyLevel.HARD,
        difficulty_score=0.85,
    ),
    DifficultyTask(
        task_id="hard_reason_01_multi_step",
        category=BenchmarkCategory.REASONING,
        prompt=(
            "В компании 5 разработчиков. Каждый делает ровно 2 code review в день.\n"
            "Правила: нельзя ревьюить самого себя, нельзя ревьюить одного человека дважды в день.\n"
            "Вопрос: может ли каждый разработчик получить ровно 2 ревью в день? "
            "Докажи или опровергни."
        ),
        required_keywords=[],
        expects_russian=True,
        min_length=100,
        difficulty=DifficultyLevel.HARD,
        difficulty_score=0.8,
    ),
    DifficultyTask(
        task_id="hard_debug_01_memory_leak",
        category=BenchmarkCategory.DEBUG,
        prompt=(
            "Найди утечку памяти и исправь:\n"
            "```python\n"
            "class EventBus:\n"
            "    _handlers = {}\n\n"
            "    def subscribe(self, event: str, handler):\n"
            "        self._handlers.setdefault(event, []).append(handler)\n\n"
            "    def emit(self, event: str, data):\n"
            "        for h in self._handlers.get(event, []):\n"
            "            h(data)\n"
            "```\n"
            "Почему после создания 1000 экземпляров EventBus память растёт? "
            "Как исправить?"
        ),
        required_keywords=["class", "__init__"],
        expects_code=True,
        expects_russian=True,
        min_length=150,
        difficulty=DifficultyLevel.HARD,
        difficulty_score=0.75,
    ),
]

# Extra easy tasks for warm-up
EASY_TASKS: List[DifficultyTask] = [
    DifficultyTask(
        task_id="easy_code_01_sum",
        category=BenchmarkCategory.CODE,
        prompt="Напиши Python функцию sum_list(numbers: list[int]) -> int, которая возвращает сумму всех чисел в списке. Без использования встроенной sum().",
        required_keywords=["def sum_list", "return"],
        expects_code=True,
        min_length=50,
        difficulty=DifficultyLevel.EASY,
        difficulty_score=0.15,
    ),
    DifficultyTask(
        task_id="easy_conv_01_time",
        category=BenchmarkCategory.CONVERSATION,
        prompt="Который час?",
        expects_russian=True,
        min_length=10,
        max_length=200,
        difficulty=DifficultyLevel.EASY,
        difficulty_score=0.1,
    ),
    DifficultyTask(
        task_id="easy_reason_01_simple",
        category=BenchmarkCategory.REASONING,
        prompt="Если у меня 10 яблок и я съел 3, сколько осталось?",
        required_keywords=["7"],
        expects_russian=True,
        min_length=10,
        max_length=200,
        difficulty=DifficultyLevel.EASY,
        difficulty_score=0.1,
    ),
]


# ---------------------------------------------------------------------------
# Staged Reward Calculator (Demystifying RL inspired)
# ---------------------------------------------------------------------------

class StagedRewardCalculator:
    """Compute staged rewards based on task difficulty.

    Insight from Demystifying RL for Tool-Using Agents:
    - Smaller/weaker models benefit from STAGED rewards (partial credit)
    - Larger/stronger models work fine with simple dense rewards
    - Balance between dense (per-step) and outcome (final) rewards

    Implementation:
    - EASY tasks: binary reward (0 or 1) — clear signal
    - MEDIUM tasks: staged with partial credit for structure/format
    - HARD tasks: fine-grained partial credit for each component
    """

    def __init__(self, model_capability: float = 0.5) -> None:
        """
        Args:
            model_capability: 0.0 (weak free model) to 1.0 (strong model).
                             Determines reward granularity.
        """
        self._capability = model_capability

    def compute_staged_reward(
        self,
        task: DifficultyTask,
        base_score: float,
        breakdown: Dict[str, float],
    ) -> float:
        """Compute difficulty-appropriate staged reward.

        Args:
            task: The difficulty-annotated task
            base_score: Raw score from BenchmarkScorer (0.0-1.0)
            breakdown: Score breakdown by component

        Returns:
            Adjusted reward in [0.0, 1.0]
        """
        difficulty = task.difficulty

        if difficulty == DifficultyLevel.EASY:
            # Binary for easy tasks (clear signal)
            return 1.0 if base_score > 0.5 else 0.0

        elif difficulty == DifficultyLevel.MEDIUM:
            # Soft staging: partial credit from 0.3
            if base_score < 0.3:
                return 0.0
            return self._smooth_reward(base_score, floor=0.3, ceiling=0.9)

        else:
            # HARD: fine-grained partial credit
            return self._fine_grained_reward(base_score, breakdown, task)

    def _smooth_reward(
        self, score: float, floor: float = 0.3, ceiling: float = 0.9,
    ) -> float:
        """Smoothly map score to [0, 1] using sigmoid-like curve."""
        if score <= floor:
            return 0.0
        if score >= ceiling:
            return 1.0
        # Normalize to [0, 1] range between floor and ceiling
        normalized = (score - floor) / (ceiling - floor)
        # Sigmoid transformation for smooth gradient
        return 1.0 / (1.0 + math.exp(-6 * (normalized - 0.5)))

    def _fine_grained_reward(
        self,
        base_score: float,
        breakdown: Dict[str, float],
        task: DifficultyTask,
    ) -> float:
        """Fine-grained reward for HARD tasks: credit each component."""
        component_rewards: List[float] = []

        # Component 1: Keywords present (30%)
        kw_score = breakdown.get("keyword_score", 0.0)
        component_rewards.append(0.3 * kw_score)

        # Component 2: Length appropriate (15%)
        len_score = breakdown.get("length_score", 0.0)
        component_rewards.append(0.15 * len_score)

        # Component 3: Code formatting (if applicable, 20%)
        if task.expects_code:
            code_score = breakdown.get("code_format_score", 0.0)
            component_rewards.append(0.2 * code_score)
        else:
            # Redistribute to other components
            component_rewards.append(0.2 * base_score)

        # Component 4: Language correctness (15%)
        lang_score = breakdown.get("language_score", 1.0)
        component_rewards.append(0.15 * lang_score)

        # Component 5: No forbidden patterns (20%)
        forbidden_score = breakdown.get("forbidden_score", 1.0)
        component_rewards.append(0.2 * forbidden_score)

        return sum(component_rewards)


# ---------------------------------------------------------------------------
# Difficulty Curriculum Manager
# ---------------------------------------------------------------------------

@dataclass
class CurriculumStage:
    """A stage in the difficulty curriculum."""
    stage_id: int
    difficulty_mix: Dict[DifficultyLevel, float]  # proportion of each difficulty
    min_score_to_advance: float  # minimum mean score to move to next stage
    max_iterations: int  # maximum iterations before auto-advancing


class DifficultyCurriculum:
    """Manages progressive difficulty training (SAGE Challenger-inspired).

    Stages:
    1. Warm-up: 70% easy, 20% medium, 10% hard
    2. Building: 30% easy, 50% medium, 20% hard
    3. Mastery: 10% easy, 30% medium, 60% hard
    4. Challenge: 0% easy, 20% medium, 80% hard

    Automatically advances when mean score exceeds threshold.
    """

    STAGES = [
        CurriculumStage(0, {DifficultyLevel.EASY: 0.7, DifficultyLevel.MEDIUM: 0.2, DifficultyLevel.HARD: 0.1}, 0.65, 20),
        CurriculumStage(1, {DifficultyLevel.EASY: 0.3, DifficultyLevel.MEDIUM: 0.5, DifficultyLevel.HARD: 0.2}, 0.60, 30),
        CurriculumStage(2, {DifficultyLevel.EASY: 0.1, DifficultyLevel.MEDIUM: 0.3, DifficultyLevel.HARD: 0.6}, 0.55, 40),
        CurriculumStage(3, {DifficultyLevel.EASY: 0.0, DifficultyLevel.MEDIUM: 0.2, DifficultyLevel.HARD: 0.8}, 1.0, 50),
    ]

    def __init__(self) -> None:
        self._current_stage_idx = 0
        self._stage_scores: List[float] = []
        self._stage_history: List[Dict[str, Any]] = []
        self._all_tasks = self._build_task_pool()
        self._iteration = 0

    def _build_task_pool(self) -> Dict[DifficultyLevel, List[DifficultyTask]]:
        """Build task pool grouped by difficulty."""
        pool: Dict[DifficultyLevel, List[DifficultyTask]] = {
            DifficultyLevel.EASY: list(EASY_TASKS),
            DifficultyLevel.MEDIUM: [],
            DifficultyLevel.HARD: list(HARD_TASKS),
        }

        # Classify existing benchmark tasks
        for task in BENCHMARK_TASKS:
            level, score = classify_task_difficulty(task)
            dt = DifficultyTask(
                task_id=task.task_id,
                category=task.category,
                prompt=task.prompt,
                required_keywords=task.required_keywords,
                forbidden_keywords=task.forbidden_keywords,
                min_length=task.min_length,
                max_length=task.max_length,
                expects_code=task.expects_code,
                expects_json=task.expects_json,
                expects_russian=task.expects_russian,
                reference=task.reference,
                weight=task.weight,
                difficulty=level,
                difficulty_score=score,
            )
            pool[level].append(dt)

        return pool

    @property
    def current_stage(self) -> CurriculumStage:
        return self.STAGES[self._current_stage_idx]

    @property
    def stage_name(self) -> str:
        names = ["Разогрев", "Построение", "Мастерство", "Вызов"]
        return names[self._current_stage_idx]

    def sample_batch(self, batch_size: int = 8) -> List[DifficultyTask]:
        """Sample a difficulty-balanced batch for current stage.

        Implements balanced difficulty mixture from Demystifying RL:
        optimal is ~1000 training samples with balanced difficulty.
        """
        stage = self.current_stage
        batch: List[DifficultyTask] = []

        for difficulty, proportion in stage.difficulty_mix.items():
            n = max(1, round(batch_size * proportion))
            pool = self._all_tasks.get(difficulty, [])
            if pool:
                sampled = random.choices(pool, k=min(n, len(pool)))
                batch.extend(sampled)

        # Shuffle to avoid ordering effects
        random.shuffle(batch)
        return batch[:batch_size]

    def record_batch_result(self, mean_score: float) -> bool:
        """Record mean score and check for stage advancement.

        Returns True if stage advanced.
        """
        self._stage_scores.append(mean_score)
        self._iteration += 1

        # Check for advancement
        stage = self.current_stage
        should_advance = False

        # Advance if: (a) mean score exceeds threshold over recent window
        if len(self._stage_scores) >= 3:
            recent_mean = sum(self._stage_scores[-3:]) / 3
            if recent_mean >= stage.min_score_to_advance:
                should_advance = True

        # Or: (b) max iterations reached
        if self._iteration >= stage.max_iterations:
            should_advance = True

        if should_advance and self._current_stage_idx < len(self.STAGES) - 1:
            self._stage_history.append({
                "stage": self._current_stage_idx,
                "name": self.stage_name,
                "iterations": self._iteration,
                "final_mean_score": mean_score,
                "timestamp": time.time(),
            })
            self._current_stage_idx += 1
            self._stage_scores = []
            self._iteration = 0
            logger.info(
                f"Curriculum advanced to stage {self._current_stage_idx}: {self.stage_name}",
                mean_score=mean_score,
            )
            return True

        return False

    def get_stats(self) -> Dict[str, Any]:
        """Current curriculum statistics."""
        return {
            "current_stage": self._current_stage_idx,
            "stage_name": self.stage_name,
            "iteration": self._iteration,
            "scores_in_stage": list(self._stage_scores),
            "mean_score": (
                sum(self._stage_scores) / len(self._stage_scores)
                if self._stage_scores else 0.0
            ),
            "difficulty_mix": {k.value: v for k, v in self.current_stage.difficulty_mix.items()},
            "stage_history": self._stage_history,
            "task_pool_sizes": {k.value: len(v) for k, v in self._all_tasks.items()},
        }


# ---------------------------------------------------------------------------
# Stability Monitor (Demystifying RL inspired)
# ---------------------------------------------------------------------------

class StabilityMonitor:
    """Monitor training stability to prevent policy degradation.

    Key insight from Demystifying RL for Tool-Using Agents:
    environmental stability is CRITICAL — small perturbations in
    environment execution can cause cascading failures in RL.

    Detects:
    1. Score collapse (sudden drop > threshold)
    2. Oscillation (high variance in recent window)
    3. Plateau (no improvement in N iterations)
    """

    def __init__(
        self,
        collapse_threshold: float = 0.15,
        oscillation_threshold: float = 0.10,
        plateau_window: int = 10,
        plateau_min_improvement: float = 0.02,
    ) -> None:
        self._collapse_threshold = collapse_threshold
        self._oscillation_threshold = oscillation_threshold
        self._plateau_window = plateau_window
        self._plateau_min_improvement = plateau_min_improvement
        self._scores: List[float] = []
        self._alerts: List[Dict[str, Any]] = []

    def record(self, score: float) -> Optional[Dict[str, Any]]:
        """Record a score and check for stability issues.

        Returns alert dict if instability detected, else None.
        """
        self._scores.append(score)

        if len(self._scores) < 3:
            return None

        alert = None

        # Check 1: Score collapse
        prev_mean = sum(self._scores[-4:-1]) / 3 if len(self._scores) >= 4 else self._scores[-2]
        if score < prev_mean - self._collapse_threshold:
            alert = {
                "type": "collapse",
                "severity": "high",
                "score": score,
                "previous_mean": prev_mean,
                "drop": prev_mean - score,
                "message": f"Обнаружен коллапс: {prev_mean:.3f} → {score:.3f} (−{prev_mean - score:.3f})",
            }

        # Check 2: Oscillation
        if len(self._scores) >= 5:
            recent = self._scores[-5:]
            variance = sum((s - sum(recent)/5)**2 for s in recent) / 5
            if variance > self._oscillation_threshold:
                alert = alert or {
                    "type": "oscillation",
                    "severity": "medium",
                    "variance": variance,
                    "message": f"Высокая осцилляция: variance={variance:.4f}",
                }

        # Check 3: Plateau
        if len(self._scores) >= self._plateau_window:
            window = self._scores[-self._plateau_window:]
            improvement = max(window) - min(window)
            if improvement < self._plateau_min_improvement:
                alert = alert or {
                    "type": "plateau",
                    "severity": "low",
                    "window_range": improvement,
                    "message": f"Плато: улучшение {improvement:.4f} за {self._plateau_window} итераций",
                }

        if alert:
            alert["iteration"] = len(self._scores)
            alert["timestamp"] = time.time()
            self._alerts.append(alert)
            logger.warning("Stability issue detected", **alert)

        return alert

    def is_stable(self) -> bool:
        """Check if training is currently stable (no recent high-severity alerts)."""
        if not self._alerts:
            return True
        recent = [a for a in self._alerts if a.get("severity") == "high"]
        if not recent:
            return True
        # Check if last high-severity alert was within last 3 iterations
        return recent[-1].get("iteration", 0) < len(self._scores) - 3

    def get_recommendation(self) -> str:
        """Get stability recommendation for training loop."""
        if not self._alerts:
            return "stable"
        last_alert = self._alerts[-1]
        if last_alert["type"] == "collapse":
            return "rollback"  # revert to previous best prompt
        elif last_alert["type"] == "oscillation":
            return "reduce_exploration"  # lower explore_prob
        elif last_alert["type"] == "plateau":
            return "increase_exploration"  # try more diverse mutations
        return "continue"

    def get_stats(self) -> Dict[str, Any]:
        return {
            "total_records": len(self._scores),
            "alerts": len(self._alerts),
            "recent_mean": (
                sum(self._scores[-5:]) / min(5, len(self._scores))
                if self._scores else 0.0
            ),
            "is_stable": self.is_stable(),
            "recommendation": self.get_recommendation(),
        }
