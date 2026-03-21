"""
Inference & Serving Optimizer — vLLM / AWQ / SINQ / model-routing improvements.

Provides eight cooperating components that sit between the gateway and
``VLLMModelManager`` to improve throughput and latency on a single 16 GB GPU:

1. **SpeculativeDecodingConfig** — draft-then-verify config + n-gram fallback (vLLM paper).
2. **ChunkedPrefillConfig** — break long prompts into chunks to reduce TTFT.
3. **PrefixCachingConfig** — KV-cache reuse for shared prompt prefixes.
4. **build_optimized_vllm_args** — helper that merges all config flags into a single CLI list.
5. **DynamicBatchScheduler** — adaptive batch sizing & throttle.
6. **SmartModelRouter** — task-aware model selection.
7. **AdaptiveTokenBudget** — per-request token budget estimation.
8. **InferenceMetricsCollector** — TPS / TTFT / ITL / Prometheus export.

References
----------
- vLLM: Efficient Memory Management for LLM Serving (arXiv:2309.06180)
- AWQ: Activation-aware Weight Quantization (arXiv:2306.00978)
- SINQ: Scalable Inference with Neural Queues
- Phi-3 Technical Report (arXiv:2404.14219)
- Scaling Data-Constrained Language Models (arXiv:2305.16264)
"""

from __future__ import annotations

import re
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import structlog

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Supporting dataclasses
# ---------------------------------------------------------------------------

VRAM_TOTAL_GB = 16.0  # RTX 5060 Ti


@dataclass
class BatchMetrics:
    """Snapshot of the dynamic-batch scheduler state."""

    queue_depth: int = 0
    avg_latency_ms: float = 0.0
    throughput_tps: float = 0.0
    batch_size: int = 1
    throttled: bool = False


@dataclass
class ModelProfile:
    """Describes a model available for routing."""

    name: str
    vram_gb: float
    capabilities: List[str] = field(default_factory=list)
    speed_tier: str = "medium"  # "fast" | "medium" | "slow"
    quality_tier: str = "medium"  # "low" | "medium" | "high"


@dataclass
class RoutingTask:
    """A request to be routed to the best model."""

    prompt: str
    task_type: str = "general"  # "general" | "code" | "math" | "creative" | "chat"
    complexity_hint: Optional[str] = None  # "simple" | "moderate" | "complex"
    preferred_model: Optional[str] = None


@dataclass
class TokenBudget:
    """Token budget for a single inference request."""

    max_tokens: int = 2048
    estimated_output_tokens: int = 512
    context_tokens: int = 0
    budget_reason: str = "default"


@dataclass
class InferenceMetrics:
    """Aggregate inference metrics snapshot."""

    total_requests: int = 0
    avg_tps: float = 0.0
    avg_ttft_ms: float = 0.0
    avg_itl_ms: float = 0.0
    cache_hit_rate: float = 0.0
    vram_estimate_gb: float = 0.0


@dataclass
class ModelPerformance:
    """Per-model performance statistics."""

    model: str = ""
    total_inferences: int = 0
    avg_tps: float = 0.0
    avg_latency_ms: float = 0.0
    success_rate: float = 1.0


# ---------------------------------------------------------------------------
# 1. Speculative Decoding Configuration
# ---------------------------------------------------------------------------


@dataclass
class SpeculativeDecodingConfig:
    """Configuration for speculative decoding (vLLM paper).

    Supports two modes:
    - **Draft-model mode** (``use_ngram=False``): a small draft model generates
      candidate tokens; the target model verifies in batch.
    - **N-gram mode** (``use_ngram=True``, default): uses in-prompt n-gram matches
      as candidates — no extra VRAM required, zero cold-start overhead.

    From: vLLM: Efficient Memory Management for LLM Serving (arXiv:2309.06180)
    """

    enabled: bool = False
    use_ngram: bool = True                          # prefer n-gram (no extra VRAM)
    ngram_prompt_lookup_max: int = 4                # max n-gram window size
    ngram_prompt_lookup_min: int = 1                # min n-gram window size
    draft_model: str = "Qwen/Qwen2.5-0.5B-Instruct"  # used only when use_ngram=False
    num_speculative_tokens: int = 5                 # tokens speculated per step
    # On 16 GB VRAM: draft model takes ~1 GB, main model gets ~14 GB

    def to_vllm_args(self) -> List[str]:
        """Return vLLM CLI flags for speculative decoding."""
        if not self.enabled:
            return []
        if self.use_ngram:
            return [
                "--speculative-model", "[ngram]",
                "--num-speculative-tokens", str(self.num_speculative_tokens),
                "--ngram-prompt-lookup-max", str(self.ngram_prompt_lookup_max),
                "--ngram-prompt-lookup-min", str(self.ngram_prompt_lookup_min),
            ]
        return [
            "--speculative-model", self.draft_model,
            "--num-speculative-tokens", str(self.num_speculative_tokens),
            "--speculative-max-model-len", "2048",
        ]

    def estimated_vram_overhead_gb(self) -> float:
        """Estimate extra VRAM used (n-gram mode costs nothing)."""
        if not self.enabled:
            return 0.0
        if self.use_ngram:
            return 0.0  # n-gram: no extra model loaded
        # 0.5B draft model ≈ 1 GB in fp16, ~0.5 GB quantised
        return 1.0


