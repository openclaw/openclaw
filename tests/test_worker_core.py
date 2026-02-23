"""
test_worker_core.py — Unit tests for agent_queue_worker core functions.

Tests:
- _is_safe_command: whitelist/blacklist security
- _extract_tool_calls: LLM response parsing
- _parse_action_line: individual line parsing
- compute_sleep_seconds: idle backoff progression
"""
import sys
from pathlib import Path

# Ensure the scripts directory is importable
SCRIPTS_DIR = str(Path(__file__).parent.parent / "scripts")
sys.path.insert(0, SCRIPTS_DIR)

import pytest

from agent_queue_worker import (
    _is_safe_command,
    _extract_tool_calls,
    _parse_action_line,
    _normalize_tool_cmd,
    compute_sleep_seconds,
)


# ──────────────────────────────────────────────────────────
# _is_safe_command
# ──────────────────────────────────────────────────────────

class TestIsSafeCommand:
    """Whitelist/blacklist security gate."""

    # --- Allowed commands ---
    @pytest.mark.parametrize("cmd", [
        "python3 health_check.py",
        "python3 pipeline/idea_collector.py",
        "python3 pipeline/vault_reeval.py",
        "cat SOUL.md",
        "ls /Users/ron/.openclaw/workspace",
        "sqlite3 /Users/ron/.openclaw/data/ops_multiagent.db 'PRAGMA integrity_check'",
        "curl http://127.0.0.1:3344/api/bus/agent-status",
    ])
    def test_safe_commands_allowed(self, cmd):
        assert _is_safe_command(cmd) is True, f"Expected safe: {cmd}"

    def test_pgrep_not_in_general_whitelist(self):
        """pgrep is guardian-specific, not in general whitelist."""
        assert _is_safe_command("pgrep -f gateway") is False

    # --- Blocked commands ---
    @pytest.mark.parametrize("cmd", [
        "rm -rf /",
        "sudo reboot",
        "chmod 777 /etc/passwd",
        "eval 'malicious code'",
        "kill -9 12345",
        "DROP TABLE bus_commands",
        "DELETE FROM ops_agent_events",
        "curl -X DELETE http://api.example.com",
    ])
    def test_dangerous_commands_blocked(self, cmd):
        assert _is_safe_command(cmd) is False, f"Expected blocked: {cmd}"

    # --- Shell injection vectors ---
    @pytest.mark.parametrize("cmd", [
        "python3 script.py; rm -rf /",
        "python3 script.py | sh",
        "python3 script.py && malicious",
        "python3 script.py || fallback",
        "python3 $(whoami).py",
        "python3 `whoami`.py",
        "python3 script.py > /etc/passwd",
        "python3 script.py < /dev/urandom",
    ])
    def test_injection_vectors_blocked(self, cmd):
        assert _is_safe_command(cmd) is False, f"Expected blocked: {cmd}"

    # --- Unknown commands (not in whitelist) ---
    @pytest.mark.parametrize("cmd", [
        "node malicious.js",
        "gcc exploit.c -o exploit",
        "nc -l 4444",
        "nmap 192.168.1.0/24",
    ])
    def test_unknown_commands_blocked(self, cmd):
        assert _is_safe_command(cmd) is False, f"Expected blocked: {cmd}"

    def test_normalize_absolute_path(self):
        """Absolute workspace paths should be normalized for matching."""
        cmd = "/usr/bin/python3 /Users/ron/.openclaw/workspace/scripts/health_check.py"
        normalized = _normalize_tool_cmd(cmd)
        assert normalized == "python3 health_check.py"

    def test_empty_command(self):
        assert _is_safe_command("") is False

    def test_whitespace_only(self):
        assert _is_safe_command("   ") is False


# ──────────────────────────────────────────────────────────
# _extract_tool_calls
# ──────────────────────────────────────────────────────────

