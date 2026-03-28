import tempfile
import unittest
from pathlib import Path

from scripts.memory_hub.audit import build_audit_entry
from scripts.memory_hub.review_queue import enqueue_review_item, list_review_items
from scripts.memory_hub.rollback import create_backup, latest_backup, rollback_file


class ReviewAndRollbackTest(unittest.TestCase):
    def test_rollback_file_restores_previous_contents(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "MEMORY.md"
            target.write_text("new\n", encoding="utf-8")
            backup = Path(tmp) / "MEMORY.md.bak"
            backup.write_text("old\n", encoding="utf-8")
            rollback_file(target, backup)
            self.assertEqual(target.read_text(encoding="utf-8"), "old\n")

    def test_create_backup_writes_backup_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "MEMORY.md"
            target.write_text("old\n", encoding="utf-8")
            backup = create_backup(root, target)
            self.assertTrue(backup.exists())
            self.assertEqual(backup.read_text(encoding="utf-8"), "old\n")

    def test_enqueue_review_item_appends_jsonl(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            enqueue_review_item(root, {
                "memory_id": "mem-1",
                "source_host": "claude-code",
                "reason": "medium risk",
                "risk_level": "medium",
            })
            review_file = root / "review-queue" / "items.jsonl"
            self.assertTrue(review_file.exists())

    def test_list_review_items_reads_queue(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            enqueue_review_item(root, {
                "memory_id": "mem-1",
                "source_host": "claude-code",
                "reason": "medium risk",
                "risk_level": "medium",
            })
            items = list_review_items(root)
            self.assertEqual(len(items), 1)
            self.assertEqual(items[0]["memory_id"], "mem-1")

    def test_build_audit_entry_contains_action_and_source(self) -> None:
        entry = build_audit_entry("auto_write", "mem-1", "claude-code")
        self.assertEqual(entry["action"], "auto_write")
        self.assertEqual(entry["source_host"], "claude-code")
        self.assertIn("ts", entry)

    def test_latest_backup_finds_newest_matching_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            backups = root / "audit" / "backups"
            backups.mkdir(parents=True, exist_ok=True)
            older = backups / "20260328T100000__MEMORY.md.bak"
            newer = backups / "20260328T110000__MEMORY.md.bak"
            older.write_text("old\n", encoding="utf-8")
            newer.write_text("new\n", encoding="utf-8")
            found = latest_backup(root, "MEMORY.md")
            self.assertEqual(found, newer.resolve())
