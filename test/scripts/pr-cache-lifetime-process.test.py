"""PR cache kernel-lease and retirement safety contracts (stdlib only)."""

import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


HELPER = Path(__file__).resolve().parents[2] / "scripts/pr-lib/cache-lifetime-process.py"
SPEC = importlib.util.spec_from_file_location("cache_lifetime_process", HELPER)
OWNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OWNER)


def identity(path):
    value = os.lstat(path)
    return {key: str(getattr(value, "st_" + key)) for key in ("dev", "ino", "uid", "mode")}


class RetirementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pr-lifetime-process-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.anchor = self.root / "anchor"
        self.anchor.mkdir(mode=0o700)
        self.lease = self.root / "lifetime-lease"
        self.lease.touch(mode=0o600)
        self.candidate = {
            "id": "anchor", "path": str(self.anchor), "identity": identity(self.anchor),
            "lease": {"path": str(self.lease), **identity(self.lease)},
            "targets": [str(self.anchor)],
        }

    def retire(self, scan=None):
        return OWNER.retire(self.candidate, scan, time.time())

    def legacy(self):
        self.candidate.pop("lease")
        old = time.time() - 2 * OWNER.DAY_SECONDS
        os.utime(self.anchor, (old, old))
        self.candidate["legacy"] = {"pid": 1234, "createdMs": old * 1000}
        return old * 1000

    def test_shared_lock_survives_helper_exit_until_inherited_descriptor_closes(self):
        fd = os.open(self.lease, os.O_RDWR)
        try:
            subprocess.run([sys.executable, "-I", "-S", "-B", str(HELPER), "shared", str(fd)],
                           pass_fds=(fd,), check=True)
            self.assertEqual(self.retire()["reason"], "lease-held")
            self.assertTrue(self.anchor.exists())
        finally:
            os.close(fd)
        self.assertEqual(self.retire()["state"], "retired")
        self.assertFalse(self.anchor.exists())
        self.assertTrue(self.lease.exists())

    def test_retirement_preserves_symlink_targets_and_accepts_already_missing_anchor(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "keep").write_text("untouched")
        (self.anchor / "alias").symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.retire()["state"], "retired")
        self.assertEqual((outside / "keep").read_text(), "untouched")
        self.assertEqual(self.retire()["state"], "retired")

    def test_missing_replaced_or_hardlinked_lease_never_falls_back(self):
        self.lease.rename(self.root / "old-lease")
        self.assertEqual(self.retire()["state"], "blocked")
        self.lease.touch(mode=0o600)
        self.assertEqual(self.retire()["reason"], "changed-lease")
        self.candidate["lease"] = {"path": str(self.lease), **identity(self.lease)}
        os.link(self.lease, self.root / "hardlink")
        self.assertEqual(self.retire()["reason"], "unsafe-lease")
        self.assertTrue(self.anchor.exists())

    def test_alias_ancestor_and_replaced_anchor_are_retained(self):
        alias = self.root / "alias-root"
        alias.symlink_to(self.root, target_is_directory=True)
        self.candidate["path"] = str(alias / "anchor")
        self.assertEqual(self.retire()["reason"], "aliased-path")
        self.candidate["path"] = str(self.anchor)
        self.anchor.rename(self.root / "original")
        self.anchor.mkdir(mode=0o700)
        self.assertEqual(self.retire()["reason"], "changed-directory")

    def test_legacy_pid_incarnation_and_same_second_remain_safe(self):
        self.legacy()
        birth = getattr(os.stat(self.anchor), "st_birthtime", self.candidate["legacy"]["createdMs"] / 1000) * 1000
        for start in (birth - 1000, birth, birth + 0.1):
            with self.subTest(start=start):
                self.assertEqual(self.retire(({1234: start}, set()))["reason"], "creator-live")
        self.assertEqual(self.retire(({1234: birth + 2000}, set()))["state"], "retired")

    def test_legacy_requires_age_and_successful_reference_scan(self):
        self.candidate.pop("lease")
        self.candidate["legacy"] = {"pid": 1234}
        self.assertEqual(self.retire(({}, set()))["reason"], "recent-directory")
        self.assertEqual(self.retire()["reason"], "process-census-unavailable")
        self.assertEqual(self.retire(({}, {str(self.anchor)}))["reason"], "process-references")

    def test_pending_bootstrap_requires_dead_incarnation_empty_census_and_ex(self):
        import fcntl
        created = time.time() * 1000
        self.candidate["pending"] = {"pid": 1234, "createdMs": created}
        self.assertEqual(self.retire()["reason"], "process-census-unavailable")
        self.assertEqual(self.retire(({}, {str(self.anchor)}))["reason"], "process-references")
        for start in (created - 1000, created):
            self.assertEqual(self.retire(({1234: start}, set()))["reason"], "creator-live")
        with self.lease.open("r+") as held:
            fcntl.flock(held, fcntl.LOCK_SH)
            self.assertEqual(self.retire(({}, set()))["reason"], "lease-held")
        # A reused PID is unrelated, and this pending bootstrap has no 24h grace.
        self.assertEqual(self.retire(({1234: created + 2000}, set()))["state"], "retired")
        self.candidate.pop("lease")
        self.lease.unlink()
        self.assertEqual(self.retire(({}, set()))["state"], "retired")

    def test_missing_legacy_anchor_uses_modified_time_for_age_and_birth_for_pid(self):
        now = time.time()
        self.anchor.rmdir()
        self.candidate.pop("lease")
        self.candidate["legacy"] = {"pid": 1234, "createdMs": (now - 100) * 1000,
                                    "modifiedMs": (now - OWNER.DAY_SECONDS) * 1000}
        self.assertEqual(OWNER.retire(self.candidate, ({}, set()), now)["reason"], "recent-directory")
        self.candidate["legacy"]["modifiedMs"] -= 1000
        self.assertEqual(OWNER.retire(self.candidate, ({1234: (now - 101) * 1000}, set()), now)["reason"], "creator-live")
        self.assertEqual(OWNER.retire(self.candidate, ({}, set()), now)["state"], "retired")
        self.candidate["legacy"].pop("createdMs")
        self.assertEqual(self.retire(({}, set()))["reason"], "missing-anchor-timestamp")

    def test_successful_retirement_budget_does_not_count_live_candidates(self):
        blocked = {**self.candidate, "id": "blocked", "lease": {**self.candidate["lease"], "ino": "0"}}
        later = self.root / "later"
        later.mkdir(mode=0o700)
        next_candidate = {**self.candidate, "id": "next", "path": str(later), "identity": identity(later)}
        result = OWNER.batch({"candidates": [blocked, self.candidate, next_candidate], "limit": 1})
        self.assertEqual([row["state"] for row in result["results"]], ["blocked", "retired", "blocked"])
        self.assertEqual(result["results"][2]["reason"], "batch-budget")
        self.assertTrue(later.exists())

    def test_orphan_recency_includes_nested_files(self):
        self.candidate.pop("lease")
        self.candidate["orphan"] = True
        nested = self.anchor / "nested"
        nested.mkdir()
        file = nested / "recent"
        file.write_text("active install")
        old = time.time() - 2 * OWNER.DAY_SECONDS
        os.utime(self.anchor, (old, old))
        os.utime(nested, (old, old))
        self.assertEqual(self.retire(({}, set()))["reason"], "recent-directory")
        os.utime(file, (old, old))
        self.assertEqual(self.retire(({}, set()))["state"], "retired")

    def test_proc_scan_skips_only_fully_exited_zombie_groups(self):
        for state, threads in (("Z", 1), ("Z", 2), ("S", 1)):
            with self.subTest(state=state, threads=threads):
                fields = [state] + ["0"] * 19
                fields[17] = str(threads)
                fields[19] = "100"
                def source(path, **_kwargs):
                    return io.StringIO("btime 1000\n" if path == "/proc/stat"
                                       else "1234 (fixture) " + " ".join(fields))
                with mock.patch("builtins.open", side_effect=source), \
                     mock.patch.object(OWNER.os, "listdir", return_value=["1234"]), \
                     mock.patch.object(OWNER.os, "stat", return_value=os.stat(self.anchor)), \
                     mock.patch.object(OWNER.os, "readlink", side_effect=PermissionError("unreadable process")):
                    if state == "Z" and threads == 1:
                        self.assertEqual(OWNER.linux_scan({str(self.anchor)}), ({1234: None}, set()))
                    elif state == "Z":
                        with self.assertRaisesRegex(ValueError, "zombie-group-has-threads"):
                            OWNER.linux_scan({str(self.anchor)})
                    else:
                        with self.assertRaises(PermissionError):
                            OWNER.linux_scan({str(self.anchor)})

    @unittest.skipUnless(sys.platform == "linux", "Linux procfs reference contract")
    def test_proc_scan_finds_cwd_descriptor_and_mapping(self):
        file = self.anchor / "mapped"
        file.write_bytes(b"fixture")
        code = "import mmap,os,sys; f=open(sys.argv[1],'r+b'); m=mmap.mmap(f.fileno(),0); print('ready',flush=True); sys.stdin.read()"
        worker = subprocess.Popen([sys.executable, "-I", "-S", "-B", "-c", code, str(file)],
                                  cwd=self.anchor, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(worker.stdout.readline().strip(), "ready")
            try:
                processes, references = OWNER.process_scan({str(self.anchor)})
            except (PermissionError, ValueError) as error:
                if not isinstance(error, PermissionError) and str(error) != "zombie-group-has-threads":
                    raise
                self.legacy()
                result = OWNER.batch({"candidates": [self.candidate]})["results"][0]
                self.assertEqual(result["reason"], "process-census-unavailable")
                self.assertTrue(file.exists())
                print("Restricted procfs; confirmed retained live reader:", error, flush=True)
            else:
                self.assertIn(worker.pid, processes)
                self.assertIn(str(self.anchor), references)
                print("Complete procfs census found live cwd/fd/maps references", flush=True)
        finally:
            worker.communicate("q", timeout=5)


if __name__ == "__main__":
    unittest.main()
