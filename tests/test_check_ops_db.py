import subprocess
import sys
import json
import os

SCRIPT = os.path.join(os.path.dirname(__file__), '..', 'scripts', 'check_ops_db.py')


def run(args):
    p = subprocess.run([sys.executable, SCRIPT] + args, capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr


def test_stub_runs_ok():
    rc, out, err = run(['--stub'])
    assert rc == 0
    assert 'STUB DB created' in out or 'Check run at' in out


def test_stub_json():
    rc, out, err = run(['--stub','--json'])
    assert rc == 0
    data = json.loads(out)
    assert 'db_path' in data
    assert data['problems_found'] in [True, False]


def test_missing_db_returns_fatal():
    rc, out, err = run(['--db','/nonexistent/path/db.sqlite'])
    assert rc == 2
    assert 'DB not found' in out or 'DB not found' in err
