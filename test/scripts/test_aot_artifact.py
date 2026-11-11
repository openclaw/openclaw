"""Boundary tests for the compiler bundle supplied to the AOT workflow."""
import importlib.util
import io
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/aot-artifact.py"
spec = importlib.util.spec_from_file_location("aot_artifact", SCRIPT)
aot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(aot)


def workflow_block(name):
    workflow = SCRIPT.parents[1] / ".github/workflows/aot-artifacts.yml"
    lines = workflow.read_text().splitlines()
    start = lines.index("      - name: " + name)
    start = lines.index("        run: |", start) + 1
    end = start
    while end < len(lines) and (lines[end].startswith("          ") or not lines[end]):
        end += 1
    return "\n".join(line[10:] if line else "" for line in lines[start:end]) + "\n"


@unittest.skipUnless(sys.platform == "darwin", "macOS Bash and BSD date contract")
class WorkflowAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.environment = {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Synthetic Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
            "GIT_COMMITTER_NAME": "Synthetic Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
            "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z",
            "RUNNER_TEMP": str(self.root), "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_ENV": str(self.root / "github-env"),
        }
        for args in (["init", "-q"], ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
                     "commit", "--allow-empty", "-qm", "Synthetic fixture"]):
            subprocess.run(["git", *args], cwd=self.repo, env=self.environment, check=True, capture_output=True)
        self.head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.repo,
            env=self.environment, text=True).strip()

    def run_block(self, block, values, label):
        output = self.root / label
        (output / "evidence").mkdir(parents=True)
        sentinel = output / "build-sentinel"
        environment = {**self.environment, **values, "AOT_ROOT": str(output), "SENTINEL": str(sentinel)}
        # Bash3.2 does not apply errexit to every failing compound command.
        result = subprocess.run(["/bin/bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c",
            block + '\nprintf reached > "$SENTINEL"\n'], cwd=self.repo, env=environment,
            capture_output=True, text=True)
        return result, sentinel

    def test_only_matching_dispatched_source_reaches_build(self):
        block = workflow_block("Verify dispatched source identity")
        for label, sha in (("matching", self.head), ("mismatched", "0" * 40)):
            with self.subTest(label=label):
                result, sentinel = self.run_block(block, {"SOURCE_SHA": sha}, label)
                self.assertEqual(result.returncode == 0, label == "matching", result.stderr)
                self.assertEqual(sentinel.exists(), label == "matching")

    def test_invalid_dispatch_metadata_stops_before_build(self):
        block = workflow_block("Check dispatch inputs")
        valid = {"SOURCE_SHA": self.head, "TOOLCHAIN_RUN_ID": "1", "TOOLCHAIN_ARTIFACT_ID": "2",
            "TOOLCHAIN_BUNDLE_SHA256": "a" * 64, "MIN_MEMORY_GIB": "14"}
        cases = [("valid", valid)] + [(key, {**valid, key: "invalid"}) for key in valid]
        for label, values in cases:
            with self.subTest(label=label):
                result, sentinel = self.run_block(block, values, label)
                self.assertEqual(result.returncode == 0, label == "valid", result.stderr)
                self.assertEqual(sentinel.exists(), label == "valid")


class CompilerBundleTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.archive = self.root / "toolchain.tar.gz"
        self.destination = self.root / "toolchain"

    def archive_members(self, members):
        with tarfile.open(self.archive, "w:gz") as output:
            for name, kind, content in members:
                item = tarfile.TarInfo(name)
                item.type = kind
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    item.linkname = content
                    output.addfile(item)
                elif kind == tarfile.REGTYPE:
                    item.size = len(content)
                    item.mode = 0o755
                    output.addfile(item, io.BytesIO(content))
                else:
                    output.addfile(item)

    def test_regular_compiler_and_resources_keep_layout_and_execute_bit(self):
        self.archive_members([
            ("toolchain/bin/bun", tarfile.REGTYPE, b"synthetic compiler"),
            ("toolchain/bin/aot-engine/ir/AOTSchema.def", tarfile.REGTYPE, b"schema"),
        ])
        aot.unpack_bundle(self.archive, self.destination)
        self.assertEqual((self.destination / "bin/bun").read_bytes(), b"synthetic compiler")
        self.assertTrue((self.destination / "bin/bun").stat().st_mode & 0o111)
        self.assertEqual((self.destination / "bin/aot-engine/ir/AOTSchema.def").read_bytes(), b"schema")

    def test_rejects_paths_that_escape_or_change_the_root(self):
        for name in ("../outside", "/toolchain/bin/bun", "toolchain/../../outside", "other/bin/bun", "toolchain\\bin\\bun"):
            with self.subTest(name=name):
                self.archive_members([(name, tarfile.REGTYPE, b"payload")])
                with self.assertRaises(ValueError):
                    aot.unpack_bundle(self.archive, self.destination)
                self.assertFalse(self.destination.exists())
                self.assertFalse((self.root / "outside").exists())

    def test_rejects_links_and_devices_before_any_write(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE):
            with self.subTest(kind=kind):
                self.archive_members([
                    ("toolchain/bin/bun", tarfile.REGTYPE, b"compiler"),
                    ("toolchain/bin/unsafe", kind, "../../outside"),
                ])
                with self.assertRaises(ValueError):
                    aot.unpack_bundle(self.archive, self.destination)
                self.assertFalse(self.destination.exists())

    def test_rejects_duplicate_normalized_paths(self):
        self.archive_members([
            ("toolchain/bin/bun", tarfile.REGTYPE, b"one"),
            ("toolchain/./bin/bun", tarfile.REGTYPE, b"two"),
        ])
        with self.assertRaises(ValueError):
            aot.unpack_bundle(self.archive, self.destination)
        self.assertFalse(self.destination.exists())

    def test_refuses_existing_destination(self):
        self.archive_members([("toolchain/bin/bun", tarfile.REGTYPE, b"new")])
        self.destination.mkdir()
        sentinel = self.destination / "sentinel"
        sentinel.write_bytes(b"preserve")
        with self.assertRaises(ValueError):
            aot.unpack_bundle(self.archive, self.destination)
        self.assertEqual(sentinel.read_bytes(), b"preserve")