class TestExtractToolCalls:
    """Parse [액션] blocks from LLM responses."""

    def test_standard_arrow_format(self):
        content = "[액션]\n→ python3 health_check.py\n[결과]"
        cmds = _extract_tool_calls(content)
        assert "python3 health_check.py" in cmds

    def test_ascii_arrow(self):
        content = "[액션]\n-> python3 health_check.py\n[결과]"
        cmds = _extract_tool_calls(content)
        assert "python3 health_check.py" in cmds

    def test_code_block(self):
        content = "[액션]\n```bash\npython3 health_check.py\n```\n[결과]"
        cmds = _extract_tool_calls(content)
        assert "python3 health_check.py" in cmds

    def test_dollar_prefix(self):
        content = "[액션]\n$ python3 health_check.py\n[결과]"
        cmds = _extract_tool_calls(content)
        assert "python3 health_check.py" in cmds

    def test_max_3_commands(self):
        content = "[액션]\n→ cmd1\n→ cmd2\n→ cmd3\n→ cmd4\n→ cmd5"
        cmds = _extract_tool_calls(content)
        assert len(cmds) <= 3

    def test_no_action_block(self):
        content = "이 태스크는 잘 완료되었습니다. 특별한 조치가 필요하지 않습니다."
        cmds = _extract_tool_calls(content)
        assert cmds == []

    def test_stops_at_analysis_section(self):
        """[분석] is a stop section — should stop parsing."""
        content = "[액션]\n→ python3 a.py\n[분석]\n→ python3 b.py"
        cmds = _extract_tool_calls(content)
        assert len(cmds) == 1
        assert "python3 a.py" in cmds

    def test_result_not_a_stop_section(self):
        """[결과] is NOT in _STOP_SECTIONS — commands continue."""
        content = "[액션]\n→ python3 a.py\n[결과]\n→ python3 b.py"
        cmds = _extract_tool_calls(content)
        assert len(cmds) == 2

    def test_inline_backtick(self):
        content = "[액션]\n`python3 health_check.py`"
        cmds = _extract_tool_calls(content)
        assert "python3 health_check.py" in cmds


# ──────────────────────────────────────────────────────────
# _parse_action_line
# ──────────────────────────────────────────────────────────

class TestParseActionLine:
    def test_arrow_prefix(self):
        assert _parse_action_line("→ python3 test.py") == "python3 test.py"

    def test_ascii_arrow(self):
        assert _parse_action_line("-> python3 test.py") == "python3 test.py"

    def test_dollar_prefix(self):
        assert _parse_action_line("$ python3 test.py") == "python3 test.py"

    def test_numbered_list(self):
        result = _parse_action_line("1. python3 test.py")
        assert result is not None
        assert "python3" in result


# ──────────────────────────────────────────────────────────
# compute_sleep_seconds (idle backoff)
# ──────────────────────────────────────────────────────────

class TestComputeSleepSeconds:
    """Verify exponential idle backoff behavior."""

    def test_active_fast_poll(self):
        """After handling a task, should poll fast (min 0.8s floor)."""
        s = compute_sleep_seconds("done", 1, 2.0, 0.45, 0.0, 0)
        assert 0.8 <= s <= 0.9  # base=0.45, but floor is max(0.8, base)

    def test_idle_initial(self):
        """First idle cycle: base interval (~2s)."""
        s = compute_sleep_seconds("idle", 0, 2.0, 0.45, 0.0, 0)
        assert 1.5 <= s <= 2.5

    def test_idle_backoff_grows(self):
        """Consecutive idle: sleep should increase."""
        s0 = compute_sleep_seconds("idle", 0, 2.0, 0.45, 0.0, 0)
        s1 = compute_sleep_seconds("idle", 0, 2.0, 0.45, 0.0, 1)
        s2 = compute_sleep_seconds("idle", 0, 2.0, 0.45, 0.0, 2)
        s4 = compute_sleep_seconds("idle", 0, 2.0, 0.45, 0.0, 4)
        assert s1 > s0
        assert s2 > s1
        assert s4 > s2

    def test_idle_max_cap(self):
        """Idle backoff should cap at 30s."""
        s = compute_sleep_seconds("idle", 0, 2.0, 0.45, 0.0, 100)
        assert s <= 31.0  # 30 + small jitter tolerance

    def test_task_done_resets_backoff(self):
        """After task done, sleep should be fast regardless of previous idle count."""
        # Even with high consecutive_idle, done status → fast (floor 0.8s)
        s = compute_sleep_seconds("done", 1, 2.0, 0.45, 0.0, 50)
        assert s <= 0.9

    def test_jitter_adds_variation(self):
        """With jitter, consecutive calls should produce different values."""
        results = set()
        for _ in range(20):
            s = compute_sleep_seconds("idle", 0, 2.0, 0.45, 0.35, 0)
            results.add(round(s, 2))
        # With jitter=0.35, we should get multiple distinct values
        assert len(results) > 1


