import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts.memory_hub.claude_hook_bridge import build_stop_event, build_user_prompt_event


class ClaudeHookBridgeTest(unittest.TestCase):
    def test_build_user_prompt_event_for_short_reply_preference(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            memory_dir = Path(tmp)
            index_file = memory_dir / "MEMORY.md"
            index_file.write_text("", encoding="utf-8")
            with mock.patch("scripts.memory_hub.claude_hook_bridge.TARGET_PROJECT_CWD", Path("/tmp/project").resolve()), \
                 mock.patch("scripts.memory_hub.claude_hook_bridge.CLAUDE_MEMORY_DIR", memory_dir), \
                 mock.patch("scripts.memory_hub.claude_hook_bridge.CLAUDE_MEMORY_INDEX", index_file):
                event = build_user_prompt_event({"cwd": "/tmp/project", "prompt": "以后回答简短一点"})

        self.assertIsNotNone(event)
        self.assertEqual(event["event_type"], "user_confirmed")
        self.assertEqual(event["payload"]["summary"], "用户希望回复尽量短")
        self.assertTrue(event["payload"]["stable"])

    def test_build_user_prompt_event_returns_none_for_irrelevant_prompt(self) -> None:
        event = build_user_prompt_event({"cwd": "/Users/mianfeishitou/Documents/cc", "prompt": "今天天气不错"})
        self.assertIsNone(event)

    def test_build_stop_event_uses_index_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            memory_dir = Path(tmp)
            index_file = memory_dir / "MEMORY.md"
            index_file.write_text("", encoding="utf-8")
            with mock.patch("scripts.memory_hub.claude_hook_bridge.TARGET_PROJECT_CWD", Path("/tmp/project").resolve()), \
                 mock.patch("scripts.memory_hub.claude_hook_bridge.CLAUDE_MEMORY_DIR", memory_dir), \
                 mock.patch("scripts.memory_hub.claude_hook_bridge.CLAUDE_MEMORY_INDEX", index_file):
                event = build_stop_event({"cwd": "/tmp/project", "last_assistant_message": "已完成修改。"})

        self.assertIsNotNone(event)
        self.assertEqual(event["event_type"], "session_ending")
        self.assertEqual(event["source_file"], str(index_file))
        self.assertEqual(event["payload"]["memory_type"], "daily_log")
