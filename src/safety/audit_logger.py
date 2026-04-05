"""SafetyAuditLogger — JSONL audit trail for safety events."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

import structlog

logger = structlog.get_logger(__name__)


class SafetyAuditLogger:
    """Log all safety-relevant events for audit trail.

    Maintains a JSONL audit log for:
    - Injection attempts (detected and blocked)
    - Hallucination flags
    - Content filtering events
    - Credential leak attempts
    - Safety policy violations
    """

    VALID_SEVERITIES = ("low", "medium", "high", "critical")

    def __init__(self, log_dir: str = "training_data/safety_audit") -> None:
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self._log_file = self.log_dir / "audit.jsonl"

    def log_event(
        self,
        event_type: str,
        severity: str,
        details: Dict[str, Any],
    ) -> None:
        """Append a safety event to the audit log."""
        if severity not in self.VALID_SEVERITIES:
            raise ValueError(f"severity must be one of {self.VALID_SEVERITIES}")

        record = {
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event_type": event_type,
            "severity": severity,
            "details": details,
        }
        with open(self._log_file, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")

        logger.info(
            "safety_audit_event",
            event_type=event_type,
            severity=severity,
        )

    def get_summary(self, last_n_hours: int = 24) -> Dict[str, Any]:
        """Return a summary of events in the last *last_n_hours* hours."""
        cutoff = datetime.now(timezone.utc).timestamp() - last_n_hours * 3600
        counts: Dict[str, int] = {}
        severity_counts: Dict[str, int] = {}
        total = 0

        if not self._log_file.exists():
            return {"total_events": 0, "by_type": {}, "by_severity": {}}

        with open(self._log_file, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = record.get("timestamp", "")
                try:
                    event_time = datetime.fromisoformat(ts).timestamp()
                except (ValueError, TypeError):
                    continue
                if event_time < cutoff:
                    continue
                total += 1
                etype = record.get("event_type", "unknown")
                sev = record.get("severity", "unknown")
                counts[etype] = counts.get(etype, 0) + 1
                severity_counts[sev] = severity_counts.get(sev, 0) + 1

        return {
            "total_events": total,
            "by_type": counts,
            "by_severity": severity_counts,
        }