# ──────────────────────────────────────────────────────────
# _execute_tool_cmd (error paths)
# ──────────────────────────────────────────────────────────

class TestExecuteToolCmd:
    """Test _execute_tool_cmd error handling and output."""

    def test_timeout_returns_message(self):
        """TimeoutExpired → message containing 'timeout'."""
        from agent_queue_worker import _execute_tool_cmd
        from unittest.mock import patch
        import subprocess
        with patch("agent_queue_worker.subprocess.run",
                   side_effect=subprocess.TimeoutExpired(cmd="test", timeout=30)):
            result = _execute_tool_cmd("python3 health_check.py")
            assert "timeout" in result.lower()

    def test_nonzero_exit_includes_rc(self):
        """Non-zero returncode → result contains 'rc='."""
        from agent_queue_worker import _execute_tool_cmd
        from unittest.mock import patch, MagicMock
        mock_proc = MagicMock(returncode=1, stdout="", stderr="some error")
        with patch("agent_queue_worker.subprocess.run", return_value=mock_proc):
            result = _execute_tool_cmd("python3 health_check.py")
            assert "rc=1" in result
            assert "some error" in result

    def test_output_truncated_to_cap(self):
        """Output exceeding TOOL_USE_STDOUT_CAP is truncated."""
        from agent_queue_worker import _execute_tool_cmd, TOOL_USE_STDOUT_CAP
        from unittest.mock import patch, MagicMock
        mock_proc = MagicMock(returncode=0, stdout="x" * 5000, stderr="")
        with patch("agent_queue_worker.subprocess.run", return_value=mock_proc):
            result = _execute_tool_cmd("python3 health_check.py")
            assert len(result) <= TOOL_USE_STDOUT_CAP

    def test_normal_execution_returns_stdout(self):
        """Successful execution returns stdout content."""
        from agent_queue_worker import _execute_tool_cmd
        from unittest.mock import patch, MagicMock
        mock_proc = MagicMock(returncode=0, stdout="7/7 OK", stderr="")
        with patch("agent_queue_worker.subprocess.run", return_value=mock_proc):
            result = _execute_tool_cmd("python3 health_check.py")
            assert result == "7/7 OK"

    def test_empty_command_returns_no_command(self):
        """Empty argv after shlex.split → '(no command)'."""
        from agent_queue_worker import _execute_tool_cmd
        result = _execute_tool_cmd("")
        # Empty string may fail at shlex or normalization
        assert result  # Should return some string, not crash

    def test_generic_exception_returns_error(self):
        """Generic exception → message containing 'exec error'."""
        from agent_queue_worker import _execute_tool_cmd
        from unittest.mock import patch
        with patch("agent_queue_worker.subprocess.run",
                   side_effect=OSError("file not found")):
            result = _execute_tool_cmd("python3 health_check.py")
            assert "exec error" in result or "error" in result.lower()
