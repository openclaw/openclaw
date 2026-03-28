import sqlite3
import tempfile
import unittest
from pathlib import Path

from scripts.memory_hub.index_db import (
    get_source_bindings,
    init_db,
    search_memories,
    upsert_memory_record,
)


class InitDbTest(unittest.TestCase):
    def test_init_db_creates_core_tables_and_fts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "hub.sqlite3"
            init_db(db_path)
            conn = sqlite3.connect(db_path)
            names = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
                )
            }
            conn.close()

        self.assertIn("memory_records", names)
        self.assertIn("source_bindings", names)
        self.assertIn("writeback_jobs", names)
        self.assertIn("memory_records_fts", names)

    def test_search_memories_reads_fts_index(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "hub.sqlite3"
            init_db(db_path)
            upsert_memory_record(
                db_path,
                {
                    "memory_id": "mem-1",
                    "canonical_key": "feedback:user-prefers-short-replies",
                    "source_host": "claude-code",
                    "source_file": "memory/short_reply.md",
                    "memory_type": "feedback",
                    "status": "active",
                    "summary": "用户希望回复尽量短",
                    "content": "默认短答，不重复总结 diff",
                    "why": "用户不喜欢长篇总结",
                    "how_to_apply": "优先简短直接",
                    "risk_level": "low",
                    "stability": "stable",
                    "confidence": 0.9,
                    "created_at": "2026-03-28T10:00:00+00:00",
                    "updated_at": "2026-03-28T10:00:00+00:00",
                },
            )
            hits = search_memories(db_path, "短答")

        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["memory_id"], "mem-1")

    def test_get_source_bindings_returns_active_bindings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "hub.sqlite3"
            init_db(db_path)
            conn = sqlite3.connect(db_path)
            conn.execute(
                """
                INSERT INTO source_bindings (
                  binding_id, memory_id, source_host, source_file, source_revision_mtime,
                  source_revision_hash, binding_status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "bind-1",
                    "mem-1",
                    "claude-code",
                    "memory/short_reply.md",
                    1.0,
                    "abc",
                    "active",
                    "2026-03-28T10:00:00+00:00",
                    "2026-03-28T10:00:00+00:00",
                ),
            )
            conn.commit()
            conn.close()
            bindings = get_source_bindings(db_path, "mem-1")

        self.assertEqual(len(bindings), 1)
        self.assertEqual(bindings[0]["binding_id"], "bind-1")
