"""Shared helpers and dataclasses for agent reasoning modules."""

import time
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

import structlog

from src.llm_gateway import route_llm

logger = structlog.get_logger("AgentReasoning")


@dataclass
class ReActStep:
    step: int
    thought: str
    action: str
    action_input: str
    observation: str
    timestamp: float = field(default_factory=time.time)


@dataclass
class ReActResult:
    answer: str
    steps: List[ReActStep]
    total_steps: int
    finished: bool
    elapsed_sec: float


@dataclass
class EvaluationResult:
    success: bool
    score: float
    reasoning: str
    issues: List[str] = field(default_factory=list)


@dataclass
class ReflexionResult:
    final_response: str
    attempts: int
    reflections: List[str]
    evaluations: List["EvaluationResult"]
    success: bool
    elapsed_sec: float


@dataclass
class MoAResult:
    """Result from Mixture-of-Agents generation.

    Reference: arXiv:2406.04692.
    """
    aggregated_response: str
    proposals: List[str]
    num_proposers: int
    elapsed_sec: float


@dataclass
class ConstitutionalResult:
    """Result of constitutional safety check."""
    safe: bool
    violations: List[str]
    revised_response: Optional[str]
    principle_scores: Dict[str, float] = field(default_factory=dict)


@dataclass
class ToolStats:
    """Accumulated statistics for a single tool.

    Reference: Toolformer (arXiv:2302.04761), Gorilla (arXiv:2305.15334).
    """
    tool_name: str
    total_calls: int = 0
    successes: int = 0
    failures: int = 0
    total_latency_ms: int = 0
    recent_errors: List[str] = field(default_factory=list)

    @property
    def success_rate(self) -> float:
        return self.successes / self.total_calls if self.total_calls > 0 else 0.0

    @property
    def avg_latency_ms(self) -> float:
        return self.total_latency_ms / self.total_calls if self.total_calls > 0 else 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            **asdict(self),
            "success_rate": self.success_rate,
            "avg_latency_ms": self.avg_latency_ms,
        }


async def call_vllm(
    url: str,
    model: str,
    messages: List[Dict[str, str]],
    *,
    temperature: float = 0.3,
    max_tokens: int = 2048,
    timeout_sec: int = 120,
) -> str:
    """Route through Unified LLM Gateway (url/model args kept for API compat)."""
    return await route_llm(
        "",
        messages=messages,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
    )
