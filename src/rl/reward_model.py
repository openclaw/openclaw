"""Reward Model — multi-factor reward computation for task executions.

Computes a scalar reward signal from multiple dimensions:
- Success/failure (primary binary signal)
- User feedback (thumbs-up/down, explicit rating)
- Efficiency (token usage vs. task complexity)
- Latency penalty
- Auditor quality score (from pipeline Auditor role)

The reward is stored alongside experience tuples and will be used
by future PPO/DPO training loops. This module does NOT train — it only scores.

References:
- RLHF (Ouyang et al., 2022): reward model concept
- SLEA-RL (arXiv:2603.18079): step-level reward disaggregation
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

import structlog

logger = structlog.get_logger("RewardModel")


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

class TaskType(str, Enum):
    """Known task categories that affect reward weights."""
    CODE_GEN = "code_gen"
    CODE_REVIEW = "code_review"
    RESEARCH = "research"
    TRADING = "trading"
    CONVERSATION = "conversation"
    DEBUG = "debug"
    CREATIVE = "creative"
    GENERAL = "general"


@dataclass
class RewardSignal:
    """A computed reward with breakdown."""
    total: float  # final scalar reward ∈ [-1.0, 1.0]
    components: Dict[str, float] = field(default_factory=dict)
    explanation: str = ""
    timestamp: float = field(default_factory=time.time)


@dataclass
class TaskReward:
    """Input data for reward computation."""
    task_id: str
    task_type: TaskType = TaskType.GENERAL
    success: bool = False
    user_rating: Optional[float] = None  # 0.0..1.0 from feedback or None
    auditor_score: float = 0.5  # from pipeline Auditor [0..1]
    latency_ms: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    retries: int = 0
    tool_calls: int = 0
    tool_success_rate: float = 1.0
    error_type: Optional[str] = None  # exception class name if failed


# ---------------------------------------------------------------------------
# Reward weight profiles per task type
# ---------------------------------------------------------------------------

_DEFAULT_WEIGHTS = {
    "success": 0.40,
    "user_feedback": 0.20,
    "auditor": 0.15,
    "efficiency": 0.10,
    "latency": 0.10,
    "tool_use": 0.05,
}

_TASK_WEIGHTS: Dict[TaskType, Dict[str, float]] = {
    TaskType.CODE_GEN: {
        "success": 0.35,
        "user_feedback": 0.15,
        "auditor": 0.25,  # code quality matters more
        "efficiency": 0.10,
        "latency": 0.05,
        "tool_use": 0.10,  # sandbox, linter usage
    },
    TaskType.TRADING: {
        "success": 0.50,  # binary correctness critical
        "user_feedback": 0.10,
        "auditor": 0.15,
        "efficiency": 0.05,
        "latency": 0.15,  # latency critical for HFT
        "tool_use": 0.05,
    },
    TaskType.RESEARCH: {
        "success": 0.30,
        "user_feedback": 0.25,  # subjective quality matters
        "auditor": 0.20,
        "efficiency": 0.10,
        "latency": 0.05,
        "tool_use": 0.10,  # web search, MCP usage
    },
}


class RewardModel:
    """Multi-factor reward computation engine.

    Usage:
        model = RewardModel()
        task = TaskReward(task_id="abc", success=True, auditor_score=0.8, ...)
        signal = model.compute(task)
        # signal.total ∈ [-1.0, 1.0], signal.components = {...}
    """

    # Thresholds
    _LATENCY_FAST_MS = 2_000     # bonus if faster
    _LATENCY_SLOW_MS = 15_000    # penalty if slower
    _EFFICIENCY_HIGH_TOKENS = 4_000  # penalty for verbosity
    _MAX_RETRIES_BEFORE_PENALTY = 2

    def __init__(
        self,
        custom_weights: Optional[Dict[str, float]] = None,
        success_penalty: float = -0.5,
    ) -> None:
        self._custom_weights = custom_weights
        self._success_penalty = success_penalty
        # Running stats for normalization
        self._total_computed: int = 0
        self._reward_sum: float = 0.0
        self._reward_sq_sum: float = 0.0

    def compute(self, task: TaskReward) -> RewardSignal:
        """Compute composite reward signal for a task execution."""
        weights = self._get_weights(task.task_type)
        components: Dict[str, float] = {}

        # 1. Success component
        if task.success:
            components["success"] = 1.0
        else:
            # Graduated failure penalty based on error type
            if task.error_type in ("LLMRateLimitError", "CircuitBreakerOpenError"):
                components["success"] = -0.2  # infrastructure, not bot's fault
            elif task.error_type in ("SafetyError", "PromptInjectionError"):
                components["success"] = 0.0  # correctly refused
            else:
                components["success"] = self._success_penalty

        # 2. User feedback component (if available)
        if task.user_rating is not None:
            # Map [0..1] → [-1..1]
            components["user_feedback"] = (task.user_rating * 2.0) - 1.0
        else:
            # No feedback — use auditor as proxy (halved weight)
            components["user_feedback"] = (task.auditor_score * 2.0 - 1.0) * 0.5

        # 3. Auditor quality component
        components["auditor"] = (task.auditor_score * 2.0) - 1.0

        # 4. Efficiency component (token usage)
        if task.output_tokens > 0:
            if task.output_tokens <= 200:
                components["efficiency"] = 1.0
            elif task.output_tokens <= self._EFFICIENCY_HIGH_TOKENS:
                # Linear decay from 1.0 at 200 tokens to 0.0 at threshold
                ratio = (task.output_tokens - 200) / (self._EFFICIENCY_HIGH_TOKENS - 200)
                components["efficiency"] = 1.0 - ratio
            else:
                components["efficiency"] = -0.5  # verbose penalty
        else:
            components["efficiency"] = 0.0

        # Retry penalty
        if task.retries > self._MAX_RETRIES_BEFORE_PENALTY:
            excess = task.retries - self._MAX_RETRIES_BEFORE_PENALTY
            components["efficiency"] -= min(0.3, excess * 0.1)

        # 5. Latency component
        if task.latency_ms <= self._LATENCY_FAST_MS:
            components["latency"] = 1.0
        elif task.latency_ms <= self._LATENCY_SLOW_MS:
            ratio = (task.latency_ms - self._LATENCY_FAST_MS) / (self._LATENCY_SLOW_MS - self._LATENCY_FAST_MS)
            components["latency"] = 1.0 - (ratio * 2.0)  # goes to -1.0
        else:
            components["latency"] = -1.0

        # 6. Tool usage component
        if task.tool_calls > 0:
            components["tool_use"] = (task.tool_success_rate * 2.0) - 1.0
        else:
            components["tool_use"] = 0.0  # neutral if no tools used

        # Weighted sum
        total = sum(
            components.get(k, 0.0) * weights.get(k, 0.0)
            for k in weights
        )
        # Clamp to [-1, 1]
        total = max(-1.0, min(1.0, total))

        # Update running stats
        self._total_computed += 1
        self._reward_sum += total
        self._reward_sq_sum += total * total

        explanation = ", ".join(
            f"{k}={v:+.2f}×{weights.get(k, 0):.2f}" for k, v in components.items()
        )

        signal = RewardSignal(
            total=round(total, 4),
            components={k: round(v, 4) for k, v in components.items()},
            explanation=f"reward={total:+.4f} [{explanation}]",
        )

        logger.debug(
            "reward_computed",
            task_id=task.task_id,
            reward=signal.total,
            success=task.success,
            task_type=task.task_type.value,
        )
        return signal

    def get_stats(self) -> Dict[str, Any]:
        """Return running reward statistics."""
        n = self._total_computed
        if n == 0:
            return {"total_computed": 0, "mean_reward": 0.0, "std_reward": 0.0}
        mean = self._reward_sum / n
        variance = max(0.0, (self._reward_sq_sum / n) - (mean * mean))
        return {
            "total_computed": n,
            "mean_reward": round(mean, 4),
            "std_reward": round(variance ** 0.5, 4),
        }

    def _get_weights(self, task_type: TaskType) -> Dict[str, float]:
        if self._custom_weights:
            return self._custom_weights
        return _TASK_WEIGHTS.get(task_type, _DEFAULT_WEIGHTS)