# ---------------------------------------------------------------------------
# 2. Chunked Prefill Configuration
# ---------------------------------------------------------------------------


@dataclass
class ChunkedPrefillConfig:
    """Chunked prefill — break long prompts into fixed-size chunks.

    Reduces time-to-first-token (TTFT) for long-context requests by
    interleaving prefill and decode phases.

    From: vLLM chunked prefill documentation.
    """

    enabled: bool = False
    max_num_batched_tokens: int = 4096  # tokens processed per prefill chunk

    def to_vllm_args(self) -> List[str]:
        """Return vLLM CLI flags for chunked prefill."""
        if not self.enabled:
            return []
        return [
            "--enable-chunked-prefill",
            "--max-num-batched-tokens", str(self.max_num_batched_tokens),
        ]


# ---------------------------------------------------------------------------
# 3. Prefix Caching Configuration
# ---------------------------------------------------------------------------


@dataclass
class PrefixCachingConfig:
    """Automatic KV-cache reuse for shared prompt prefixes.

    When many requests share a common prefix (system prompt, few-shot examples,
    retrieval context) the prefix KV tensors are computed once and reused —
    cutting TTFT by up to 80 % for the cached portion.

    From: vLLM Automatic Prefix Caching documentation.
    """

    enabled: bool = False

    def to_vllm_args(self) -> List[str]:
        """Return vLLM CLI flags for prefix caching."""
        if not self.enabled:
            return []
        return ["--enable-prefix-caching"]


# ---------------------------------------------------------------------------
# 4. Convenience builder
# ---------------------------------------------------------------------------


def build_optimized_vllm_args(
    speculative: Optional["SpeculativeDecodingConfig"] = None,
    chunked_prefill: Optional["ChunkedPrefillConfig"] = None,
    prefix_caching: Optional["PrefixCachingConfig"] = None,
) -> List[str]:
    """Merge all optimisation configs into a single vLLM CLI argument list.

    Pass the result to ``VLLMModelManager`` via *vllm_extra_args*.
    ``None`` configs are silently skipped.

    Example::

        args = build_optimized_vllm_args(
            speculative=SpeculativeDecodingConfig(enabled=True),
            chunked_prefill=ChunkedPrefillConfig(enabled=True),
            prefix_caching=PrefixCachingConfig(enabled=True),
        )
        manager = VLLMModelManager(..., vllm_extra_args=args)
    """
    result: List[str] = []
    if speculative is not None:
        result.extend(speculative.to_vllm_args())
    if chunked_prefill is not None:
        result.extend(chunked_prefill.to_vllm_args())
    if prefix_caching is not None:
        result.extend(prefix_caching.to_vllm_args())
    return result


# ---------------------------------------------------------------------------
# 5. Dynamic Batch Scheduler
# ---------------------------------------------------------------------------

# Sliding-window size for latency / throughput history
_HISTORY_WINDOW = 100


