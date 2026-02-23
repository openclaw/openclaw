import subprocess
import sys
import os
import tempfile

SCRIPT = os.path.join(os.path.dirname(__file__), '..', 'scripts', 'check_ops_db.py')


def run(args):
    proc = subprocess.Popen([sys.executable, SCRIPT] + args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out, _ = proc.communicate()
    return proc.returncode, out.decode('utf-8', errors='replace')


def test_stub_runs_ok_or_issues():
    rc, out = run(['--stub'])
    assert rc in (0,1)
    assert 'STUB DB created' in out


def test_missing_db_returns_fatal():
    rc, out = run(['--db', '/nonexistent/path/does_not_exist.db'])
    assert rc == 2
    assert 'DB not found' in out


def test_apply_without_approve_returns_issues_code():
    # run stub with --apply but without --approve-recovery: should report issues (code 1)
    rc, out = run(['--stub', '--apply'])
    assert rc == 1
    assert 'Stuck entries found but --approve-recovery not provided' in out
