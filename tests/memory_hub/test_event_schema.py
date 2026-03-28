import tempfile
import unittest
from pathlib import Path

from scripts.memory_hub.event_schema import normalize_event
from scripts.memory_hub.memory_schema import build_memory_record
from scripts.memory_hub.types import SourceRevision


class NormalizeEventTest(unittest.TestCase):
    def test_normalize_event_adds_required_fields(self) -> None:
        event = normalize_event(
            {
                "event_type": "user_confirmed",
                "source_host": "claude-code",
                "source_file": "memory/2026-03-28.md",
                "payload": {"summary": "用户偏好简短回复"},
            }
        )
        self.assertEqual(event["event_type"], "user_confirmed")
        self.assertEqual(event["source_host"], "claude-code")
        self.assertIn("event_id", event)
        self.assertIn("observed_at", event)

    def test_build_memory_record_includes_canonical_key_and_revision(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source_file = Path(tmp) / "memory.md"
            source_file.write_text("old\n", encoding="utf-8")
            record = build_memory_record(
                event={
                    "event_type": "user_confirmed",
                    "source_host": "claude-code",
                    "source_file": str(source_file),
                    "payload": {
                        "memory_type": "feedback",
                        "summary": "用户希望回复尽量短",
                        "content": "默认短答",
                        "why": "用户不喜欢长篇总结",
                        "how_to_apply": "优先简短直接",
                    },
                },
                classification={
                    "bucket": "long_term_candidate",
                    "risk_level": "low",
                    "stability": "stable",
                },
                source_revision=SourceRevision(mtime=1.0, sha256="abc"),
            )
        self.assertEqual(record["canonical_key"], "feedback:user-prefers-short-replies")
        self.assertEqual(record["source_revision"]["sha256"], "abc")
        self.assertEqual(record["status"], "candidate")
