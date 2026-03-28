import tempfile
import unittest
from pathlib import Path

from scripts.memory_hub.host_adapters.claude_code import write_memory_entry
from scripts.memory_hub.revision import capture_source_revision
from scripts.memory_hub.writeback import decide_writeback, execute_writeback
from scripts.memory_hub_ingest_event import ingest_one_event


class ClaudeWritebackTest(unittest.TestCase):
    def test_write_memory_entry_updates_memory_file_and_index(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            memory_file = root / "memory" / "feedback_short.md"
            memory_file.parent.mkdir(parents=True, exist_ok=True)
            memory_file.write_text("old\n", encoding="utf-8")
            index_file = root / "MEMORY.md"
            index_file.write_text("", encoding="utf-8")
            revision = capture_source_revision(memory_file)
            write_memory_entry(
                root=root,
                memory_file=memory_file,
                index_file=index_file,
                title="短回复偏好",
                body="新的正文",
                expected_revision=revision,
            )
            self.assertIn("新的正文", memory_file.read_text(encoding="utf-8"))
            self.assertIn("短回复偏好", index_file.read_text(encoding="utf-8"))

    def test_medium_risk_candidate_goes_to_review_queue(self) -> None:
        result = decide_writeback({"risk_level": "medium", "bucket": "long_term_candidate"})
        self.assertEqual(result["action"], "enqueue_review")

    def test_execute_writeback_enqueues_review_item(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = execute_writeback(
                action={"action": "enqueue_review"},
                source_host="claude-code",
                host_roots={"claude-code": root},
                payload={},
                expected_revision=capture_source_revision(root / "missing.txt") if False else type("Rev", (), {"mtime": 0.0, "sha256": ""})(),
                hub_root=root,
                memory_id="mem-1",
            )
            self.assertEqual(result["action"], "enqueue_review")
            self.assertEqual(result["review_item"]["memory_id"], "mem-1")
            self.assertTrue((root / "review-queue" / "items.jsonl").exists())

    def test_cas_conflict_downgrades_writeback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            memory_file = root / "memory" / "feedback_short.md"
            memory_file.parent.mkdir(parents=True, exist_ok=True)
            memory_file.write_text("old\n", encoding="utf-8")
            index_file = root / "MEMORY.md"
            index_file.write_text("", encoding="utf-8")
            revision = capture_source_revision(memory_file)
            memory_file.write_text("changed\n", encoding="utf-8")
            result = execute_writeback(
                action={"action": "auto_write"},
                source_host="claude-code",
                host_roots={"claude-code": root},
                payload={
                    "target_memory_file": str(memory_file),
                    "target_index_file": str(index_file),
                    "title": "短回复偏好",
                    "content": "新的正文",
                },
                expected_revision=revision,
                hub_root=root,
                memory_id="mem-1",
            )
            self.assertEqual(result["action"], "raise_conflict")
            self.assertIn("memory_backup", result)
            self.assertIn("index_backup", result)

    def test_auto_write_creates_backups(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            memory_file = root / "memory" / "feedback_short.md"
            memory_file.parent.mkdir(parents=True, exist_ok=True)
            memory_file.write_text("old\n", encoding="utf-8")
            index_file = root / "MEMORY.md"
            index_file.write_text("", encoding="utf-8")
            revision = capture_source_revision(memory_file)
            result = execute_writeback(
                action={"action": "auto_write"},
                source_host="claude-code",
                host_roots={"claude-code": root},
                payload={
                    "target_memory_file": str(memory_file),
                    "target_index_file": str(index_file),
                    "title": "短回复偏好",
                    "content": "新的正文",
                },
                expected_revision=revision,
                hub_root=root,
                memory_id="mem-1",
            )
            self.assertEqual(result["action"], "auto_write")
            self.assertTrue(Path(result["memory_backup"]).exists())
            self.assertTrue(Path(result["index_backup"]).exists())

    def test_ingest_one_event_derives_host_root_for_direct_cli_usage(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hub_root = root / "hub"
            fixture_root = root / "claude_memory"
            fixture_root.mkdir(parents=True, exist_ok=True)
            memory_file = fixture_root / "short_reply.md"
            memory_file.write_text("old\n", encoding="utf-8")
            index_file = fixture_root / "MEMORY.md"
            index_file.write_text("", encoding="utf-8")
            result = ingest_one_event(
                hub_root=hub_root,
                host_roots={},
                raw_event={
                    "event_type": "user_confirmed",
                    "source_host": "claude-code",
                    "source_file": str(memory_file),
                    "payload": {
                        "memory_type": "feedback",
                        "summary": "用户希望回复尽量短",
                        "content": "优先简短直接",
                        "why": "用户不喜欢冗长回顾",
                        "how_to_apply": "默认短答，不重复总结 diff",
                        "stable": True,
                        "target_memory_file": str(memory_file),
                        "target_index_file": str(index_file),
                        "title": "短回复偏好",
                    },
                },
            )
            self.assertEqual(result["writeback"]["action"], "auto_write")
            self.assertIn("优先简短直接", memory_file.read_text(encoding="utf-8"))
            self.assertEqual(result["host_roots"]["claude-code"], str(fixture_root.resolve()))