class DynamicBatchScheduler:
    """Dynamic batch sizing based on current load and VRAM.

    From: Scaling Laws for RL + vLLM memory management papers.

    Monitors current request queue depth, estimated VRAM usage,
    average response latency, and token throughput.  Adjusts
    ``max_batch_size`` and decides whether to throttle.
    """

    def __init__(
        self,
        target_latency_ms: int = 5000,
        max_vram_gb: float = 15.0,
    ) -> None:
        self._target_latency_ms = target_latency_ms
        self._max_vram_gb = max_vram_gb

        # Metrics history (bounded deque)
        self._latencies: deque[float] = deque(maxlen=_HISTORY_WINDOW)
        self._throughputs: deque[float] = deque(maxlen=_HISTORY_WINDOW)
        self._queue_depth: int = 0
        self._total_tokens_in: int = 0
        self._total_tokens_out: int = 0
        self._total_requests: int = 0

        # Batch sizing state
        self._batch_size: int = 1
        self._min_batch: int = 1
        self._max_batch: int = 32
        self._throttled: bool = False

        logger.info(
            "DynamicBatchScheduler initialised",
            target_latency_ms=target_latency_ms,
            max_vram_gb=max_vram_gb,
        )

    # -- public API --

    def record_request(
        self,
        tokens_in: int,
        tokens_out: int,
        latency_ms: float,
    ) -> None:
        """Record a completed request for metrics."""
        self._total_requests += 1
        self._total_tokens_in += tokens_in
        self._total_tokens_out += tokens_out
        self._latencies.append(latency_ms)

        total_tokens = tokens_in + tokens_out
        if latency_ms > 0:
            tps = (total_tokens / latency_ms) * 1000.0
            self._throughputs.append(tps)

        # Re-calculate optimal batch size after every request
        self._recalculate()

    def get_optimal_batch_size(self) -> int:
        """Return the current recommended batch size."""
        return self._batch_size

    def should_throttle(self) -> bool:
        """Return *True* when the scheduler recommends slowing intake."""
        return self._throttled

    def set_queue_depth(self, depth: int) -> None:
        """Update the current queue depth (call from the request loop)."""
        self._queue_depth = max(0, depth)

    def get_metrics(self) -> BatchMetrics:
        """Return current scheduling metrics snapshot."""
        avg_lat = self._avg(self._latencies)
        avg_tps = self._avg(self._throughputs)

        return BatchMetrics(
            queue_depth=self._queue_depth,
            avg_latency_ms=avg_lat,
            throughput_tps=avg_tps,
            batch_size=self._batch_size,
            throttled=self._throttled,
        )

    # -- internal --

    def _recalculate(self) -> None:
        avg_latency = self._avg(self._latencies)

        # Grow batch size when latency is well under target and queue is deep
        if avg_latency > 0 and avg_latency < self._target_latency_ms * 0.7:
            if self._queue_depth > self._batch_size:
                self._batch_size = min(self._batch_size + 1, self._max_batch)
        # Shrink when latency exceeds target
        elif avg_latency > self._target_latency_ms:
            self._batch_size = max(self._batch_size - 1, self._min_batch)

        # Throttle when latency is 2× target or queue is huge
        self._throttled = (
            avg_latency > self._target_latency_ms * 2
            or self._queue_depth > self._max_batch * 4
        )

        if self._throttled:
            logger.warning(
                "Throttling enabled",
                avg_latency_ms=round(avg_latency, 1),
                queue_depth=self._queue_depth,
            )

    @staticmethod
    def _avg(dq: deque[float]) -> float:
        return sum(dq) / len(dq) if dq else 0.0


# ---------------------------------------------------------------------------
# 3. Smart Model Router
# ---------------------------------------------------------------------------

# Keyword lists used for lightweight task classification
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

# Complexity buckets
_COMPLEXITY_SIMPLE = "simple"
_COMPLEXITY_MODERATE = "moderate"
_COMPLEXITY_COMPLEX = "complex"


