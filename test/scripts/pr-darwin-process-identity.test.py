"""Run with python3 -I -B test/scripts/pr-darwin-process-identity.test.py.

No app graph or network needed. Integration cases use only owned temporary Git
repositories and process groups; the real v3 shell and supervisor are exercised.
"""
import ctypes
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
PROVIDER = ROOT / 'scripts/pr-lib/darwin-process-identity.py'
LOCK = ROOT / 'scripts/pr-lib/operation-lock.sh'
RUNNER = ROOT / 'scripts/pr-lib/process-group-runner.mjs'
spec = importlib.util.spec_from_file_location('pr_identity', PROVIDER)
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)
BASH = shutil.which('bash')
NODE = shutil.which('node')
GIT = shutil.which('git')


def run(args, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, timeout=20, **kwargs)


class DecodeTests(unittest.TestCase):
    def valid(self):
        value = identity.BsdInfo()
        value.pid, value.pgid, value.status = 123, 122, 2
        value.start_sec, value.start_usec = 1767225600, 123456
        return value

    def test_abi(self):
        self.assertEqual(ctypes.sizeof(identity.BsdInfo), 136)
        self.assertEqual(identity.BsdInfo.start_sec.offset, 120)
        self.assertEqual(identity.BsdInfo.pgid.offset, 100)

    def test_invalid_pid(self):
        for value in ('', '0', '1', '-1', '+2', '02', '2.0', '٢', '2147483648', '2\n'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                identity.parse_pid(value)
        self.assertEqual(identity.parse_pid('2147483647'), 2147483647)

    def test_absent_denied_and_truncated_are_unknown(self):
        for size, err in ((0, errno.ESRCH), (0, errno.EPERM), (-1, errno.EACCES), (135, 0), (137, 0), (136, errno.EPERM)):
            with self.subTest(size=size, err=err), self.assertRaises(ValueError):
                identity.decode_info(123, self.valid(), size, err)

    def test_malformed_and_wrong_pid_are_unknown(self):
        for field, value in (('pid', 124), ('pgid', 0), ('pgid', 0xffffffff), ('status', 0), ('status', 6), ('start_sec', 0), ('start_sec', 0xffffffffffffffff), ('start_usec', 1000000)):
            b = self.valid(); setattr(b, field, value)
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                identity.decode_info(123, b, 136, 0)

    def test_zombie_is_returned_for_caller_to_reject(self):
        b = self.valid(); b.status = 5
        self.assertEqual(identity.decode_info(123, b, 136, 0)[0], 'Z')

    def test_birth_is_v3_english_utc_not_locale_or_padded_day(self):
        with mock.patch.dict(os.environ, {'TZ': 'Pacific/Honolulu', 'LC_ALL': 'fr_FR.UTF-8'}):
            self.assertEqual(identity.birth_text(1767225600), 'Thu Jan 1 00:00:00 2026')

    def test_pid_reuse_queries_fresh_kernel_data(self):
        b = self.valid()
        old = identity.decode_info(123, b, 136, 0)[1]
        b.start_sec += 1
        self.assertNotEqual(identity.decode_info(123, b, 136, 0)[1], old)


@unittest.skipUnless(sys.platform == 'darwin', 'Darwin kernel integration')
class KernelTests(unittest.TestCase):
    def test_real_identity_birth_parity_and_group(self):
        for pid in (os.getpid(), os.getppid()):
            state, birth, pgid = identity.query_identity(pid)
            ps = run(['/bin/ps', '-o', 'lstart=', '-p', str(pid)], env=dict(os.environ, TZ='UTC0', LC_ALL='C'))
            self.assertEqual(ps.returncode, 0, ps.stderr)
            self.assertEqual(birth, ' '.join(ps.stdout.split()))
            self.assertEqual(pgid, os.getpgid(pid))
            self.assertNotEqual(state, 'Z')

    def test_absent_and_real_zombie(self):
        child = os.fork()
        if child == 0:
            os._exit(0)
        try:
            deadline = time.monotonic() + 5
            # Darwin may withhold PROC_PIDTBSDINFO once a child is zombie.
            # Verify the actual zombie externally, then require fail-closed birth.
            while True:
                observed = run(['/bin/ps', '-o', 'state=', '-p', str(child)])
                if observed.returncode == 0 and observed.stdout.strip().startswith('Z'):
                    break
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.01)
            result = run([BASH, '-c', 'source "$1"; pr_operation_lock_process_birth "$2"', 'test', str(LOCK), str(child)])
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, '')
        finally:
            os.waitpid(child, 0)
        with self.assertRaises(ValueError):
            identity.query_identity(child)

    def test_same_existing_profile_real_child_and_parent(self):
        profile = os.environ.get('PR_IDENTITY_EXISTING_PROFILE')
        if not profile:
            self.skipTest('set PR_IDENTITY_EXISTING_PROFILE for exact-profile evidence')
        code = '''import importlib.util,json,os,sys
s=importlib.util.spec_from_file_location('identity',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps({'self':m.query_identity(os.getpid()),'parent':m.query_identity(os.getppid()),'pid':os.getpid(),'ppid':os.getppid(),'pgid':os.getpgrp()}))'''
        expected = identity.query_identity(os.getpid())
        result = run(['/usr/bin/sandbox-exec', '-f', profile, sys.executable, '-I', '-B', '-c', code, str(PROVIDER)])
        self.assertEqual(result.returncode, 0, result.stderr)
        result = json.loads(result.stdout)
        self.assertEqual(result['parent'][1], expected[1])
        self.assertEqual(result['self'][2], result['pgid'])
        self.assertEqual(result['ppid'], os.getpid())


