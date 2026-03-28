import unittest

from scripts.memory_hub.index_db import init_db, upsert_memory_record, upsert_source_binding
from scripts.memory_hub.retriever import retrieve, route_query_type


class RetrieverRouteTest(unittest.TestCase):
    def test_cross_project_history_prefers_central(self) -> None:
        result = route_query_type("跨项目历史")
        self.assertEqual(result["primary"], "central")
        self.assertEqual(result["needs_source_bindings"], True)

    def test_current_project_prefers_local(self) -> None:
        result = route_query_type("当前项目状态")
        self.assertEqual(result["primary"], "local")

    def test_retrieve_returns_central_hits_with_source_bindings(self) -> None:
        import tempfile
        from pathlib import Path

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
            upsert_source_binding(
                db_path,
                {
                    "binding_id": "bind-1",
                    "memory_id": "mem-1",
                    "source_host": "claude-code",
                    "source_file": "memory/short_reply.md",
                    "source_revision_mtime": 1.0,
                    "source_revision_hash": "abc",
                    "binding_status": "active",
                    "created_at": "2026-03-28T10:00:00+00:00",
                    "updated_at": "2026-03-28T10:00:00+00:00",
                },
            )
            result = retrieve(db_path, "跨项目历史", "短答")

        self.assertEqual(result["route"]["primary"], "central")
        self.assertEqual(len(result["central_hits"]), 1)
        self.assertEqual(result["central_hits"][0]["source_bindings"][0]["binding_id"], "bind-1")
