import unittest
from pathlib import Path

from scripts.memory_hub.merge import merge_into_canonical, merge_record_into_db
from scripts.memory_hub.index_db import get_source_bindings, init_db, upsert_memory_record


class MergeTest(unittest.TestCase):
    def test_semantically_equivalent_preferences_share_one_canonical_memory(self) -> None:
        existing = {
            "canonical_key": "feedback:user-prefers-short-replies",
            "memory_id": "mem-1",
            "bindings": [{"source_host": "claude-code", "source_file": "memory/a.md"}],
        }
        incoming = {
            "canonical_key": "feedback:user-prefers-short-replies",
            "source_host": "openclaw",
            "source_file": "memory/b.md",
        }
        result = merge_into_canonical(existing, incoming)
        self.assertEqual(result["memory_id"], "mem-1")
        self.assertEqual(len(result["bindings"]), 2)

    def test_non_equivalent_preferences_stay_separate(self) -> None:
        existing = {
            "canonical_key": "feedback:user-prefers-short-replies",
            "memory_id": "mem-1",
            "bindings": [{"source_host": "claude-code", "source_file": "memory/a.md"}],
        }
        incoming = {
            "canonical_key": "feedback:user-prefers-detailed-replies",
            "source_host": "openclaw",
            "source_file": "memory/b.md",
        }
        result = merge_into_canonical(existing, incoming)
        self.assertIsNone(result)

    def test_merge_record_into_db_reuses_existing_memory_id_and_writes_binding(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "hub.sqlite3"
            init_db(db_path)
            upsert_memory_record(
                db_path,
                {
                    "memory_id": "mem-1",
                    "canonical_key": "feedback:user-prefers-short-replies",
                    "source_host": "claude-code",
                    "source_file": "memory/a.md",
                    "memory_type": "feedback",
                    "status": "candidate",
                    "summary": "用户希望回复尽量短",
                    "content": "默认短答",
                    "why": "用户不喜欢长篇总结",
                    "how_to_apply": "优先简短直接",
                    "risk_level": "low",
                    "stability": "stable",
                    "confidence": 0.9,
                    "created_at": "2026-03-28T10:00:00+00:00",
                    "updated_at": "2026-03-28T10:00:00+00:00",
                },
            )
            record = merge_record_into_db(
                db_path,
                {
                    "memory_id": "mem-2",
                    "canonical_key": "feedback:user-prefers-short-replies",
                    "source_host": "openclaw",
                    "source_file": "memory/b.md",
                    "source_revision": {"mtime": 2.0, "sha256": "def"},
                    "memory_type": "feedback",
                    "status": "candidate",
                    "summary": "用户希望回复尽量短",
                    "content": "优先简短直接",
                    "why": "用户不喜欢冗长回顾",
                    "how_to_apply": "默认短答",
                    "risk_level": "low",
                    "stability": "stable",
                    "confidence": 0.8,
                    "created_at": "2026-03-28T10:01:00+00:00",
                    "updated_at": "2026-03-28T10:01:00+00:00",
                },
            )
            bindings = get_source_bindings(db_path, "mem-1")

        self.assertEqual(record["memory_id"], "mem-1")
        self.assertEqual(len(bindings), 2)
        self.assertEqual({binding["source_host"] for binding in bindings}, {"claude-code", "openclaw"})
