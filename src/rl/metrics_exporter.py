"""Metrics Exporter — Prometheus-compatible metrics from RL subsystem.

Exposes internal counters and gauges as a simple text endpoint that
Prometheus can scrape. Also provides a programmatic `snapshot()` for
internal dashboards and logging.

Metrics exported:
- openclaw_rl_rewards_total (counter) — total rewards computed
- openclaw_rl_reward_mean (gauge) — running mean reward
- openclaw_rl_experiences_total (gauge) — buffer size
- openclaw_rl_feedback_total (counter, by type)
- openclaw_rl_goals_total (gauge, by status)
- openclaw_rl_consolidation_last_sec (gauge) — last run duration
- openclaw_router_outcome_total (counter, by model × task_type)
- openclaw_pipeline_latency_ms (histogram buckets)

No external dependencies — generates Prometheus text format directly.
If prometheus_client is installed, uses it natively.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

import structlog

logger = structlog.get_logger("MetricsExporter")


class MetricsExporter:
    """Collects and exports RL + pipeline metrics.

    Usage:
        exporter = MetricsExporter()
        exporter.record_reward(0.8, task_type="code_gen")
        exporter.record_pipeline_latency(1234.5, chain="planner_executor")
        exporter.record_feedback("thumbs_up", channel="telegram")

        # Get structured snapshot
        snapshot = exporter.snapshot()

        # Get Prometheus text format
        text = exporter.prometheus_text()
    """

    def __init__(self) -> None:
        # Reward metrics
        self._reward_count: int = 0
        self._reward_sum: float = 0.0
        self._reward_by_type: Dict[str, _Counter] = {}

        # Experience buffer metrics
        self._buffer_size: int = 0
        self._buffer_successful: int = 0

        # Feedback metrics
        self._feedback_counts: Dict[str, int] = {}

        # Goal metrics
        self._goal_counts: Dict[str, int] = {}

        # Consolidation metrics
        self._consolidation_last_sec: float = 0.0
        self._consolidation_runs: int = 0

        # Pipeline metrics
        self._pipeline_latencies: List[float] = []
        self._pipeline_by_chain: Dict[str, _Counter] = {}

        # Router metrics
        self._router_outcomes: Dict[str, Dict[str, _Counter]] = {}

        self._start_time = time.time()

    # ------------------------------------------------------------------
    # Recording methods (called by other RL modules)
    # ------------------------------------------------------------------

    def record_reward(self, reward: float, task_type: str = "general") -> None:
        self._reward_count += 1
        self._reward_sum += reward
        if task_type not in self._reward_by_type:
            self._reward_by_type[task_type] = _Counter()
        self._reward_by_type[task_type].add(reward)

    def record_feedback(self, feedback_type: str, channel: str = "") -> None:
        key = f"{feedback_type}:{channel}" if channel else feedback_type
        self._feedback_counts[key] = self._feedback_counts.get(key, 0) + 1

    def record_pipeline_latency(self, latency_ms: float, chain: str = "default") -> None:
        self._pipeline_latencies.append(latency_ms)
        # Keep only recent 1000
        if len(self._pipeline_latencies) > 1000:
            self._pipeline_latencies = self._pipeline_latencies[-1000:]
        if chain not in self._pipeline_by_chain:
            self._pipeline_by_chain[chain] = _Counter()
        self._pipeline_by_chain[chain].add(latency_ms)

    def record_router_outcome(
        self, model: str, task_type: str, success: bool, quality: float
    ) -> None:
        if model not in self._router_outcomes:
            self._router_outcomes[model] = {}
        if task_type not in self._router_outcomes[model]:
            self._router_outcomes[model][task_type] = _Counter()
        c = self._router_outcomes[model][task_type]
        c.count += 1
        c.sum += quality
        if success:
            c.successes += 1

    def update_buffer_stats(self, total: int, successful: int) -> None:
        self._buffer_size = total
        self._buffer_successful = successful

    def update_goal_stats(self, by_status: Dict[str, int]) -> None:
        self._goal_counts = dict(by_status)

    def record_consolidation(self, elapsed_sec: float) -> None:
        self._consolidation_last_sec = elapsed_sec
        self._consolidation_runs += 1

    # ------------------------------------------------------------------
    # Snapshot (programmatic)
    # ------------------------------------------------------------------

    def snapshot(self) -> Dict[str, Any]:
        """Return structured metrics snapshot for internal use."""
        uptime = time.time() - self._start_time
        mean_reward = self._reward_sum / self._reward_count if self._reward_count else 0.0

        latencies = self._pipeline_latencies
        p50 = sorted(latencies)[len(latencies) // 2] if latencies else 0.0
        p95 = sorted(latencies)[int(len(latencies) * 0.95)] if latencies else 0.0
        p99 = sorted(latencies)[int(len(latencies) * 0.99)] if latencies else 0.0

        return {
            "uptime_sec": round(uptime, 1),
            "rewards": {
                "total": self._reward_count,
                "mean": round(mean_reward, 4),
                "by_type": {k: {"count": v.count, "mean": v.mean} for k, v in self._reward_by_type.items()},
            },
            "experience_buffer": {
                "total": self._buffer_size,
                "successful": self._buffer_successful,
            },
            "feedback": dict(self._feedback_counts),
            "goals": dict(self._goal_counts),
            "consolidation": {
                "runs": self._consolidation_runs,
                "last_elapsed_sec": self._consolidation_last_sec,
            },
            "pipeline_latency": {
                "count": len(latencies),
                "p50_ms": round(p50, 1),
                "p95_ms": round(p95, 1),
                "p99_ms": round(p99, 1),
            },
            "router": {
                model: {
                    tt: {"count": c.count, "success_rate": c.success_rate, "avg_quality": c.mean}
                    for tt, c in tasks.items()
                }
                for model, tasks in self._router_outcomes.items()
            },
        }

    # ------------------------------------------------------------------
    # Prometheus text format
    # ------------------------------------------------------------------

    def prometheus_text(self) -> str:
        """Generate metrics in Prometheus exposition format."""
        lines: List[str] = []
        _a = lines.append

        # Rewards
        _a("# HELP openclaw_rl_rewards_total Total reward computations")
        _a("# TYPE openclaw_rl_rewards_total counter")
        _a(f"openclaw_rl_rewards_total {self._reward_count}")

        mean_r = self._reward_sum / self._reward_count if self._reward_count else 0.0
        _a("# HELP openclaw_rl_reward_mean Running mean reward")
        _a("# TYPE openclaw_rl_reward_mean gauge")
        _a(f"openclaw_rl_reward_mean {mean_r:.4f}")

        # Reward by task type
        for ttype, c in self._reward_by_type.items():
            _a(f'openclaw_rl_reward_by_type{{task_type="{ttype}"}} {c.mean:.4f}')

        # Experience buffer
        _a("# HELP openclaw_rl_experiences_total Experience buffer size")
        _a("# TYPE openclaw_rl_experiences_total gauge")
        _a(f"openclaw_rl_experiences_total {self._buffer_size}")
        _a(f"openclaw_rl_experiences_successful {self._buffer_successful}")

        # Feedback
        _a("# HELP openclaw_rl_feedback_total User feedback events")
        _a("# TYPE openclaw_rl_feedback_total counter")
        for key, count in self._feedback_counts.items():
            parts = key.split(":", 1)
            ftype = parts[0]
            channel = parts[1] if len(parts) > 1 else ""
            _a(f'openclaw_rl_feedback_total{{type="{ftype}",channel="{channel}"}} {count}')

        # Goals
        _a("# HELP openclaw_rl_goals Goals by status")
        _a("# TYPE openclaw_rl_goals gauge")
        for status, count in self._goal_counts.items():
            _a(f'openclaw_rl_goals{{status="{status}"}} {count}')

        # Consolidation
        _a("# HELP openclaw_rl_consolidation_last_sec Last consolidation duration")
        _a("# TYPE openclaw_rl_consolidation_last_sec gauge")
        _a(f"openclaw_rl_consolidation_last_sec {self._consolidation_last_sec:.3f}")
        _a(f"openclaw_rl_consolidation_runs_total {self._consolidation_runs}")

        # Pipeline latency histogram
        latencies = sorted(self._pipeline_latencies)
        if latencies:
            for bucket in [100, 500, 1000, 2000, 5000, 10000, 30000]:
                count_le = sum(1 for l in latencies if l <= bucket)
                _a(f'openclaw_pipeline_latency_ms_bucket{{le="{bucket}"}} {count_le}')
            _a(f'openclaw_pipeline_latency_ms_bucket{{le="+Inf"}} {len(latencies)}')
            _a(f"openclaw_pipeline_latency_ms_count {len(latencies)}")
            _a(f"openclaw_pipeline_latency_ms_sum {sum(latencies):.1f}")

        # Router outcomes
        for model, tasks in self._router_outcomes.items():
            for ttype, c in tasks.items():
                _a(f'openclaw_router_outcome_total{{model="{model}",task_type="{ttype}"}} {c.count}')
                _a(f'openclaw_router_quality_avg{{model="{model}",task_type="{ttype}"}} {c.mean:.4f}')

        return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Internal counter helper
# ---------------------------------------------------------------------------

class _Counter:
    """Simple running counter with mean computation."""
    __slots__ = ("count", "sum", "successes")

    def __init__(self) -> None:
        self.count: int = 0
        self.sum: float = 0.0
        self.successes: int = 0

    def add(self, value: float = 1.0) -> None:
        self.count += 1
        self.sum += value

    @property
    def mean(self) -> float:
        return round(self.sum / self.count, 4) if self.count else 0.0

    @property
    def success_rate(self) -> float:
        return round(self.successes / self.count, 4) if self.count else 0.0
