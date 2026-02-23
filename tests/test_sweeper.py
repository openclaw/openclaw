"""Unit tests for autopilot_sweeper.py — all external I/O mocked."""
import json
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock, mock_open, patch

import pytest

SCRIPTS_DIR = str(Path(__file__).parent.parent / "scripts")
sys.path.insert(0, SCRIPTS_DIR)

# Patch db_connection import before importing the module under test
sys.modules.setdefault("shared", MagicMock())
sys.modules.setdefault("shared.db", MagicMock())

import autopilot_sweeper as sw


# ── fixtures ──────────────────────────────────────────────────────

@pytest.fixture
def default_state():
    return {
        "gateway_fail_streak": 0,
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
        data = {"gateway_fail_streak": 2, "worker_last_fix_ts": {"ron": 100},
                "disabled_crons": ["j1"], "last_run": "2026-01-01T00:00:00"}
        f.write_text(json.dumps(data))
        with patch.object(sw, "STATE_FILE", f):
            state = sw.load_state()
        assert state["gateway_fail_streak"] == 2
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
        sw.check_gateway(default_state)
        assert default_state["gateway_fail_streak"] == 0

    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    @patch("subprocess.run")
    @patch("socket.create_connection", side_effect=ConnectionRefusedError)
    def test_tcp_fails_within_cooldown_no_restart(self, mock_tcp, mock_sub, mock_log, mock_pb, default_state):
        default_state["gateway_last_fix_ts"] = time.time()  # just now
        sw.check_gateway(default_state)
        mock_sub.assert_not_called()

    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    @patch("time.sleep")
    @patch("subprocess.run")
    @patch("socket.create_connection")
    def test_tcp_fails_cooldown_expired_kickstart_attempted(self, mock_tcp, mock_sub, mock_sleep, mock_log, mock_pb, default_state):
        # First call: initial probe fails; second call (verify after restart): also fails
        mock_tcp.side_effect = ConnectionRefusedError
        mock_sub.return_value = MagicMock(returncode=0, stdout="", stderr="")
        default_state["gateway_last_fix_ts"] = 0  # long ago
        sw.check_gateway(default_state)
        mock_sub.assert_called_once()
        assert default_state["gateway_fail_streak"] == 1

    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    @patch("subprocess.run")
    @patch("socket.create_connection", side_effect=ConnectionRefusedError)
    def test_fail_streak_gte_max_gives_up(self, mock_tcp, mock_sub, mock_log, mock_pb, default_state):
        default_state["gateway_fail_streak"] = sw.GATEWAY_MAX_FAILS
        default_state["gateway_last_fix_ts"] = 0
        sw.check_gateway(default_state)
        mock_sub.assert_not_called()
        mock_pb.assert_called_once()
        assert "gave_up" in mock_pb.call_args[0][1]

    @patch("autopilot_sweeper.playbook_entry")
    @patch("autopilot_sweeper.log")
    @patch("time.sleep")
    @patch("subprocess.run")
    @patch("socket.create_connection")
    def test_kickstart_success_verified_resets_streak(self, mock_tcp, mock_sub, mock_sleep, mock_log, mock_pb, default_state):
        # Initial probe fails, verification probe succeeds
        ctx = MagicMock()
        ctx.__enter__ = MagicMock()
        ctx.__exit__ = MagicMock(return_value=False)
        mock_tcp.side_effect = [ConnectionRefusedError, ctx]
        mock_sub.return_value = MagicMock(returncode=0)
        default_state["gateway_last_fix_ts"] = 0
        default_state["gateway_fail_streak"] = 1
        sw.check_gateway(default_state)
        assert default_state["gateway_fail_streak"] == 0


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
