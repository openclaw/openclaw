"""Tool Learning Tracker — adaptive tool selection based on usage statistics.

Inspired by:
- Toolformer (arXiv:2302.04761): language models self-learning tool use
- Gorilla (arXiv:2305.15334): connecting LLMs to massive APIs
"""

import asyncio
import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional

from src.ai.agents._shared import ToolStats, logger

_STATE_VERSION = 1


class ToolLearningTracker:
    """Tracks tool usage patterns and learns from failures."""

    _RETRY_THRESHOLD = 0.5
    _MAX_RECENT_ERRORS = 20

    def __init__(self) -> None:
        self._stats: Dict[str, ToolStats] = {}
        self._task_tool_map: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
        self._lock = asyncio.Lock()

    def record_tool_use(
        self,
        tool_name: str,
        success: bool,
        latency_ms: int,
        error: Optional[str] = None,
        task_type: Optional[str] = None,
    ) -> None:
        stats = self._stats.setdefault(tool_name, ToolStats(tool_name=tool_name))
        stats.total_calls += 1
        stats.total_latency_ms += latency_ms
        if success:
            stats.successes += 1
        else:
            stats.failures += 1
            if error:
                stats.recent_errors.append(error[:200])
                if len(stats.recent_errors) > self._MAX_RECENT_ERRORS:
                    stats.recent_errors = stats.recent_errors[-self._MAX_RECENT_ERRORS :]

        if task_type and success:
            self._task_tool_map[task_type][tool_name] += 1

        logger.debug(
            "tool_use_recorded",
            tool=tool_name,
            success=success,
            latency_ms=latency_ms,
            cumulative_rate=f"{stats.success_rate:.2f}",
        )

    def get_best_tool_for_task(self, task_type: str) -> Optional[str]:
        mapping = self._task_tool_map.get(task_type)
        if not mapping:
            return None
        return max(mapping, key=mapping.get)  # type: ignore[arg-type]

    def should_retry_with_alternative(self, tool_name: str) -> bool:
        stats = self._stats.get(tool_name)
        if stats is None or stats.total_calls < 3:
            return False
        return stats.success_rate < self._RETRY_THRESHOLD

    def get_tool_stats(self) -> Dict[str, ToolStats]:
        return dict(self._stats)

    def get_tool_report(self) -> List[Dict[str, Any]]:
        return [
            s.to_dict()
            for s in sorted(self._stats.values(), key=lambda s: s.total_calls, reverse=True)
        ]

    def suggest_alternative(self, failed_tool: str) -> Optional[str]:
        candidates = [
            s
            for name, s in self._stats.items()
            if name != failed_tool and s.total_calls >= 3
        ]
        if not candidates:
            return None
        best = max(candidates, key=lambda s: s.success_rate)
        return best.tool_name if best.success_rate > self._RETRY_THRESHOLD else None

    # -- Persistence --

    def save_state(self, path: str) -> None:
        """Persist tracker state to JSON with version field."""
        state = {
            "version": _STATE_VERSION,
            "stats": {name: s.to_dict() for name, s in self._stats.items()},
            "task_tool_map": {k: dict(v) for k, v in self._task_tool_map.items()},
        }
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.info("ToolLearningTracker state saved", path=path, tools=len(self._stats))

    def restore_state(self, path: str) -> None:
        """Load tracker state from JSON; silently ignores unknown keys."""
        p = Path(path)
        if not p.exists():
            logger.debug("No saved state found", path=path)
            return
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            version = data.get("version", 0)
            if version > _STATE_VERSION:
                logger.warning("State version newer than supported", file_version=version, supported=_STATE_VERSION)
            for name, d in data.get("stats", {}).items():
                known_fields = {f for f in ToolStats.__dataclass_fields__} if hasattr(ToolStats, "__dataclass_fields__") else set()
                filtered = {k: v for k, v in d.items() if not known_fields or k in known_fields}
                self._stats[name] = ToolStats(**filtered) if known_fields else ToolStats(tool_name=name)
            for task, mapping in data.get("task_tool_map", {}).items():
                self._task_tool_map[task] = defaultdict(int, mapping)
            logger.info("ToolLearningTracker state restored", path=path, tools=len(self._stats))
        except Exception as e:
            logger.warning("Failed to restore ToolLearningTracker state", error=str(e))