class SmartModelRouter:
    """Intelligent model routing based on task characteristics.

    From: Phi-3 Technical Report, Small Language Models Survey, Scaling Laws.

    Routes requests to the optimal model based on task complexity,
    required capabilities, current VRAM state, and historical performance.
    """

    def __init__(self, available_models: Dict[str, ModelProfile]) -> None:
        self._models = dict(available_models)
        # outcome tracking: model → task_type → {successes, total, quality_sum}
        self._outcomes: Dict[str, Dict[str, Dict[str, float]]] = defaultdict(
            lambda: defaultdict(lambda: {"successes": 0.0, "total": 0.0, "quality_sum": 0.0}),
        )
        self._route_counts: Dict[str, int] = defaultdict(int)

        logger.info(
            "SmartModelRouter initialised",
            models=[m.name for m in self._models.values()],
        )

    # -- public API --

    def route(self, task: RoutingTask) -> str:
        """Select the best model for *task*."""
        # Honour explicit preference when the model is available
        if task.preferred_model and task.preferred_model in self._models:
            self._route_counts[task.preferred_model] += 1
            logger.debug("Routing to preferred model", model=task.preferred_model)
            return task.preferred_model

        task_type = self._classify_task(task)
        complexity = self._estimate_complexity(task)

        scored: List[tuple[float, str]] = []
        for name, profile in self._models.items():
            score = self._score_model(profile, task_type, complexity)
            scored.append((score, name))

        scored.sort(key=lambda t: t[0], reverse=True)
        chosen = scored[0][1] if scored else next(iter(self._models))

        self._route_counts[chosen] += 1
        logger.info(
            "Model routed",
            model=chosen,
            task_type=task_type,
            complexity=complexity,
            score=round(scored[0][0], 3) if scored else 0,
        )
        return chosen

    def record_outcome(
        self,
        model: str,
        task_type: str,
        success: bool,
        quality_score: float,
    ) -> None:
        """Record an outcome so the router can learn preferences."""
        entry = self._outcomes[model][task_type]
        entry["total"] += 1
        entry["quality_sum"] += quality_score
        if success:
            entry["successes"] += 1

    def get_routing_stats(self) -> Dict[str, Any]:
        """Return routing decision statistics."""
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

    # -- internal helpers --

    def _classify_task(self, task: RoutingTask) -> str:
        """Infer task type from prompt keywords when not specified."""
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

    def _score_model(
        self,
        profile: ModelProfile,
        task_type: str,
        complexity: str,
    ) -> float:
        """Compute a heuristic score (higher = better fit)."""
        score = 0.0

        # Capability match
        if task_type in profile.capabilities:
            score += 3.0

        # Speed preference for simple tasks, quality for complex
        speed_map = {"fast": 2.0, "medium": 1.0, "slow": 0.5}
        quality_map = {"high": 2.0, "medium": 1.0, "low": 0.5}

        if complexity == _COMPLEXITY_SIMPLE:
            score += speed_map.get(profile.speed_tier, 1.0) * 1.5
            score += quality_map.get(profile.quality_tier, 1.0) * 0.5
        elif complexity == _COMPLEXITY_COMPLEX:
            score += speed_map.get(profile.speed_tier, 1.0) * 0.5
            score += quality_map.get(profile.quality_tier, 1.0) * 1.5
        else:
            score += speed_map.get(profile.speed_tier, 1.0)
            score += quality_map.get(profile.quality_tier, 1.0)

        # VRAM penalty: prefer models that leave headroom
        if profile.vram_gb > VRAM_TOTAL_GB * 0.9:
            score -= 1.0

        # Historical performance bonus
        history = self._outcomes.get(profile.name, {}).get(task_type)
        if history and history["total"] >= 3:
            avg_q = history["quality_sum"] / history["total"]
            score += avg_q  # quality_score is 0-1 normally

        return score


# ---------------------------------------------------------------------------
# 4. Adaptive Token Budget
# ---------------------------------------------------------------------------

_TASK_BUDGET_DEFAULTS: Dict[str, int] = {
    "general": 1024,
    "chat": 512,
    "code": 2048,
    "math": 1536,
    "creative": 2048,
}