class MachOBuildVersionTests(unittest.TestCase):
    def test_records_actual_minimum_instead_of_requested_target(self):
        output = "Load command 12\n cmd LC_BUILD_VERSION\n platform MACOS\n minos 27.0\n sdk 27.2\n"
        with mock.patch.object(aot.subprocess, "check_output", return_value=output):
            self.assertEqual(aot.macho_build_version(Path("synthetic")),
                {"minimumOperatingSystem": "27.0", "sdk": "27.2"})

    def test_rejects_missing_or_ambiguous_build_version(self):
        outputs = ["", "platform IOS\n minos 27.0\n sdk 27.2\n",
            "platform MACOS\n minos 27.0\n sdk 27.2\nplatform MACOS\n minos 15.0\n sdk 27.2\n"]
        for output in outputs:
            with self.subTest(output=output), mock.patch.object(aot.subprocess, "check_output", return_value=output):
                with self.assertRaises(ValueError):
                    aot.macho_build_version(Path("synthetic"))


class MeasurementTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        (self.root / "evidence").mkdir()
        self.environment = {**os.environ, "AOT_ROOT": str(self.root)}

    def test_nonzero_command_keeps_log_and_failure_receipt(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "measure", "failed", "--",
             sys.executable, "-c", "print('synthetic failure'); raise SystemExit(7)"],
            env=self.environment, capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        receipt = json.loads((self.root / "evidence/failed.json").read_text())
        self.assertEqual(receipt["exitCode"], 7)
        self.assertIn("synthetic failure", (self.root / "evidence/failed.log").read_text())
        self.assertIn("exited 7", receipt["failure"])

    def test_sigterm_keeps_receipt_and_stops_child(self):
        ready = self.root / "child-pid"
        child_code = "import os,time; from pathlib import Path; Path(%r).write_text(str(os.getpid())); time.sleep(120)" % str(ready)
        process = subprocess.Popen(
            [sys.executable, str(SCRIPT), "measure", "interrupted", "--", sys.executable, "-c", child_code],
            env=self.environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        child_pid = None
        try:
            deadline = time.monotonic() + 10
            while not ready.exists() and time.monotonic() < deadline and process.poll() is None:
                time.sleep(0.05)
            self.assertTrue(ready.exists(), "Synthetic measured child did not start")
            child_pid = int(ready.read_text())
            process.send_signal(signal.SIGTERM)
            process.communicate(timeout=10)
            self.assertNotEqual(process.returncode, 0)
            receipt = json.loads((self.root / "evidence/interrupted.json").read_text())
            self.assertIn("SIGTERM", receipt["failure"])
            # Delivery of SIGKILL and scheduler removal are asynchronous.
            deadline = time.monotonic() + 5
            while True:
                probe = subprocess.run(["ps", "-p", str(child_pid), "-o", "stat="], capture_output=True, text=True)
                if probe.returncode != 0 or probe.stdout.strip().startswith("Z"):
                    child_pid = None
                    break
                self.assertLess(time.monotonic(), deadline, probe.stdout)
                time.sleep(0.05)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
            if child_pid is not None:
                try:
                    os.kill(child_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


if __name__ == "__main__":
    unittest.main()
