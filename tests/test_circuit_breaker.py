"""
test_circuit_breaker.py — Unit tests for orchestrator circuit breaker logic.

Tests:
- Global CB: _is_system_degraded (DB failure rate)
- Cron CB: check_cron_circuit_breaker (consecutive errors in jobs.json)
- Bus CB: _update_circuit_breakers (error signature tracking)
- Bus CB: _is_bus_cb_tripped (tripped breaker blocks matching commands)
- Error signature: _compute_error_signature (pattern extraction)
"""
import datetime
import json
import sqlite3
from unittest.mock import patch, MagicMock

import pytest

import orchestrator as orch


# ============================================================
# Global Circuit Breaker: _is_system_degraded
# ============================================================

class TestIsSystemDegraded:
    """Test global circuit breaker based on bus_commands failure rate."""

    def test_trips_when_failure_rate_above_threshold(self, tmp_db):
        """60%+ failures with >= 5 commands -> degraded."""
        conn = sqlite3.connect(tmp_db)
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        for i in range(3):
            conn.execute(
                "INSERT INTO bus_commands (title, status, created_at) VALUES (?, 'done', ?)",
                (f"ok-{i}", now))
        for i in range(7):
            conn.execute(
                "INSERT INTO bus_commands (title, status, created_at) VALUES (?, 'failed', ?)",
                (f"fail-{i}", now))
        conn.commit()
        conn.close()

        with patch.object(orch, 'DATA_DB', tmp_db):
            assert orch._is_system_degraded() is True

    def test_no_trip_below_threshold(self, tmp_db):
        """40% failure rate (below 60%) -> not degraded."""
        conn = sqlite3.connect(tmp_db)
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        for i in range(6):
            conn.execute(
                "INSERT INTO bus_commands (title, status, created_at) VALUES (?, 'done', ?)",
                (f"ok-{i}", now))
        for i in range(4):
            conn.execute(
                "INSERT INTO bus_commands (title, status, created_at) VALUES (?, 'failed', ?)",
                (f"fail-{i}", now))
        conn.commit()
        conn.close()

        with patch.object(orch, 'DATA_DB', tmp_db):
            assert orch._is_system_degraded() is False

    def test_no_trip_below_min_commands(self, tmp_db):
        """100% failure rate but only 3 commands (< 5 min) -> not degraded."""
        conn = sqlite3.connect(tmp_db)
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        for i in range(3):
            conn.execute(
                "INSERT INTO bus_commands (title, status, created_at) VALUES (?, 'failed', ?)",
                (f"fail-{i}", now))
        conn.commit()
        conn.close()

        with patch.object(orch, 'DATA_DB', tmp_db):
            assert orch._is_system_degraded() is False

    def test_no_trip_with_empty_db(self, tmp_db):
        """Empty DB -> not degraded."""
        with patch.object(orch, 'DATA_DB', tmp_db):
            assert orch._is_system_degraded() is False

    def test_old_commands_outside_window(self, tmp_db):
        """Commands older than the window are not counted."""
        conn = sqlite3.connect(tmp_db)
        # Use a time far enough in the past to be outside the window
        # regardless of timezone differences between Python and SQLite
        old_time = (datetime.datetime.now() - datetime.timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
        for i in range(10):
            conn.execute(
                "INSERT INTO bus_commands (title, status, created_at) VALUES (?, 'failed', ?)",
                (f"old-fail-{i}", old_time))
        conn.commit()
        conn.close()

        with patch.object(orch, 'DATA_DB', tmp_db):
            assert orch._is_system_degraded() is False


# ============================================================
# Cron Circuit Breaker: check_cron_circuit_breaker
# ============================================================

class TestCheckCronCircuitBreaker:
    """Test cron job circuit breaker (consecutive error threshold)."""

    def _make_jobs(self, tmp_path, jobs):
        """Write a jobs.json file and return its path."""
        jobs_file = tmp_path / "jobs.json"
        jobs_file.write_text(json.dumps({"jobs": jobs}, ensure_ascii=False))
        return str(jobs_file)

    def test_disables_job_over_threshold(self, tmp_path):
        """Job with consecutiveErrors >= 5 gets disabled."""
        jobs = [{
            "name": "broken-cron",
            "enabled": True,
            "state": {"consecutiveErrors": 7, "lastError": "timeout"}
        }]
        jobs_file = self._make_jobs(tmp_path, jobs)

        state = {"last_circuit_breaker_check": ""}
        with patch.object(orch, 'CRON_JOBS_FILE', jobs_file), \
             patch.object(orch, 'run_memory_command', return_value=True), \
             patch.object(orch, 'bus_write'):
            result = orch.check_cron_circuit_breaker(state)

        assert result == 1
        data = json.loads(open(jobs_file).read())
        assert data["jobs"][0]["enabled"] is False

    def test_keeps_job_below_threshold(self, tmp_path):
        """Job with consecutiveErrors < 5 stays enabled."""
        jobs = [{
            "name": "healthy-cron",
            "enabled": True,
            "state": {"consecutiveErrors": 3}
        }]
        jobs_file = self._make_jobs(tmp_path, jobs)

        state = {"last_circuit_breaker_check": ""}
        with patch.object(orch, 'CRON_JOBS_FILE', jobs_file), \
             patch.object(orch, 'run_memory_command', return_value=True), \
             patch.object(orch, 'bus_write'):
            result = orch.check_cron_circuit_breaker(state)

        assert result == 0
        data = json.loads(open(jobs_file).read())
        assert data["jobs"][0]["enabled"] is True

    def test_skips_already_disabled_jobs(self, tmp_path):
        """Already disabled jobs are not counted."""
        jobs = [{
            "name": "already-off",
            "enabled": False,
            "state": {"consecutiveErrors": 99}
        }]
        jobs_file = self._make_jobs(tmp_path, jobs)

        state = {"last_circuit_breaker_check": ""}
        with patch.object(orch, 'CRON_JOBS_FILE', jobs_file), \
             patch.object(orch, 'run_memory_command', return_value=True), \
             patch.object(orch, 'bus_write'):
            result = orch.check_cron_circuit_breaker(state)

        assert result == 0

    def test_disables_multiple_jobs(self, tmp_path):
        """Multiple broken jobs all get disabled."""
        jobs = [
            {"name": "cron-a", "enabled": True, "state": {"consecutiveErrors": 5}},
            {"name": "cron-b", "enabled": True, "state": {"consecutiveErrors": 10}},
            {"name": "cron-c", "enabled": True, "state": {"consecutiveErrors": 2}},
        ]
        jobs_file = self._make_jobs(tmp_path, jobs)

        state = {"last_circuit_breaker_check": ""}
        with patch.object(orch, 'CRON_JOBS_FILE', jobs_file), \
             patch.object(orch, 'run_memory_command', return_value=True), \
             patch.object(orch, 'bus_write'):
            result = orch.check_cron_circuit_breaker(state)

        assert result == 2
        data = json.loads(open(jobs_file).read())
        assert data["jobs"][0]["enabled"] is False  # cron-a: disabled
        assert data["jobs"][1]["enabled"] is False  # cron-b: disabled
        assert data["jobs"][2]["enabled"] is True   # cron-c: kept

    def test_interval_check_throttles(self, tmp_path):
        """If interval hasn't passed, function returns 0 without checking."""
        jobs = [{
            "name": "broken",
            "enabled": True,
            "state": {"consecutiveErrors": 99}
        }]
        jobs_file = self._make_jobs(tmp_path, jobs)

        recent_ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        state = {"last_circuit_breaker_check": recent_ts}
        with patch.object(orch, 'CRON_JOBS_FILE', jobs_file):
            result = orch.check_cron_circuit_breaker(state)

        assert result == 0
        # Job should still be enabled (wasn't checked)
        data = json.loads(open(jobs_file).read())
        assert data["jobs"][0]["enabled"] is True

    def test_missing_jobs_file(self, tmp_path):
        """Missing jobs.json returns 0 gracefully."""
        state = {"last_circuit_breaker_check": ""}
        with patch.object(orch, 'CRON_JOBS_FILE', str(tmp_path / "nonexistent.json")):
            result = orch.check_cron_circuit_breaker(state)
        assert result == 0


# ============================================================
# Error Signature Computation
# ============================================================

class TestComputeErrorSignature:
    """Test _compute_error_signature pattern matching."""

    def test_file_not_found(self):
        sig = orch._compute_error_signature("run script", "FileNotFoundError: '/path/to/missing.py'")
        assert sig.startswith("missing:")
        assert "missing.py" in sig

    def test_http_error_code(self):
        sig = orch._compute_error_signature("api call", "HTTP 502 Bad Gateway")
        assert sig == "http:502"

    def test_path_guard(self):
        sig = orch._compute_error_signature("PATH-GUARD check", "missing file: '/some/path.md'")
        assert sig.startswith("path-guard:")

    def test_generic_fallback(self):
        sig = orch._compute_error_signature("test", "some random error message")
        assert sig.startswith("generic:")


# ============================================================
# Bus Circuit Breaker: _update_circuit_breakers
# ============================================================

class TestUpdateCircuitBreakers:
    """Test bus_commands circuit breaker state updates."""

    def test_trips_after_threshold_hits(self, tmp_db):
        """3 same-signature failures -> trips breaker."""
        conn = sqlite3.connect(tmp_db)
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        for i in range(3):
            conn.execute(
                "INSERT INTO bus_commands (title, target_agent, status, result_note, completed_at) "
                "VALUES (?, 'ron', 'failed', ?, ?)",
                (f"test-cmd-{i}", "FileNotFoundError: '/scripts/missing.py'", now))
        conn.commit()
        conn.close()

        state = {"circuit_breakers": {}}
        with patch.object(orch, 'OPS_DB', tmp_db), \
             patch.object(orch, 'DATA_DB', tmp_db), \
             patch('orchestrator._cb_send_telegram_dm'):
            orch._update_circuit_breakers(state)

        breakers = state["circuit_breakers"]
        # At least one breaker should be tripped
        tripped = [k for k, v in breakers.items() if v.get("tripped_at")]
        assert len(tripped) >= 1

    def test_no_trip_below_threshold(self, tmp_db):
        """1 failure -> no trip."""
        conn = sqlite3.connect(tmp_db)
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        conn.execute(
            "INSERT INTO bus_commands (title, target_agent, status, result_note, completed_at) "
            "VALUES (?, 'ron', 'failed', ?, ?)",
            ("single-fail", "some error", now))
        conn.commit()
        conn.close()

        state = {"circuit_breakers": {}}
        with patch.object(orch, 'OPS_DB', tmp_db), \
             patch.object(orch, 'DATA_DB', tmp_db), \
             patch('orchestrator._cb_send_telegram_dm'):
            orch._update_circuit_breakers(state)

        breakers = state["circuit_breakers"]
        tripped = [k for k, v in breakers.items() if v.get("tripped_at")]
        assert len(tripped) == 0

    def test_expires_old_tripped_breaker(self):
        """Tripped breaker older than 24h gets expired."""
        old_time = (datetime.datetime.now() - datetime.timedelta(hours=25)).strftime("%Y-%m-%d %H:%M:%S")
        state = {
            "circuit_breakers": {
                "generic:abc123|ron": {
                    "count": 5,
                    "first_seen": old_time,
                    "tripped_at": old_time,
                    "last_title": "old failure"
                }
            }
        }

        with patch('orchestrator.ops_db_query', return_value=[]), \
             patch('orchestrator._cb_send_telegram_dm'):
            orch._update_circuit_breakers(state)

        assert len(state["circuit_breakers"]) == 0


# ============================================================
# Bus Circuit Breaker: _is_bus_cb_tripped
# ============================================================

class TestIsBusCbTripped:
    """Test _is_bus_cb_tripped checking logic."""

    def test_tripped_breaker_blocks_matching_command(self):
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        state = {
            "circuit_breakers": {
                "missing:/scripts/broken.py|ron": {
                    "count": 3,
                    "first_seen": now,
                    "tripped_at": now,
                    "last_title": "run broken.py"
                }
            }
        }
        tripped, sig = orch._is_bus_cb_tripped(state, "run broken.py script", "ron")
        assert tripped is True
        assert "missing:" in sig

    def test_no_breakers_returns_false(self):
        state = {}
        tripped, sig = orch._is_bus_cb_tripped(state, "some command", "ron")
        assert tripped is False

    def test_untripped_breaker_does_not_block(self):
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        state = {
            "circuit_breakers": {
                "missing:/scripts/broken.py|ron": {
                    "count": 1,
                    "first_seen": now,
                    "tripped_at": None,
                    "last_title": "run broken.py"
                }
            }
        }
        tripped, sig = orch._is_bus_cb_tripped(state, "run broken.py script", "ron")
        assert tripped is False

    def test_different_agent_not_blocked(self):
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        state = {
            "circuit_breakers": {
                "missing:/scripts/broken.py|codex": {
                    "count": 3,
                    "first_seen": now,
                    "tripped_at": now,
                    "last_title": "run broken.py"
                }
            }
        }
        tripped, sig = orch._is_bus_cb_tripped(state, "run broken.py script", "ron")
        assert tripped is False

    def test_path_guard_breaker_blocks_related(self):
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        state = {
            "circuit_breakers": {
                "path-guard:sample.md|ron": {
                    "count": 3,
                    "first_seen": now,
                    "tripped_at": now,
                    "last_title": "PATH-GUARD check"
                }
            }
        }
        tripped, sig = orch._is_bus_cb_tripped(state, "PATH-GUARD file check", "ron")
        assert tripped is True
        assert "path-guard:" in sig