class AdaptiveTokenBudget:
    """Dynamically adjust token budgets per request.

    From: Scaling Data-Constrained Language Models + efficiency papers.

    Simple questions get smaller budgets (faster response),
    complex tasks and code generation get larger budgets.
    """

    def __init__(
        self,
        default_max_tokens: int = 2048,
        vram_gb: float = 16.0,
    ) -> None:
        self._default_max = default_max_tokens
        self._vram_gb = vram_gb

        logger.info(
            "AdaptiveTokenBudget initialised",
            default_max_tokens=default_max_tokens,
            vram_gb=vram_gb,
        )

    def estimate_budget(
        self,
        prompt: str,
        task_type: str = "general",
    ) -> TokenBudget:
        """Estimate token budget for a request."""
        base = _TASK_BUDGET_DEFAULTS.get(task_type, self._default_max)

        # Adjust for prompt length (longer prompts → likely longer answers)
        prompt_tokens = self._rough_token_count(prompt)
        if prompt_tokens > 500:
            base = min(int(base * 1.3), self._default_max)

        # Short conversational messages need less
        if prompt_tokens < 30 and task_type in ("chat", "general"):
            base = min(base, 256)

        reason = f"task={task_type}, prompt_tokens≈{prompt_tokens}"

        budget = TokenBudget(
            max_tokens=base,
            estimated_output_tokens=int(base * 0.6),
            context_tokens=prompt_tokens,
            budget_reason=reason,
        )

        logger.debug("Token budget estimated", budget_reason=reason, max_tokens=base)
        return budget

    def adjust_for_vram(
        self,
        budget: TokenBudget,
        current_vram_usage: float,
    ) -> TokenBudget:
        """Reduce budget when VRAM utilisation is high."""
        headroom = self._vram_gb - current_vram_usage
        if headroom < 1.0:
            # Severe constraint — halve the budget
            factor = 0.5
            reason_suffix = " [VRAM critical]"
        elif headroom < 2.0:
            factor = 0.75
            reason_suffix = " [VRAM constrained]"
        else:
            return budget  # no adjustment needed

        adjusted = TokenBudget(
            max_tokens=max(64, int(budget.max_tokens * factor)),
            estimated_output_tokens=max(32, int(budget.estimated_output_tokens * factor)),
            context_tokens=budget.context_tokens,
            budget_reason=budget.budget_reason + reason_suffix,
        )
        logger.info(
            "Token budget reduced for VRAM",
            original=budget.max_tokens,
            adjusted=adjusted.max_tokens,
            vram_headroom_gb=round(headroom, 2),
        )
        return adjusted

    @staticmethod
    def _rough_token_count(text: str) -> int:
        """Rough token estimate (~4 chars per token for English)."""
        return max(1, len(text) // 4)


# ---------------------------------------------------------------------------
# 5. Inference Metrics Collector
# ---------------------------------------------------------------------------


class InferenceMetricsCollector:
    """Collect and expose inference metrics.

    From: vLLM, AWQ papers — monitoring for efficient serving.

    Tracks tokens-per-second, time-to-first-token, inter-token latency,
    cache hit rate, VRAM utilisation estimates, and requests-per-second.
    """

    def __init__(self) -> None:
        self._total_requests: int = 0
        self._total_prompt_tokens: int = 0
        self._total_completion_tokens: int = 0

        # Per-request latency/throughput history
        self._latencies: deque[float] = deque(maxlen=_HISTORY_WINDOW)
        self._tps_values: deque[float] = deque(maxlen=_HISTORY_WINDOW)
        self._ttft_values: deque[float] = deque(maxlen=_HISTORY_WINDOW)

        # Cache tracking
        self._cache_hits: int = 0
        self._cache_misses: int = 0

        # Per-model breakdown
        self._model_stats: Dict[str, _ModelAccumulator] = defaultdict(_ModelAccumulator)

        # Timing
        self._start_time: float = time.monotonic()

        logger.info("InferenceMetricsCollector initialised")

    # -- public API --

    def record_inference(
        self,
        model: str,
        prompt_tokens: int,
        completion_tokens: int,
        total_latency_ms: float,
        first_token_ms: float = 0,
    ) -> None:
        """Record an inference call."""
        self._total_requests += 1
        self._total_prompt_tokens += prompt_tokens
        self._total_completion_tokens += completion_tokens
        self._latencies.append(total_latency_ms)

        total_tokens = prompt_tokens + completion_tokens
        if total_latency_ms > 0:
            tps = (total_tokens / total_latency_ms) * 1000.0
            self._tps_values.append(tps)

        if first_token_ms > 0:
            self._ttft_values.append(first_token_ms)

        # Per-model
        acc = self._model_stats[model]
        acc.count += 1
        acc.total_latency_ms += total_latency_ms
        acc.total_tokens += total_tokens
        acc.successes += 1  # caller can record failures via record_failure

    def record_cache_hit(self) -> None:
        """Record a KV-cache or prompt-cache hit."""
        self._cache_hits += 1

    def record_cache_miss(self) -> None:
        """Record a cache miss."""
        self._cache_misses += 1

    def record_failure(self, model: str) -> None:
        """Record a failed inference for *model*."""
        acc = self._model_stats[model]
        acc.count += 1
        # successes not incremented → success_rate drops

    def get_metrics(self) -> InferenceMetrics:
        """Return current aggregate metrics snapshot."""
        elapsed = time.monotonic() - self._start_time
        total_cache = self._cache_hits + self._cache_misses

        # Estimate VRAM from token throughput (rough heuristic)
        avg_tps = self._avg(self._tps_values)
        vram_est = min(VRAM_TOTAL_GB, 4.0 + avg_tps * 0.01)  # crude placeholder

        # Average inter-token latency: total_latency / completion_tokens
        avg_itl = 0.0
        if self._total_completion_tokens > 0 and self._latencies:
            avg_itl = sum(self._latencies) / self._total_completion_tokens

        return InferenceMetrics(
            total_requests=self._total_requests,
            avg_tps=round(avg_tps, 2),
            avg_ttft_ms=round(self._avg(self._ttft_values), 2),
            avg_itl_ms=round(avg_itl, 2),
            cache_hit_rate=round(self._cache_hits / total_cache, 4) if total_cache else 0.0,
            vram_estimate_gb=round(vram_est, 2),
        )

    def get_model_performance(self, model: str) -> Optional[ModelPerformance]:
        """Return performance stats for a specific model, or *None*."""
        acc = self._model_stats.get(model)
        if acc is None or acc.count == 0:
            return None

        avg_lat = acc.total_latency_ms / acc.count
        avg_tps = (acc.total_tokens / acc.total_latency_ms * 1000.0) if acc.total_latency_ms else 0
        success = acc.successes / acc.count if acc.count else 1.0

        return ModelPerformance(
            model=model,
            total_inferences=acc.count,
            avg_tps=round(avg_tps, 2),
            avg_latency_ms=round(avg_lat, 2),
            success_rate=round(success, 4),
        )

    def export_prometheus(self) -> str:
        """Export metrics in Prometheus text exposition format (no external deps)."""
        m = self.get_metrics()
        lines = [
            "# HELP openclaw_inference_total Total inference requests.",
            "# TYPE openclaw_inference_total counter",
            f"openclaw_inference_total {m.total_requests}",
            "",
            "# HELP openclaw_inference_avg_tps Average tokens per second.",
            "# TYPE openclaw_inference_avg_tps gauge",
            f"openclaw_inference_avg_tps {m.avg_tps}",
            "",
            "# HELP openclaw_inference_avg_ttft_ms Average time to first token (ms).",
            "# TYPE openclaw_inference_avg_ttft_ms gauge",
            f"openclaw_inference_avg_ttft_ms {m.avg_ttft_ms}",
            "",
            "# HELP openclaw_inference_avg_itl_ms Average inter-token latency (ms).",
            "# TYPE openclaw_inference_avg_itl_ms gauge",
            f"openclaw_inference_avg_itl_ms {m.avg_itl_ms}",
            "",
            "# HELP openclaw_inference_cache_hit_rate KV-cache hit rate.",
            "# TYPE openclaw_inference_cache_hit_rate gauge",
            f"openclaw_inference_cache_hit_rate {m.cache_hit_rate}",
            "",
            "# HELP openclaw_inference_vram_estimate_gb Estimated VRAM usage (GB).",
            "# TYPE openclaw_inference_vram_estimate_gb gauge",
            f"openclaw_inference_vram_estimate_gb {m.vram_estimate_gb}",
            "",
            "# HELP openclaw_inference_prompt_tokens_total Total prompt tokens processed.",
            "# TYPE openclaw_inference_prompt_tokens_total counter",
            f"openclaw_inference_prompt_tokens_total {self._total_prompt_tokens}",
            "",
            "# HELP openclaw_inference_completion_tokens_total Total completion tokens generated.",
            "# TYPE openclaw_inference_completion_tokens_total counter",
            f"openclaw_inference_completion_tokens_total {self._total_completion_tokens}",
        ]

        # Per-model gauges
        for model, acc in self._model_stats.items():
            safe_name = model.replace("/", "_").replace("-", "_").replace(".", "_")
            if acc.count > 0:
                avg_lat = acc.total_latency_ms / acc.count
                lines.extend([
                    "",
                    f'# HELP openclaw_model_avg_latency_ms Average latency for {model}.',
                    f"# TYPE openclaw_model_avg_latency_ms gauge",
                    f'openclaw_model_avg_latency_ms{{model="{safe_name}"}} {avg_lat:.2f}',
                    f'openclaw_model_inferences_total{{model="{safe_name}"}} {acc.count}',
                ])

        lines.append("")
        return "\n".join(lines)

    # -- helpers --

    @staticmethod
    def _avg(dq: deque[float]) -> float:
        return sum(dq) / len(dq) if dq else 0.0


class _ModelAccumulator:
    """Mutable accumulator for per-model stats (internal)."""

    __slots__ = ("count", "total_latency_ms", "total_tokens", "successes")

    def __init__(self) -> None:
        self.count: int = 0
        self.total_latency_ms: float = 0.0
        self.total_tokens: int = 0
        self.successes: int = 0
