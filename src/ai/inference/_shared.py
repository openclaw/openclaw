"""Shared dataclasses and constants for the inference optimiser package."""

from collections import deque
from dataclasses import dataclass, field
from typing import List, Optional

import structlog

logger = structlog.get_logger(__name__)

def _detect_vram_total_gb() -> float:
    """Attempt to detect total GPU VRAM via pynvml, fallback to 16 GB."""
    try:
        import pynvml
        pynvml.nvmlInit()
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        info = pynvml.nvmlDeviceGetMemoryInfo(handle)
        return round(info.total / (1024 ** 3), 1)
    except Exception:
        return 16.0


VRAM_TOTAL_GB: float = _detect_vram_total_gb()
_HISTORY_WINDOW = 100


@dataclass
class BatchMetrics:
    queue_depth: int = 0
    avg_latency_ms: float = 0.0
    throughput_tps: float = 0.0
    batch_size: int = 1
    throttled: bool = False


@dataclass
class ModelProfile:
    name: str
    vram_gb: float
    capabilities: List[str] = field(default_factory=list)
    speed_tier: str = "medium"
    quality_tier: str = "medium"


@dataclass
class RoutingTask:
    prompt: str
    task_type: str = "general"
    complexity_hint: Optional[str] = None
    preferred_model: Optional[str] = None


@dataclass
class TokenBudget:
    max_tokens: int = 2048
    estimated_output_tokens: int = 512
    context_tokens: int = 0
    budget_reason: str = "default"


@dataclass
class InferenceMetrics:
    total_requests: int = 0
    avg_tps: float = 0.0
    avg_ttft_ms: float = 0.0
    avg_itl_ms: float = 0.0
    cache_hit_rate: float = 0.0
    vram_estimate_gb: float = 0.0


@dataclass
class ModelPerformance:
    model: str = ""
    total_inferences: int = 0
    avg_tps: float = 0.0
    avg_latency_ms: float = 0.0
    success_rate: float = 1.0
