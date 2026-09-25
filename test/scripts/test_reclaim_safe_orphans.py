from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

MODULE_PATH = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "reclaim-safe-orphans.py"


def load_module():
    spec = importlib.util.spec_from_file_location("reclaim_safe_orphans", MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    mod.report.clear()
    mod.inspection_errors.clear()
    mod.removed_bytes = 0
    mod.APPLY = False
    return mod


def completed(returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(["mock"], returncode, stdout, stderr)


class ReclaimerSafetyTests(unittest.TestCase):
    def test_held_fails_closed_on_lsof_permission_error(self):
        mod = load_module()
        with mock.patch.object(mod.subprocess, "run", return_value=completed(1, "", "lsof: status error: Permission denied")):
            self.assertIs(mod.held("/tmp/example"), True)
        self.assertTrue(mod.inspection_errors)

    def test_held_allows_empty_lsof_no_match(self):
        mod = load_module()
        with mock.patch.object(mod.subprocess, "run", return_value=completed(1, "", "")):
            self.assertIs(mod.held("/tmp/example"), False)
        self.assertFalse(mod.inspection_errors)

    def test_git_repo_busy_detects_cwd_relative_git_without_absolute_argv(self):
        mod = load_module()
        repo = "/home/jarvis/.openclaw/workspace-codeops/openclaw-current"
        with mock.patch.object(mod.subprocess, "run", return_value=completed(0, "4242 git fetch origin\n", "")), \
             mock.patch.object(mod.os, "readlink", side_effect=lambda p: repo if p == "/proc/4242/cwd" else (_ for _ in ()).throw(FileNotFoundError())):
            self.assertIs(mod.git_repo_busy(repo + "/.git"), True)

    def test_git_repo_busy_fails_closed_on_pgrep_error(self):
        mod = load_module()
        with mock.patch.object(mod.subprocess, "run", return_value=completed(2, "", "pgrep failed")):
            self.assertIs(mod.git_repo_busy("/repo/.git"), True)
        self.assertTrue(mod.inspection_errors)

    def test_hardlink_and_symlink_candidates_are_skipped(self):
        mod = load_module()
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            real = root / "tmp_pack_real"
            real.write_text("x")
            old = time.time() - 7200
            os.utime(real, (old, old))
            sym = root / "tmp_pack_sym"
            sym.symlink_to(real)
            hard = root / "tmp_pack_hard"
            os.link(real, hard)
            with mock.patch.object(mod, "held", return_value=False):
                mod.consider(str(real), 3600, "git-temp-pack", str(root))
                mod.consider(str(sym), 3600, "git-temp-pack", str(root))
            self.assertTrue(real.exists())
            self.assertTrue(sym.exists())
            self.assertTrue(any("hardlink-count-2" in line for line in mod.report))
            self.assertTrue(any("not-plain-file" in line for line in mod.report))

    def test_changed_identity_is_not_removed_in_apply(self):
        mod = load_module()
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            candidate = root / "tmp_pack_race"
            candidate.write_text("old")
            old = time.time() - 7200
            os.utime(candidate, (old, old))
            mod.APPLY = True
            original_identity = mod.file_identity
            calls = {"n": 0}

            def racing_identity(path):
                calls["n"] += 1
                if calls["n"] == 2:
                    candidate.write_text("new")
                return original_identity(path)

            with mock.patch.object(mod, "held", return_value=False), mock.patch.object(mod, "file_identity", side_effect=racing_identity):
                mod.consider(str(candidate), 3600, "git-temp-pack", str(root))
            self.assertTrue(candidate.exists())
            self.assertTrue(any("changed-during-inspection" in line for line in mod.report))

    def test_tmp_sqlite_matches_are_reported_not_deleted(self):
        mod = load_module()
        with tempfile.TemporaryDirectory() as d:
            fake_tmp = pathlib.Path(d) / "scratch-agent.sqlite"
            fake_tmp.write_text("db copy? provenance unknown")
            def fake_glob(pat, recursive=False):
                return [str(fake_tmp)] if pat == "/tmp/*-agent.sqlite" else []
            out = io.StringIO()
            with mock.patch.object(mod.glob, "glob", side_effect=fake_glob), contextlib.redirect_stdout(out):
                self.assertEqual(mod.main(), 0)
            self.assertTrue(fake_tmp.exists())
            self.assertIn("SKIP unverified-provenance", out.getvalue())

    def test_apply_refuses_any_incomplete_inspection(self):
        mod = load_module()
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            packdir = root / "repo" / ".git" / "objects" / "pack"
            packdir.mkdir(parents=True)
            candidate = packdir / "tmp_pack_old"
            candidate.write_text("x")
            old = time.time() - 7200
            os.utime(candidate, (old, old))
            def fake_glob(pat, recursive=False):
                if pat.endswith("/.git/objects/pack"):
                    return [str(packdir)]
                if pat.endswith("tmp_pack_*"):
                    return [str(candidate)]
                return []
            def fake_held(path):
                mod.remember_error("lsof", "permission denied")
                return True
            err = io.StringIO()
            with mock.patch.object(mod, "HOME", str(root / "home")), \
                 mock.patch.object(mod.glob, "glob", side_effect=fake_glob), \
                 mock.patch.object(mod, "git_repo_busy", return_value=False), \
                 mock.patch.object(mod, "held", side_effect=fake_held), \
                 contextlib.redirect_stderr(err):
                mod.APPLY = True
                self.assertEqual(mod.main(), 2)
            self.assertTrue(candidate.exists())
            self.assertIn("refusing destructive mode", err.getvalue())


if __name__ == "__main__":
    unittest.main()
