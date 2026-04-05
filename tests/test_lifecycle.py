"""Tests for Agent Lifecycle Manager."""

import json
import os
import subprocess
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch

from openclaw.orchestrator.lifecycle import AgentLifecycleManager, AgentState


class FakeProcess:
    """Mock for subprocess.Popen."""

    def __init__(self, pid=12345, returncode=0):
        self.pid = pid
        self.returncode = returncode
        self._terminated = False
        self._wait_called = False

    def wait(self, timeout=None):
        self._wait_called = True
        if self._terminated:
            return self.returncode
        # Simulate process still running; if timeout and not terminated, raise TimeoutExpired
        if timeout is not None and not self._terminated:
            raise subprocess.TimeoutExpired(
                cmd="fake_cmd", timeout=timeout
            )
        return self.returncode

    def terminate(self):
        self._terminated = True
        self.returncode = -1  # terminated by signal

    def kill(self):
        self._terminated = True
        self.returncode = -9

    def poll(self):
        if self._terminated:
            return self.returncode
        return None


class TestAgentLifecycleManager(unittest.TestCase):
    """Test suite for AgentLifecycleManager."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.state_path = os.path.join(self.temp_dir, "state.json")
        self.manager = AgentLifecycleManager(state_file=self.state_path)
        # Mock time.time for deterministic timestamps
        self.original_time = time.time
        self.time_offset = 1000000
        self.time_counter = [self.time_offset]

        def fake_time():
            current = self.time_counter[0]
            self.time_counter[0] += 1
            return current

        self.time_patcher = patch("time.time", side_effect=fake_time)
        self.time_patcher.start()

    def tearDown(self):
        self.time_patcher.stop()
        # Cleanup temp dir
        try:
            import shutil
            shutil.rmtree(self.temp_dir)
        except Exception:
            pass

    def _make_fake_popen(self, pid=12345, returncode=0):
        proc = FakeProcess(pid=pid, returncode=returncode)
        return proc

    def test_start_agent_creates_running_state(self):
        """Test start_agent spawns process and marks agent as running."""
        fake_proc = self._make_fake_popen(pid=1001)
        with patch("subprocess.Popen", return_value=fake_proc) as mock_popen:
            state = self.manager.start_agent("agent1", "echo hello")

        self.assertEqual(state.status, "running")
        self.assertEqual(state.pid, 1001)
        self.assertEqual(state.command, "echo hello")
        self.assertIsNotNone(state.started_at)
        self.assertIn("agent1", self.manager.agents)
        self.assertEqual(self.manager.agents["agent1"], state)
        mock_popen.assert_called_once()

    def test_start_agent_saves_state_to_disk(self):
        """Test that starting an agent persists state."""
        fake_proc = self._make_fake_popen(pid=1002)
        with patch("subprocess.Popen", return_value=fake_proc):
            self.manager.start_agent("agent1", "sleep 10")

        # Check state file
        with open(self.state_path, "r") as f:
            data = json.load(f)
        self.assertIn("agent1", data)
        agent_data = data["agent1"]
        self.assertEqual(agent_data["status"], "running")
        self.assertEqual(agent_data["pid"], 1002)
        self.assertEqual(agent_data["command"], "sleep 10")

    def test_stop_agent_terminates_process_and_updates_state(self):
        """Test stop_agent stops the process and marks as stopped."""
        fake_proc = self._make_fake_popen(pid=1003, returncode=0)
        with patch("subprocess.Popen", return_value=fake_proc):
            state = self.manager.start_agent("agent1", "tail -f /dev/null")
        # Reset time counter for deterministic stopped_at
        self.time_counter[0] = self.time_offset + 100

        # Now stop
        final_state = self.manager.stop_agent("agent1")

        self.assertEqual(final_state.status, "stopped")
        self.assertIsNotNone(final_state.stopped_at)
        self.assertEqual(final_state.exit_code, 0)
        self.assertIsNone(self.manager._process_handles.get("agent1"))
        # Verify that os.killpg was called (we can't easily check because start_new_session uses setpgid)
        # Since we used fake_proc, we can't check kill; but we can ensure that the process was marked terminated.
        # In real code, os.killpg would be called with PID. For this test we could patch os.killpg.

    def test_stop_agent_when_not_running_returns_state(self):
        """Test stop_agent on a stopped agent does nothing."""
        # Manually add a stopped agent
        state = AgentState(agent_id="agent1", command="true", status="stopped", pid=None)
        self.manager.agents["agent1"] = state

        result = self.manager.stop_agent("agent1")
        self.assertEqual(result.status, "stopped")

    def test_restart_agent(self):
        """Test restart_agent stops and starts with new process."""
        fake_proc1 = self._make_fake_popen(pid=2001)
        fake_proc2 = self._make_fake_popen(pid=2002)
        # Use a side_effect to return different pids on successive calls
        popen_mock = MagicMock(side_effect=[fake_proc1, fake_proc2])

        with patch("subprocess.Popen", popen_mock):
            # Start
            state1 = self.manager.start_agent("agent1", "cmd1")
            self.assertEqual(state1.pid, 2001)
            # Reset time for stopped_at after restart
            self.time_counter[0] = self.time_offset + 50
            # Restart
            state2 = self.manager.restart_agent("agent1")

        self.assertEqual(state2.status, "running")
        self.assertEqual(state2.pid, 2002)
        self.assertEqual(state2.command, "cmd1")
        # After restart, handle should be present with new pid
        self.assertIn("agent1", self.manager._process_handles)
        self.assertEqual(self.manager._process_handles["agent1"].pid, 2002)

    def test_health_check_returns_status(self):
        """Test health_check returns correct info for running agent."""
        fake_proc = self._make_fake_popen(pid=3001)
        with patch("subprocess.Popen", return_value=fake_proc):
            self.manager.start_agent("agent1", "cmd")
        # Reset time for uptime calculation
        start_time = self.time_offset
        self.time_counter[0] = start_time + 5

        # Patch _is_process_alive to return True so health check thinks process is alive
        with patch.object(self.manager, "_is_process_alive", return_value=True):
            health = self.manager.health_check("agent1")
        self.assertEqual(health["status"], "running")
        self.assertEqual(health["pid"], 3001)
        self.assertEqual(health["uptime"], 5)
        self.assertIsNone(health["exit_code"])

    def test_health_check_detects_dead_process(self):
        """Test health_check marks agent as stopped if process no longer alive."""
        fake_proc = self._make_fake_popen(pid=4001, returncode=1)
        # Simulate process that died: _is_process_alive will return False if we kill it.
        with patch("subprocess.Popen", return_value=fake_proc):
            self.manager.start_agent("agent1", "false")
        # Mark the process as terminated to simulate it died outside manager
        fake_proc._terminated = True
        # Also os.kill should indicate not alive; we'll patch _is_process_alive to return False
        with patch.object(self.manager, "_is_process_alive", return_value=False):
            health = self.manager.health_check("agent1")
        self.assertEqual(health["status"], "stopped")
        # The state should be updated in the manager
        self.assertEqual(self.manager.agents["agent1"].status, "stopped")

    def test_state_persistence_across_restart(self):
        """Test that state is loaded from disk on manager initialization."""
        # Create a state file manually
        state_data = {
            "agent1": {
                "agent_id": "agent1",
                "command": "sleep 100",
                "pid": 9999,
                "status": "stopped",  # not running
                "started_at": 123456.0,
                "stopped_at": 123456.0 + 100,
                "exit_code": 0,
            }
        }
        with open(self.state_path, "w") as f:
            json.dump(state_data, f)

        # Create new manager (which loads state)
        new_manager = AgentLifecycleManager(state_file=self.state_path)
        self.assertIn("agent1", new_manager.agents)
        loaded_state = new_manager.agents["agent1"]
        self.assertEqual(loaded_state.agent_id, "agent1")
        self.assertEqual(loaded_state.command, "sleep 100")
        self.assertEqual(loaded_state.status, "stopped")

    def test_shutdown_stops_all_running_agents(self):
        """Test shutdown stops all running agents."""
        fake_proc = self._make_fake_popen(pid=5001)
        with patch("subprocess.Popen", return_value=fake_proc):
            self.manager.start_agent("agent1", "cmd1")
            self.manager.start_agent("agent2", "cmd2")
        # Ensure two running
        self.assertEqual(len(self.manager._process_handles), 2)

        self.manager.shutdown()

        self.assertEqual(len(self.manager._process_handles), 0)
        for state in self.manager.agents.values():
            self.assertEqual(state.status, "stopped")


if __name__ == "__main__":
    unittest.main()
