import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { name?: string; run?: string; if?: string; uses?: string; with?: object };
const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const steps: Step[] = workflow.jobs["ios-build"].steps;
const producer = steps.find((step) => step.name === "Export Release iOS simulator app")!;
const gate: Step = workflow.jobs.preflight.steps.find(
  (step: Step) => step.name === "Validate Release simulator export dispatch",
);
const python = producer.run?.split("python3 -I -S - <<'PY'\n")[1]?.split("\nPY")[0];

// Execute the workflow-owned verifier itself against synthetic Mach-O bundles.
// No Xcode, signing identity, provider credentials, or real app files are used.
const checks = String.raw`
import contextlib
import io
import types
import unittest
from unittest.mock import patch

SOURCE = "a" * 40
TREE = "b" * 40
WORKFLOW = "c" * 40
TEAM = "FWJYW4S8P8"

def thin(cpu, identifier, *, group=GROUP_ID, platform=7, raw=None):
    raw = raw if raw is not None else plistlib.dumps({
        "application-identifier": TEAM + "." + identifier,
        "com.apple.security.application-groups": [group],
    })
    command_bytes = 72 + 80 + 24
    offset = 32 + command_bytes
    header = struct.pack("<8I", 0xFEEDFACF, cpu, 0, 2, 2, command_bytes, 0, 0)
    segment = struct.pack("<II16s4Q4I", 0x19, 152, b"__TEXT", 0, offset + len(raw), 0, offset + len(raw), 7, 5, 1, 0)
    section = struct.pack("<16s16s2Q8I", b"__entitlements", b"__TEXT", 0, len(raw), offset, 0, 0, 0, 0, 0, 0, 0)
    build = struct.pack("<6I", 0x32, 24, platform, 0, 0, 0)
    return header + segment + section + build + raw

def fat(identifier, *, second_identifier=None):
    arm = thin(0x100000C, identifier)
    intel = thin(0x1000007, second_identifier or identifier)
    offset = 48
    return (struct.pack(">II", 0xCAFEBABE, 2)
        + struct.pack(">5I", 0x100000C, 0, offset, len(arm), 0)
        + struct.pack(">5I", 0x1000007, 0, offset + len(arm), len(intel), 0)
        + arm + intel)

def bundle(path, identifier):
    path.mkdir(parents=True)
    info = {
        "CFBundleIdentifier": identifier, "CFBundleExecutable": "Executable",
        "CFBundleSupportedPlatforms": ["iPhoneSimulator"],
        "OpenClawAppGroupIdentifier": GROUP_ID, "OpenClawGitCommit": SOURCE,
        "CFBundleShortVersionString": "2026.8.1", "CFBundleVersion": "12345",
    }
    (path / "Info.plist").write_bytes(plistlib.dumps(info))
    (path / "Executable").write_bytes(fat(identifier))
    (path / "Executable").chmod(0o755)
    return info

class ExportContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="private-build-sentinel-")
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.app = self.root / "product/OpenClaw.app"
        bundle(self.app, APP_ID)
        bundle(self.app / "PlugIns/OpenClawShareExtension.appex", APP_ID + ".share")

    def inspect_output(self, argv):
        if argv[0] == "codesign":
            if "--verify" in argv:
                return ""
            identifier = APP_ID + (".share" if argv[-1].endswith(".appex") else "")
            return "Executable=/private/build/sentinel\nIdentifier=" + identifier + "\n"
        raise AssertionError("unexpected inspection command")

    def test_built_entitlements_and_signature_are_separate(self):
        with patch.dict(globals(), output=self.inspect_output):
            info, team, proof = inspect_bundle(self.app, APP_ID)
        self.assertEqual(team, TEAM)
        self.assertEqual(proof["architectures"], ["arm64", "x86_64"])
        self.assertTrue(proof["signatureVerified"])
        self.assertNotIn("application-identifier", json.dumps(proof))
        self.assertNotIn("/private/", json.dumps(proof))

    def test_missing_malformed_or_wrong_slice_is_rejected(self):
        for data in [b"", thin(0x1000007, APP_ID), thin(0x100000C, APP_ID, platform=2),
                     thin(0x100000C, APP_ID, raw=b"invalid"),
                     fat(APP_ID, second_identifier=APP_ID + ".other")]:
            with self.subTest(size=len(data)), self.assertRaises((ValueError, plistlib.InvalidFileException)):
                macho_entitlements(data)

    def test_section_cannot_claim_a_different_parent_segment(self):
        data = bytearray(thin(0x100000C, APP_ID))
        data[40:56] = b"__DATA".ljust(16, bytes(1))
        with self.assertRaisesRegex(ValueError, "missing-simulator-entitlements"):
            macho_entitlements(data)

    def test_wrong_group_or_share_identifier_is_rejected(self):
        executable = self.app / "Executable"
        for data in [thin(0x100000C, APP_ID, group="private-group-sentinel"),
                     thin(0x100000C, APP_ID + ".share")]:
            executable.write_bytes(data)
            with patch.dict(globals(), output=self.inspect_output), self.assertRaises(ValueError):
                inspect_bundle(self.app, APP_ID)

    def test_signature_failure_is_not_replaced_by_entitlement_proof(self):
        def failed_signature(argv):
            raise ValueError("signature-invalid")
        with patch.dict(globals(), output=failed_signature), self.assertRaises(ValueError):
            inspect_bundle(self.app, APP_ID)

    def test_noncanonical_prefix_is_rejected_for_main_and_share(self):
        for path, identifier in [(self.app, APP_ID),
                                 (self.app / "PlugIns/OpenClawShareExtension.appex", APP_ID + ".share")]:
            raw = plistlib.dumps({
                "application-identifier": "ABCDEFGHIJ." + identifier,
                "com.apple.security.application-groups": [GROUP_ID],
            })
            (path / "Executable").write_bytes(thin(0x100000C, identifier, raw=raw))
            with self.subTest(identifier=identifier), patch.dict(globals(), output=self.inspect_output):
                with self.assertRaises(ValueError):
                    inspect_bundle(path, identifier)

    def test_tar_roundtrip_preserves_modes_links_and_tree(self):
        (self.app / "Resources").mkdir()
        (self.app / "Resources/fixture").write_text("public fixture")
        (self.app / "Current").symlink_to("Resources")
        digest, _, _ = app_tree(self.app)
        archive = self.root / "app.tar"
        write_archive(self.app, {"appTreeSHA256": digest}, archive)
        restored = self.root / "restored"
        with tarfile.open(archive) as stream:
            self.assertTrue(all(item.name == "manifest.json" or item.name == "OpenClaw.app" or item.name.startswith("OpenClaw.app/") for item in stream))
            self.assertTrue(all(item.uid == 0 and item.gid == 0 and not item.uname and not item.gname for item in stream))
            stream.extractall(restored, filter="data")
        self.assertEqual(app_tree(restored / "OpenClaw.app")[0], digest)
        self.assertEqual((restored / "OpenClaw.app/Executable").stat().st_mode & 0o777, 0o755)
        self.assertEqual(os.readlink(restored / "OpenClaw.app/Current"), "Resources")
        self.assertNotIn(str(self.root), archive.read_bytes().decode("latin1"))

    def test_private_files_links_caps_and_extra_payload_are_rejected(self):
        for name in ["embedded.mobileprovision", "private.log", "signing.p12"]:
            candidate = self.app / name
            candidate.write_text("private-sentinel")
            with self.assertRaises(ValueError):
                app_tree(self.app)
            candidate.unlink()
        (self.app / "escape").symlink_to("../../outside")
        with self.assertRaises((ValueError, FileNotFoundError)):
            app_tree(self.app)
        (self.app / "escape").unlink()
        with patch.dict(globals(), LIMIT=1), self.assertRaises(ValueError):
            app_tree(self.app)
        digest, _, _ = app_tree(self.app)
        (self.app.parent / "private-extra").write_text("private-sentinel")
        with self.assertRaises(ValueError):
            write_archive(self.app, {"appTreeSHA256": digest}, self.root / "rejected.tar")
        self.assertFalse((self.root / "rejected.tar").exists())

    def test_mode_and_link_target_are_part_of_tree_identity(self):
        original = app_tree(self.app)[0]
        (self.app / "Executable").chmod(0o644)
        self.assertNotEqual(app_tree(self.app)[0], original)
        (self.app / "Executable").chmod(0o755)
        (self.app / "link").symlink_to("Executable")
        first = app_tree(self.app)[0]
        (self.app / "link").unlink()
        (self.app / "link").symlink_to("Info.plist")
        self.assertNotEqual(app_tree(self.app)[0], first)

    def test_source_mismatch_rejects_before_build(self):
        with patch.dict(os.environ, TARGET_REF=SOURCE, CHECKOUT_SHA="d" * 40):
            with self.assertRaises(ValueError):
                source_fence()

    def run_export(self, *, post_build_changed=False, lifecycle="success"):
        calls = []
        def commands(argv, **kwargs):
            calls.append(argv)
            if argv[0] == "xcodebuild":
                destination = pathlib.Path("apps/ios/build/ReleaseSimulatorArtifact/DerivedData/Build/Products/Release-iphonesimulator/OpenClaw.app")
                shutil.copytree(self.app, destination, symlinks=True)
            return types.SimpleNamespace(returncode=0)
        def inspect(argv):
            if argv[0] == "codesign":
                return self.inspect_output(argv)
            if argv == ["git", "rev-parse", "HEAD"]:
                return "d" * 40 if calls and post_build_changed else SOURCE
            if argv == ["git", "rev-parse", "HEAD^{tree}"]:
                return TREE
            if argv[0:2] == ["git", "status"]:
                return ""
            if argv == ["xcodebuild", "-version"]:
                return "Xcode 26.6\nBuild version 17F113\n"
            if argv == ["swift", "--version"]:
                return "Apple Swift version 6.3.3\nTarget: arm64-apple-macosx\n"
            raise AssertionError("unexpected inspection command")
        previous = pathlib.Path.cwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous)
        with patch.dict(os.environ, TARGET_REF=SOURCE, CHECKOUT_SHA=SOURCE, WORKFLOW_SHA=WORKFLOW,
                        LIFECYCLE_OUTCOME=lifecycle, GITHUB_RUN_ID="123", GITHUB_RUN_ATTEMPT="1",
                        RUNNER_TEMP=str(self.root), GITHUB_OUTPUT=str(self.root / "outputs")):
            with patch.dict(globals(), output=inspect), patch.object(subprocess, "run", commands):
                with contextlib.redirect_stdout(io.StringIO()):
                    main()
        return calls

    def test_normal_build_exports_only_verified_app_and_safe_manifest(self):
        calls = self.run_export()
        self.assertEqual(calls[-1], [
            "xcodebuild", "-project", "apps/ios/OpenClaw.xcodeproj", "-scheme", "OpenClaw",
            "-configuration", "Release", "-destination", "generic/platform=iOS Simulator",
            "-derivedDataPath", "apps/ios/build/ReleaseSimulatorArtifact/DerivedData", "build",
        ])
        outputs = dict(line.split("=", 1) for line in (self.root / "outputs").read_text().splitlines())
        archive = pathlib.Path(outputs["path"])
        self.assertEqual(sha256_file(archive), outputs["sha256"])
        with tarfile.open(archive) as stream:
            manifest = json.load(stream.extractfile("manifest.json"))
        self.assertEqual(manifest["sourceSHA"], SOURCE)
        self.assertEqual(manifest["sourceTree"], TREE)
        self.assertEqual(manifest["workflowSHA"], WORKFLOW)
        self.assertEqual(manifest["runID"], "123")
        self.assertEqual(manifest["runAttempt"], "1")
        self.assertTrue(manifest["shareExtension"]["canonicalAppGroup"])
        self.assertNotIn(str(self.root), json.dumps(manifest))
        self.assertNotIn(TEAM, json.dumps(manifest))
        self.assertNotIn("application-identifier", json.dumps(manifest))

    def test_changed_source_cannot_export_after_successful_build(self):
        with self.assertRaises(ValueError):
            self.run_export(post_build_changed=True)
        self.assertFalse((self.root / "outputs").exists())
        self.assertFalse(any(self.root.rglob("*.tar")))

    def test_missing_native_execution_cannot_start_export_build(self):
        with self.assertRaises(ValueError):
            self.run_export(lifecycle="skipped")
        self.assertFalse((self.root / "apps").exists())

    def test_share_version_mismatch_cannot_export(self):
        path = self.app / "PlugIns/OpenClawShareExtension.appex/Info.plist"
        info = plistlib.loads(path.read_bytes())
        info["CFBundleVersion"] = "54321"
        path.write_bytes(plistlib.dumps(info))
        with self.assertRaises(ValueError):
            self.run_export()
        self.assertFalse((self.root / "outputs").exists())

    def test_build_failure_cannot_export(self):
        calls = []
        def fail_build(argv, **kwargs):
            calls.append(argv)
            return types.SimpleNamespace(returncode=19)
        previous = pathlib.Path.cwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous)
        with patch.dict(os.environ, LIFECYCLE_OUTCOME="success", WORKFLOW_SHA=WORKFLOW,
                        GITHUB_RUN_ID="123", GITHUB_RUN_ATTEMPT="1"):
            with patch.dict(globals(), source_fence=lambda: (SOURCE, TREE)), patch.object(subprocess, "run", fail_build):
                with self.assertRaises(ValueError):
                    main()
        self.assertEqual(calls, [["./scripts/ios-configure-signing.sh"]])
        self.assertFalse(any(self.root.rglob("*.tar")))

result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(ExportContract))
raise SystemExit(0 if result.wasSuccessful() else 1)
`;

