import json
import subprocess
import sys
from pathlib import Path

import pytest

DENYLIST = Path(__file__).resolve().parent.parent / "denylist.yaml"


@pytest.fixture
def run_cli():
   def run(args):
       return subprocess.run(
           [sys.executable, "-m", "exec_denylist.cli", "-c", str(DENYLIST), args],
           captureoutput=True,
           text=True,
       )
   return run


class TestCLI:
   def testdenied_command_exits_1(self, run_cli):
       r = run_cli("check", "rm -rf /tmp/x")
       assert r.returncode == 1
       out = json.loads(r.stdout)
       assert out["denied"] is True

   def test_safe_command_exits_0(self, run_cli):
       r = run_cli("check", "echo hello")
       assert r.returncode == 0
       out = json.loads(r.stdout)
       assert out["denied"] is False

   def test_dry_run_exits_0(self, run_cli):
       r = run_cli("check", "--dry-run", "rm -rf /tmp/x")
       assert r.returncode == 0
       out = json.loads(r.stdout)
       assert out["denied"] is False
       assert out["dry_run"] is True

   def test_validate(self, run_cli):
       r = run_cli("validate")
       assert r.returncode == 0
       assert "Valid" in r.stdout

   def test_list_rules(self, run_cli):
       r = run_cli("list-rules")
       assert r.returncode == 0
       assert "critical" in r.stdout