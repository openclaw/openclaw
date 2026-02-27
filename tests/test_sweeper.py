"""Unit tests for autopilot_sweeper.py — all external I/O mocked."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock, mock_open, patch

import pytest

SCRIPTS_DIR = str(Path(__file__).parent.parent / "scripts")
sys.path.insert(0, SCRIPTS_DIR)

# Patch shared.* imports before importing the module under test.
# Use a single parent MagicMock so submodules are consistent children.
_shared_mock = MagicMock()
sys.modules.setdefault("shared", _shared_mock)
sys.modules.setdefault("shared.db", _shared_mock.db)
sys.modules.setdefault("shared.gateway_guard", _shared_mock.gateway_guard)
sys.modules.setdefault("shared.telegram", _shared_mock.telegram)
sys.modules.setdefault("shared.log", _shared_mock.log)
sys.modules.setdefault("shared.llm", _shared_mock.llm)

import autopilot_sweeper as sw


# ── fixtures ──────────────────────────────────────────────────────

@pytest.fixture
def default_state():
    return {
        "gateway_fail_streak": 0,
        "gateway_next_retry_ts": 0,
        "worker_last_fix_ts": {},
        "disabled_crons": [],
        "last_run": None,
    }


# ── load_state / save_state ──────────────────────────────────────

class TestLoadState:
    def test_missing_file_returns_default(self, tmp_path):
        with patch.object(sw, "STATE_FILE", tmp_path / "missing.json"):
            state = sw.load_state()
        assert state["gateway_fail_streak"] == 0
        assert state["gateway_next_retry_ts"] == 0
        assert state["worker_last_fix_ts"] == {}
        assert state["disabled_crons"] == []
        assert state["last_run"] is None

    def test_corrupt_json_returns_default(self, tmp_path):
        bad = tmp_path / "bad.json"
        bad.write_text("{corrupt!!}")
        with patch.object(sw, "STATE_FILE", bad):
            state = sw.load_state()
        assert state["gateway_fail_streak"] == 0

    def test_valid_file_loads_correctly(self, tmp_path):
        f = tmp_path / "state.json"
        data = {"gateway_fail_streak": 2, "gateway_next_retry_ts": 10, "worker_last_fix_ts": {"ron": 100},
                "disabled_crons": ["j1"], "last_run": "2026-01-01T00:00:00"}
        f.write_text(json.dumps(data))
        with patch.object(sw, "STATE_FILE", f):
            state = sw.load_state()
        assert state["gateway_fail_streak"] == 2
        assert state["gateway_next_retry_ts"] == 10
        assert state["worker_last_fix_ts"]["ron"] == 100
        assert "j1" in state["disabled_crons"]


class TestSaveState:
    def test_writes_valid_json(self, tmp_path):
        out = tmp_path / "state.json"
        with patch.object(sw, "STATE_FILE", out):
            sw.save_state({"gateway_fail_streak": 1, "worker_last_fix_ts": {}})
        loaded = json.loads(out.read_text())
        assert loaded["gateway_fail_streak"] == 1
        assert "last_run" in loaded  # save_state injects this


# ── check_gateway ────────────────────────────────────────────────

class TestCheckGateway:
    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    @patch("socket.create_connection")
    def test_tcp_succeeds_no_restart(self, mock_tcp, mock_log, mock_pb, default_state):
        mock_tcp.return_value.__enter__ = MagicMock()
        mock_tcp.return_value.__exit__ = MagicMock(return_value=False)
        sw.check_gateway(default_state)
        assert default_state["gateway_fail_streak"] == 0
        mock_log.assert_called_with("Gateway: OK")

    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    @patch("socket.create_connection")
    def test_tcp_succeeds_resets_fail_streak(self, mock_tcp, mock_log, mock_pb, default_state):
        mock_tcp.return_value.__enter__ = MagicMock()
        mock_tcp.return_value.__exit__ = MagicMock(return_value=False)
        default_state["gateway_fail_streak"] = 2
        default_state["gateway_next_retry_ts"] = time.time() + 100
        sw.check_gateway(default_state)
        assert default_state["gateway_fail_streak"] == 0
        assert default_state["gateway_next_retry_ts"] == 0

    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    @patch("autopilot_sweeper.guarded_gateway_restart")
    @patch("socket.create_connection", side_effect=ConnectionRefusedError)
    def test_tcp_fails_within_cooldown_no_restart(self, mock_tcp, mock_restart, mock_log, mock_pb, default_state):
        default_state["gateway_next_retry_ts"] = time.time() + 120  # still cooling down
        sw.check_gateway(default_state)
        mock_restart.assert_not_called()

    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    @patch("autopilot_sweeper.guarded_gateway_restart")
    @patch("socket.create_connection", side_effect=ConnectionRefusedError)
    def test_tcp_fails_cooldown_expired_guarded_restart_attempted(self, mock_tcp, mock_restart, mock_log, mock_pb, default_state):
        mock_restart.return_value = {"ok": False, "reason": "rpc_unreachable"}
        default_state["gateway_next_retry_ts"] = 0
        sw.check_gateway(default_state)
        mock_restart.assert_called_once()
        assert default_state["gateway_fail_streak"] == 1
        assert default_state["gateway_next_retry_ts"] > time.time()

    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    @patch("autopilot_sweeper.guarded_gateway_restart")
    @patch("socket.create_connection", side_effect=ConnectionRefusedError)
    def test_fail_streak_gte_max_gives_up(self, mock_tcp, mock_restart, mock_log, mock_pb, default_state):
        with patch.object(sw, "GATEWAY_MAX_FAILS", 2):
            default_state["gateway_fail_streak"] = 2
            default_state["gateway_next_retry_ts"] = 0
            sw.check_gateway(default_state)
        mock_restart.assert_not_called()
        assert any("gave_up" in str(call) for call in mock_pb.call_args_list)

    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    @patch("autopilot_sweeper.guarded_gateway_restart")
    @patch("socket.create_connection", side_effect=ConnectionRefusedError)
    def test_guarded_restart_success_resets_streak(self, mock_tcp, mock_restart, mock_log, mock_pb, default_state):
        mock_restart.return_value = {"ok": True, "result": "restarted"}
        default_state["gateway_next_retry_ts"] = 0
        default_state["gateway_fail_streak"] = 1
        sw.check_gateway(default_state)
        assert default_state["gateway_fail_streak"] == 0
        assert default_state["gateway_next_retry_ts"] == 0


# ── check_workers ────────────────────────────────────────────────

class TestCheckWorkers:
    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    @patch("subprocess.run")
    def test_all_alive_no_action(self, mock_sub, mock_log, mock_pb, default_state):
        mock_sub.return_value = MagicMock(returncode=0, stdout="12345\n", stderr="")
        sw.check_workers(default_state)
        # Only pgrep calls, no launchctl kickstart
        for call in mock_sub.call_args_list:
            assert call[0][0][0] == "pgrep"
        mock_pb.assert_not_called()

    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    @patch("subprocess.run")
    def test_dead_worker_cooldown_ok_kickstart(self, mock_sub, mock_log, mock_pb, default_state):
        # pgrep fails (returncode=1), then launchctl kickstart succeeds
        pgrep_fail = MagicMock(returncode=1, stdout="", stderr="")
        kickstart_ok = MagicMock(returncode=0, stdout="", stderr="")
        mock_sub.side_effect = [pgrep_fail, kickstart_ok] * len(sw.WORKER_PLIST_MAP)
        sw.check_workers(default_state)
        # Should have kickstarted at least one worker
        assert mock_pb.call_count >= 1

    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    @patch("subprocess.run")
    def test_dead_worker_within_cooldown_no_kickstart(self, mock_sub, mock_log, mock_pb, default_state):
        pgrep_fail = MagicMock(returncode=1, stdout="", stderr="")
        mock_sub.return_value = pgrep_fail
        # Set all workers as recently fixed
        now = time.time()
        default_state["worker_last_fix_ts"] = {a: now for a in sw.WORKER_PLIST_MAP}
        sw.check_workers(default_state)
        # Only pgrep calls, no launchctl
        for call in mock_sub.call_args_list:
            assert call[0][0][0] == "pgrep"


# ── check_cron_stuck ─────────────────────────────────────────────

class TestCheckCronStuck:
    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    def test_running_under_threshold_no_flag(self, mock_log, mock_pb, tmp_path):
        jobs = [{"id": "job1", "status": "running",
                 "lastRunStarted": time.strftime("%Y-%m-%dT%H:%M:%S+00:00",
                                                  time.gmtime(time.time() - 300))}]  # 5 min ago
        jf = tmp_path / "jobs.json"
        jf.write_text(json.dumps(jobs))
        with patch.object(sw, "CRON_JOBS", jf):
            sw.check_cron_stuck()
        mock_pb.assert_not_called()

    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    def test_running_over_threshold_flagged(self, mock_log, mock_pb, tmp_path):
        jobs = [{"id": "job1", "status": "running",
                 "lastRunStarted": time.strftime("%Y-%m-%dT%H:%M:%S+00:00",
                                                  time.gmtime(time.time() - 1500))}]  # 25 min ago
        jf = tmp_path / "jobs.json"
        jf.write_text(json.dumps(jobs))
        with patch.object(sw, "CRON_JOBS", jf):
            sw.check_cron_stuck()
        mock_pb.assert_called_once()
        assert "cron_stuck" in mock_pb.call_args[0][0]

    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    def test_non_running_job_ignored(self, mock_log, mock_pb, tmp_path):
        jobs = [{"id": "job1", "status": "idle",
                 "lastRunStarted": time.strftime("%Y-%m-%dT%H:%M:%S+00:00",
                                                  time.gmtime(time.time() - 9999))}]
        jf = tmp_path / "jobs.json"
        jf.write_text(json.dumps(jobs))
        with patch.object(sw, "CRON_JOBS", jf):
            sw.check_cron_stuck()
        mock_pb.assert_not_called()

    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    def test_missing_jobs_file(self, mock_log, mock_pb, tmp_path):
        with patch.object(sw, "CRON_JOBS", tmp_path / "nonexistent.json"):
            sw.check_cron_stuck()  # should not raise
        mock_pb.assert_not_called()


# ── check_cron_failures ──────────────────────────────────────────

class TestCheckCronFailures:
    @patch("autopilot_sweeper.add_ops_todo")
    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    def test_below_threshold_no_action(self, mock_log, mock_pb, mock_todo, tmp_path, default_state):
        jobs = [{"id": "job1", "consecutiveFailures": 1}]
        jf = tmp_path / "jobs.json"
        jf.write_text(json.dumps(jobs))
        with patch.object(sw, "CRON_JOBS", jf):
            sw.check_cron_failures(default_state)
        mock_todo.assert_not_called()
        mock_pb.assert_not_called()

    @patch("autopilot_sweeper.add_ops_todo")
    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    def test_gte_threshold_flagged_and_disabled(self, mock_log, mock_pb, mock_todo, tmp_path, default_state):
        jobs = [{"id": "bad-job", "consecutiveFailures": sw.CRON_ERROR_THRESHOLD}]
        jf = tmp_path / "jobs.json"
        jf.write_text(json.dumps(jobs))
        with patch.object(sw, "CRON_JOBS", jf):
            sw.check_cron_failures(default_state)
        mock_todo.assert_called_once()
        mock_pb.assert_called_once()
        assert "bad-job" in default_state["disabled_crons"]

    @patch("autopilot_sweeper.add_ops_todo")
    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    def test_already_disabled_skipped(self, mock_log, mock_pb, mock_todo, tmp_path, default_state):
        jobs = [{"id": "bad-job", "consecutiveFailures": 10}]
        jf = tmp_path / "jobs.json"
        jf.write_text(json.dumps(jobs))
        default_state["disabled_crons"] = ["bad-job"]
        with patch.object(sw, "CRON_JOBS", jf):
            sw.check_cron_failures(default_state)
        mock_todo.assert_not_called()

    @patch("autopilot_sweeper.add_ops_todo")
    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    def test_missing_jobs_file(self, mock_log, mock_pb, mock_todo, tmp_path, default_state):
        with patch.object(sw, "CRON_JOBS", tmp_path / "nonexistent.json"):
            sw.check_cron_failures(default_state)
        mock_todo.assert_not_called()


# ── check_queue_jam ──────────────────────────────────────────────

class TestCheckQueueJam:
    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    @patch("autopilot_sweeper.db_connection")
    def test_few_recent_items_no_jam(self, mock_db, mock_log, mock_pb):
        mock_conn = MagicMock()
        mock_conn.execute.return_value.fetchone.return_value = {"cnt": 2}
        mock_db.return_value.__enter__ = MagicMock(return_value=mock_conn)
        mock_db.return_value.__exit__ = MagicMock(return_value=False)
        with patch.object(sw, "DB_PATH", Path("/fake/db")):
            with patch.object(Path, "exists", return_value=True):
                sw.check_queue_jam()
        mock_pb.assert_not_called()

    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    @patch("autopilot_sweeper.db_connection")
    def test_many_old_items_jam_detected(self, mock_db, mock_log, mock_pb):
        mock_conn = MagicMock()
        mock_conn.execute.return_value.fetchone.return_value = {"cnt": 10}
        mock_db.return_value.__enter__ = MagicMock(return_value=mock_conn)
        mock_db.return_value.__exit__ = MagicMock(return_value=False)
        with patch.object(sw, "DB_PATH", Path("/fake/db")):
            with patch.object(Path, "exists", return_value=True):
                sw.check_queue_jam()
        mock_pb.assert_called_once()
        assert "queue_jam" in mock_pb.call_args[0][0]

    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    def test_missing_db_no_error(self, mock_log, mock_pb, tmp_path):
        with patch.object(sw, "DB_PATH", tmp_path / "nonexistent.db"):
            sw.check_queue_jam()
        mock_pb.assert_not_called()


# ── check_disk_growth ───────────────────────────────────────────

class TestDirSizeMb:
    @patch("subprocess.run")
    def test_normal_output(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout="1048576\t/some/dir", stderr="")
        result = sw._dir_size_mb(Path("/some/dir"))
        assert result == 1048576 / 1024  # ~1024 MB

    @patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="du", timeout=10))
    def test_timeout_returns_zero(self, mock_run):
        result = sw._dir_size_mb(Path("/some/dir"))
        assert result == 0

    @patch("subprocess.run")
    def test_nonzero_rc_returns_zero(self, mock_run):
        mock_run.return_value = MagicMock(returncode=1, stdout="", stderr="error")
        result = sw._dir_size_mb(Path("/some/dir"))
        assert result == 0


class TestSendTelegramDm:
    """Tests for shared.telegram integration via _tg_send_dm alias."""

    def _real_telegram(self):
        """Import the real shared.telegram module (not the mocked one)."""
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "shared.telegram_real",
            Path(__file__).parent.parent / "scripts" / "shared" / "telegram.py",
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_no_token_returns_false(self):
        tg = self._real_telegram()
        orig = tg._bot_token_cache
        try:
            tg._bot_token_cache = ""
            assert tg.send_dm("test message") is False
        finally:
            tg._bot_token_cache = orig

    def test_network_error_no_crash(self):
        import urllib.error
        tg = self._real_telegram()
        orig = tg._bot_token_cache
        try:
            tg._bot_token_cache = "fake-token"
            with patch("urllib.request.urlopen",
                       side_effect=urllib.error.URLError("network down")):
                result = tg.send_dm("test message")
            assert result is False
        finally:
            tg._bot_token_cache = orig


class TestCheckDiskGrowth:
    """Tests for check_disk_growth() — disk growth monitoring."""

    def _make_state(self, alert_ts=0):
        return {"disk_alert_last_ts": alert_ts}

    @patch("autopilot_sweeper._tg_send_dm")
    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    def test_small_dirs_no_alert(self, mock_log, mock_pb, mock_dm, tmp_path):
        """Directories below threshold → no alerts."""
        scan = tmp_path / "memory"
        scan.mkdir()
        (scan / "small_dir").mkdir()
        (scan / "small_dir" / "f.txt").write_text("x" * 100)
        state = self._make_state()
        with patch.object(sw, "DISK_SCAN_DIRS", [scan]):
            with patch.object(sw, "_dir_size_mb", return_value=50):
                with patch("shutil.disk_usage", return_value=MagicMock(free=50 * 1024**3)):
                    sw.check_disk_growth(state)
        mock_dm.assert_not_called()
        # playbook should not record detection
        assert all("detected" not in str(c) for c in mock_pb.call_args_list) if mock_pb.call_args_list else True

    @patch("autopilot_sweeper._tg_send_dm")
    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    def test_large_dir_triggers_alert(self, mock_log, mock_pb, mock_dm, tmp_path):
        """Directory >1GB → telegram DM alert."""
        scan = tmp_path / "memory"
        scan.mkdir()
        big = scan / "some_big_dir"
        big.mkdir()
        state = self._make_state(0)  # cooldown expired
        with patch.object(sw, "DISK_SCAN_DIRS", [scan]):
            with patch.object(sw, "_dir_size_mb", return_value=2000):
                with patch("shutil.disk_usage", return_value=MagicMock(free=50 * 1024**3)):
                    sw.check_disk_growth(state)
        mock_dm.assert_called_once()
        assert "MANUAL CHECK" in mock_dm.call_args[0][0]

    @patch("autopilot_sweeper._tg_send_dm")
    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    def test_evidence_pattern_auto_deleted(self, mock_log, mock_pb, mock_dm, tmp_path):
        """evidence_* pattern directory → auto-deleted."""
        scan = tmp_path / "memory"
        scan.mkdir()
        bad = scan / "evidence_20260219"
        bad.mkdir()
        (bad / "file.bin").write_bytes(b"\x00" * 100)
        state = self._make_state(0)
        with patch.object(sw, "DISK_SCAN_DIRS", [scan]):
            with patch.object(sw, "_dir_size_mb", return_value=1500):
                with patch("shutil.disk_usage", return_value=MagicMock(free=50 * 1024**3)):
                    sw.check_disk_growth(state)
        assert not bad.exists(), "evidence_* dir should be auto-deleted"
        assert any("auto_deleted" in str(c) for c in mock_pb.call_args_list)

    @patch("autopilot_sweeper._tg_send_dm")
    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    def test_recovery_pattern_file_auto_deleted(self, mock_log, mock_pb, mock_dm, tmp_path):
        """recovery-* pattern file >1GB → auto-deleted."""
        scan = tmp_path / "archives"
        scan.mkdir()
        big_file = scan / "recovery-2026-02-19.tar.gz"
        big_file.write_bytes(b"\x00" * 100)
        state = self._make_state(0)
        with patch.object(sw, "DISK_SCAN_DIRS", [scan]):
            with patch.object(sw, "SUBDIR_SIZE_LIMIT_MB", 0):  # trigger on any size
                with patch("shutil.disk_usage", return_value=MagicMock(free=50 * 1024**3)):
                    sw.check_disk_growth(state)
        assert not big_file.exists(), "recovery-* file should be auto-deleted"

    @patch("autopilot_sweeper._tg_send_dm")
    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    def test_non_matching_not_deleted(self, mock_log, mock_pb, mock_dm, tmp_path):
        """Non-matching large directory → alert only, NOT deleted."""
        scan = tmp_path / "memory"
        scan.mkdir()
        legit = scan / "important_data"
        legit.mkdir()
        (legit / "f.bin").write_bytes(b"\x00" * 100)
        state = self._make_state(0)
        with patch.object(sw, "DISK_SCAN_DIRS", [scan]):
            with patch.object(sw, "_dir_size_mb", return_value=2000):
                with patch("shutil.disk_usage", return_value=MagicMock(free=50 * 1024**3)):
                    sw.check_disk_growth(state)
        assert legit.exists(), "Non-matching dir should NOT be deleted"
        mock_dm.assert_called_once()

    @patch("autopilot_sweeper._tg_send_dm")
    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    def test_cooldown_prevents_spam(self, mock_log, mock_pb, mock_dm, tmp_path):
        """Within cooldown → no DM sent even for large dirs."""
        scan = tmp_path / "memory"
        scan.mkdir()
        big = scan / "huge_thing"
        big.mkdir()
        state = self._make_state(time.time())  # just alerted
        with patch.object(sw, "DISK_SCAN_DIRS", [scan]):
            with patch.object(sw, "_dir_size_mb", return_value=5000):
                with patch("shutil.disk_usage", return_value=MagicMock(free=50 * 1024**3)):
                    sw.check_disk_growth(state)
        mock_dm.assert_not_called()

    @patch("autopilot_sweeper._tg_send_dm")
    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    def test_stale_reflection_cleanup(self, mock_log, mock_pb, mock_dm, tmp_path):
        """Files in memory/reflection older than 30 days → auto-deleted."""
        refl_dir = tmp_path / "memory" / "reflection"
        refl_dir.mkdir(parents=True)
        old_file = refl_dir / "old-analysis.md"
        old_file.write_text("stale data")
        # Set mtime to 60 days ago
        old_mtime = time.time() - (60 * 86400)
        os.utime(old_file, (old_mtime, old_mtime))
        recent_file = refl_dir / "recent.md"
        recent_file.write_text("fresh data")
        state = self._make_state(0)
        with patch.object(sw, "DISK_SCAN_DIRS", []):
            with patch.object(sw, "WORKSPACE", tmp_path):
                with patch("shutil.disk_usage", return_value=MagicMock(free=50 * 1024**3)):
                    sw.check_disk_growth(state)
        assert not old_file.exists(), "Old reflection file should be deleted"
        assert recent_file.exists(), "Recent file should be kept"

    @patch("autopilot_sweeper._tg_send_dm")
    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    def test_low_disk_urgent_alert(self, mock_log, mock_pb, mock_dm, tmp_path):
        """Free disk <5GB → urgent DM."""
        state = self._make_state(0)
        with patch.object(sw, "DISK_SCAN_DIRS", []):
            with patch.object(sw, "WORKSPACE", tmp_path):
                with patch("shutil.disk_usage", return_value=MagicMock(free=3 * 1024**3)):
                    sw.check_disk_growth(state)
        mock_dm.assert_called_once()
        assert "LOW DISK" in mock_dm.call_args[0][0]

    @patch("autopilot_sweeper._tg_send_dm")
    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    def test_missing_dir_no_error(self, mock_log, mock_pb, mock_dm, tmp_path):
        """Non-existent scan directories → no errors."""
        state = self._make_state(0)
        with patch.object(sw, "DISK_SCAN_DIRS", [tmp_path / "nonexistent"]):
            with patch.object(sw, "WORKSPACE", tmp_path):
                with patch("shutil.disk_usage", return_value=MagicMock(free=50 * 1024**3)):
                    sw.check_disk_growth(state)
        mock_dm.assert_not_called()


# ── expire_stale_system_todos ─────────────────────────────────

class TestExpireStaleSystemTodos:
    """Test system todo auto-expiry."""

    @pytest.fixture
    def todo_db(self, tmp_path):
        """Create a temporary DB with ops_todos table."""
        import sqlite3
        db = tmp_path / "test.db"
        conn = sqlite3.connect(str(db))
        conn.execute("""CREATE TABLE ops_todos (
            id INTEGER PRIMARY KEY,
            title TEXT, detail TEXT, status TEXT DEFAULT 'todo',
            priority TEXT DEFAULT 'normal', source TEXT,
            created_at TEXT, completed_at TEXT, updated_at TEXT,
            assigned_to TEXT
        )""")
        conn.commit()
        conn.close()
        return db

    def _seed(self, db, items):
        import sqlite3
        conn = sqlite3.connect(str(db))
        for it in items:
            conn.execute(
                """INSERT INTO ops_todos(title, status, source, created_at)
                   VALUES (?, ?, ?, ?)""",
                (it["title"], it.get("status", "todo"),
                 it.get("source"), it["created_at"]),
            )
        conn.commit()
        conn.close()

    def _count_open(self, db):
        import sqlite3
        conn = sqlite3.connect(str(db))
        n = conn.execute(
            "SELECT count(*) FROM ops_todos WHERE status IN ('todo','doing','blocked')"
        ).fetchone()[0]
        conn.close()
        return n

    @patch("autopilot_sweeper.log")
    def test_expires_old_system_todos(self, mock_log, todo_db):
        import datetime
        old_date = (datetime.datetime.now() - datetime.timedelta(days=14)).strftime("%Y-%m-%d %H:%M:%S")
        recent_date = (datetime.datetime.now() - datetime.timedelta(days=2)).strftime("%Y-%m-%d %H:%M:%S")
        self._seed(todo_db, [
            {"title": "old system", "source": "system", "created_at": old_date},
            {"title": "old null", "source": None, "created_at": old_date},
            {"title": "recent system", "source": "system", "created_at": recent_date},
        ])
        with patch.object(sw, "DB_PATH", todo_db):
            expired = sw.expire_stale_system_todos()
        assert expired == 2
        assert self._count_open(todo_db) == 1  # only "recent system" remains

    @patch("autopilot_sweeper.log")
    def test_preserves_user_todos(self, mock_log, todo_db):
        self._seed(todo_db, [
            {"title": "해리 할일", "source": "telegram", "created_at": "2026-01-01 00:00:00"},
            {"title": "claude 할일", "source": "claude", "created_at": "2026-01-01 00:00:00"},
        ])
        with patch.object(sw, "DB_PATH", todo_db):
            expired = sw.expire_stale_system_todos()
        assert expired == 0
        assert self._count_open(todo_db) == 2

    @patch("autopilot_sweeper.log")
    def test_no_db_returns_zero(self, mock_log, tmp_path):
        with patch.object(sw, "DB_PATH", tmp_path / "nonexistent.db"):
            assert sw.expire_stale_system_todos() == 0

    @patch("autopilot_sweeper.log")
    def test_already_done_not_touched(self, mock_log, todo_db):
        self._seed(todo_db, [
            {"title": "already done", "source": "system",
             "status": "done", "created_at": "2026-01-01 00:00:00"},
        ])
        with patch.object(sw, "DB_PATH", todo_db):
            expired = sw.expire_stale_system_todos()
        assert expired == 0