@unittest.skipIf(sys.platform == 'win32', 'POSIX process groups')
class LockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pr-identity-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_COUNT='2', GIT_CONFIG_KEY_0='core.hooksPath', GIT_CONFIG_VALUE_0='/dev/null', GIT_CONFIG_KEY_1='commit.gpgSign', GIT_CONFIG_VALUE_1='false', GIT_NO_LAZY_FETCH='1', GIT_ALLOW_PROTOCOL='file', TMPDIR=str(self.root))
        self.env.pop('BASH_COMPAT', None)
        self.env.pop('OPENCLAW_PR_LOCK_NOTIFY_FD', None)
        self.env.pop('OPENCLAW_PR_DEDICATED_PROCESS_GROUP', None)
        self.repo = self.root/'repo'; self.repo.mkdir()
        self.git('init', '-q', '-b', 'main')
        self.sources = self.root/'source';self.sources.mkdir()
        for file in (LOCK, RUNNER, PROVIDER):shutil.copyfile(file,self.sources/file.name)
        self.ref = 'refs/openclaw/pr-operation-locks/42'

    def git(self, *args, **kwargs):
        return subprocess.check_output([GIT, '-C', str(self.repo), *args], text=True, env=self.env, **kwargs).strip()

    def exists(self):
        return run([GIT, '-C', str(self.repo), 'rev-parse', '--verify', self.ref], env=self.env).returncode == 0

    def shell(self, code, *args):
        return run([BASH, '-c', 'set -eu; source "$1"; _fixture_root="$2"; repo_root() { printf "%s\\n" "$_fixture_root"; }; '+code, 'test', str(self.sources/'operation-lock.sh'), str(self.repo), *args], env=self.env)

    def supervise(self, body, sandbox=False):
        script = self.root/'operation.sh'
        script.write_text('set -eu\nsource "$1"\n_fixture_root="$2"; repo_root() { printf "%s\\n" "$_fixture_root"; }\n'+body+'\n')
        command = [NODE, str(self.sources/'process-group-runner.mjs'), str(self.repo), BASH, str(script), str(self.sources/'operation-lock.sh'), str(self.repo)]
        if sandbox:
            profile = self.root / 'fixture.sb'
            # Same deny-write/network containment; only the isolated fixture is
            # writable. This is not a new exception for the canonical repository.
            profile.write_text('(version 1)(allow default)(deny network*)(deny file-write*)'
                               '(allow file-write* (literal "/dev/null") (subpath '+json.dumps(str(self.root.resolve()))+'))')
            command = ['/usr/bin/sandbox-exec', '-f', str(profile), *command]
        p = subprocess.Popen(command, env=self.env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        self.addCleanup(self.stop, p)
        return p

    def stop(self, p):
        if p.poll() is None:
            os.killpg(p.pid, signal.SIGTERM)
            try:p.communicate(timeout=12)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL);p.communicate(timeout=3)
        else:
            p.communicate(timeout=3)

    def complete(self, p, expected):
        out,err=p.communicate(timeout=18)
        self.assertEqual(p.returncode,expected,out+err)
        return out+err

    def test_clean_completion_release_without_app_graph(self):
        self.complete(self.supervise('acquire_pr_operation_lock 42\nprintf "held\\n"'),0)
        self.assertFalse(self.exists())
        self.assertFalse((self.repo/'node_modules').exists())

    @unittest.skipUnless(sys.platform == 'darwin', 'Darwin sandbox')
    def test_sandbox_lock_completion_without_app_graph(self):
        self.complete(self.supervise('acquire_pr_operation_lock 42', sandbox=True), 0)
        self.assertFalse(self.exists())
        self.assertFalse((self.repo/'node_modules').exists())

    def test_failure_stays_sticky_and_exact_cas_recovery(self):
        self.complete(self.supervise('acquire_pr_operation_lock 42\nexit 7'),7)
        self.assertTrue(self.exists()); old=self.git('rev-parse',self.ref)
        successor=self.git('hash-object','-w','--stdin',input='successor fixture\n')
        self.git('update-ref',self.ref,successor,old)
        released=self.shell('PR_OPERATION_LOCK_REF=refs/openclaw/pr-operation-locks/42; PR_OPERATION_LOCK_OWNER_OID="$3"; release_pr_operation_lock',old)
        self.assertEqual(released.returncode,0,released.stderr)
        self.assertEqual(self.git('rev-parse',self.ref),successor)
        r=self.shell('recover_pr_operation_lock 42 "$3" --confirmed-no-running-tools',old)
        self.assertNotEqual(r.returncode,0)
        self.assertEqual(self.git('rev-parse',self.ref),successor)
        r=self.shell('recover_pr_operation_lock 42 "$3" --confirmed-no-running-tools',successor)
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertFalse(self.exists())

    def test_snapshot_provider_survives_source_deletion(self):
        # Delete only this test's copied sources while the real supervisor is
        # alive. Release sources its own complete snapshot after the child exits.
        body = 'acquire_pr_operation_lock 42\nrm -rf -- "'+str(self.sources)+'"'
        if sys.platform == 'darwin':
            body += '\nfor provider in "$TMPDIR"/openclaw-pr-lock-release-*/darwin-process-identity.py; do python3 -I -B "$provider" identity "$$"; done'
        self.complete(self.supervise(body, sandbox=sys.platform == 'darwin'),0)
        self.assertFalse(self.sources.exists())
        self.assertFalse(self.exists())
        self.assertFalse(list(self.root.glob('openclaw-pr-lock-release-*')))

    def test_absent_completion_marker_does_not_release(self):
        p = self.supervise('acquire_pr_operation_lock 42\ntrap - EXIT\nexit 0')
        out, err = p.communicate(timeout=15)
        self.assertNotEqual(p.returncode, 0, out+err)
        self.assertTrue(self.exists())

    def test_validation_failure_release_and_sticky_side_effects(self):
        for mutated in (False, True):
            body = 'acquire_pr_operation_lock 42\nbegin_pr_operation_validation_phase\n'
            if mutated:
                body += 'mark_pr_operation_side_effects_started\n'
            self.complete(self.supervise(body+'exit 1'), 1)
            self.assertEqual(self.exists(), mutated)

    def test_live_owner_blocks_then_clean_drain_releases(self):
        ready=self.root/'ready'; go=self.root/'go'
        p=self.supervise('acquire_pr_operation_lock 42\n: > "'+str(ready)+'"\nwhile [ ! -f "'+str(go)+'" ]; do sleep 0.02; done')
        deadline=time.monotonic()+5
        while not ready.exists():
            self.assertIsNone(p.poll()); self.assertLess(time.monotonic(),deadline);time.sleep(.02)
        q=self.supervise('acquire_pr_operation_lock 42')
        time.sleep(.25);self.assertIsNone(q.poll())
        go.touch();self.complete(p,0);self.complete(q,0);self.assertFalse(self.exists())

    @unittest.skipUnless(sys.platform == 'darwin', 'Darwin incarnation fixture')
    def test_wrong_birth_or_reused_group_never_auto_recovers(self):
        # A fixture v3 lock with the real live PGID but a different incarnation
        # must remain sticky. Identity itself always comes from the kernel.
        live=subprocess.Popen(['sleep','20'], start_new_session=True, env=self.env)
        self.addCleanup(self.stop,live)
        state,birth,pgid=identity.query_identity(live.pid) if sys.platform=='darwin' else ('S','fixture',live.pid)
        for stored_birth in ('different incarnation',birth):
            data='version=3\nstate=active\npgid={}\nsupervisor_pid={}\nsupervisor_birth={}\ntoken=12345678-1234-1234-1234-123456789abc\n'.format(pgid,live.pid,stored_birth)
            oid=self.git('hash-object','-w','--stdin',input=data);self.git('update-ref',self.ref,oid)
            p=self.supervise('try_acquire_pr_operation_lock 42')
            expected=2 if stored_birth!=birth else 1
            self.complete(p,expected)
            self.assertEqual(self.git('rev-parse',self.ref),oid)

    def test_group_status_indeterminate_never_dead(self):
        r=self.shell('pr_operation_lock_process_group_status 2147483648')
        self.assertEqual(r.stdout,'indeterminate\n')

    def test_lingering_group_retains_lock_after_drain(self):
        # The supervisor performs the real unchanged five-second grace/drain.
        p=self.supervise('acquire_pr_operation_lock 42\n(trap "" TERM; sleep 3) &\nexit 0')
        out,err=p.communicate(timeout=15)
        self.assertNotEqual(p.returncode,0,out+err)
        self.assertTrue(self.exists())
        self.assertIn('Retaining the operation lock',err)

    @unittest.skipUnless(sys.platform == 'darwin', 'Darwin platform binding')
    def test_platform_env_cannot_select_ps_backend(self):
        self.env['OSTYPE'] = 'linux'
        result = self.complete(self.supervise('pr_operation_lock_process_identity "$$"', sandbox=True), 0)
        self.assertRegex(result, r'^[IRSTZ]\t[A-Z][a-z]{2} ')

    @unittest.skipUnless(sys.platform == 'darwin', 'Darwin interpreter compatibility')
    def test_python_free_operations_require_python_only_when_ps_is_unavailable(self):
        # Real platform tools, but no Python. The unsandboxed workflow already
        # works on released versions; adding sandbox support must preserve it.
        tools = self.root / 'tools'; tools.mkdir()
        for name in ('bash', 'node', 'git', 'ps', 'awk', 'uname', 'sleep'):
            (tools / name).symlink_to(shutil.which(name))
        self.env['PATH'] = str(tools)
        marker = self.root / 'child-started'
        for sandbox in (False, True):
            with self.subTest(sandbox=sandbox):
                p = self.supervise('acquire_pr_operation_lock 42\n: > "'+str(marker)+'"', sandbox=sandbox)
                text = self.complete(p, 1 if sandbox else 0)
                self.assertEqual(marker.exists(), not sandbox)
                self.assertFalse(self.exists())
                if sandbox:
                    self.assertIn('process identity', text)
                else:
                    marker.unlink()

    @unittest.skipUnless(sys.platform=='darwin','Darwin preflight')
    def test_missing_provider_fails_before_child_or_git_mutation(self):
        (self.sources/'darwin-process-identity.py').unlink()
        marker=self.root/'mutated'
        p=self.supervise('touch "'+str(marker)+'"\nacquire_pr_operation_lock 42')
        self.complete(p,1)
        self.assertFalse(marker.exists());self.assertFalse(self.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
