import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from scripts.memory_hub.openclaw_hook_bridge import build_task_completed_event, build_user_confirmed_event


class OpenClawHookBridgeTest(unittest.TestCase):
    def test_build_user_confirmed_event_targets_openclaw_memory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            memory_dir = root / "memory"
            index_file = root / "MEMORY.md"
            index_file.write_text("", encoding="utf-8")
            with mock.patch("scripts.memory_hub.openclaw_hook_bridge.OPENCLAW_ROOT", root.resolve()), \
                 mock.patch("scripts.memory_hub.openclaw_hook_bridge.OPENCLAW_MEMORY_DIR", memory_dir), \
                 mock.patch("scripts.memory_hub.openclaw_hook_bridge.OPENCLAW_MEMORY_INDEX", index_file):
                event = build_user_confirmed_event({
                    "cwd": str(root),
                    "summary": "OpenClaw 用户确认短结构回复",
                    "content": "默认短结构输出。",
                })

        self.assertIsNotNone(event)
        self.assertEqual(event["event_type"], "user_confirmed")
        self.assertEqual(event["source_host"], "openclaw")
        self.assertTrue(event["payload"]["stable"])

    def test_build_task_completed_event_targets_daily_memory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            memory_dir = root / "memory"
            index_file = root / "MEMORY.md"
            index_file.write_text("", encoding="utf-8")
            with mock.patch("scripts.memory_hub.openclaw_hook_bridge.OPENCLAW_ROOT", root.resolve()), \
                 mock.patch("scripts.memory_hub.openclaw_hook_bridge.OPENCLAW_MEMORY_DIR", memory_dir), \
                 mock.patch("scripts.memory_hub.openclaw_hook_bridge.OPENCLAW_MEMORY_INDEX", index_file):
                event = build_task_completed_event({
                    "cwd": str(root),
                    "summary": "任务完成：写回审稿结果",
                    "content": "已完成写回并同步状态。",
                }, today=date(2026, 3, 28))

        self.assertIsNotNone(event)
        self.assertEqual(event["event_type"], "task_completed")
        self.assertEqual(event["payload"]["memory_type"], "daily_log")
        self.assertTrue(event["source_file"].endswith("2026-03-28.md"))