describe.skipIf(process.platform === "win32")("Release simulator artifact workflow", () => {
  it("validates built identity, privacy, source, archive topology, and failure gates", () => {
    expect(python).toBeTruthy();
    const program =
      "namespace = {'__name__': 'workflow_test'}\nexec(" +
      JSON.stringify(python) +
      ", namespace)\nexec(" +
      JSON.stringify(checks) +
      ", namespace)\n";
    const result = spawnSync("python3", ["-I", "-S", "-c", program], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["workflow_dispatch", "full", "false", "a".repeat(40), 0],
    ["pull_request", "full", "false", "a".repeat(40), 1],
    ["workflow_dispatch", "npm-beta", "false", "a".repeat(40), 1],
    ["workflow_dispatch", "full", "true", "a".repeat(40), 1],
    ["workflow_dispatch", "full", "false", "", 1],
    ["workflow_dispatch", "full", "false", "main", 1],
  ])("validates export dispatch %s/%s/%s/%s", (event, scope, releaseGate, target, code) => {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", gate.run!], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: event,
        RELEASE_SCOPE: scope,
        RELEASE_GATE: releaseGate,
        TARGET_REF: target,
      },
    });
    expect(result.status, result.stderr).toBe(code);
  });

  it("keeps export opt-in and preserves the ordinary build and upload contract", () => {
    expect(workflow.on.workflow_dispatch.inputs.export_ios_release_simulator.default).toBe(false);
    expect(producer.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(producer.if).toContain("inputs.export_ios_release_simulator");
    expect(producer.if).toContain("matrix.phase == 'tests'");
    expect(producer.run).not.toMatch(
      /CODE_SIGNING_ALLOWED|CODE_SIGN_IDENTITY=|ARCHS=|--build-number/,
    );
    const upload = steps.find((step) => step.name === "Upload Release iOS simulator app")!;
    expect(upload.if).toBe("steps.ios_release_simulator.outcome == 'success'");
    expect(upload.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(upload.with).toMatchObject({
      archive: false,
      "if-no-files-found": "error",
      "retention-days": 7,
    });
  });
});
