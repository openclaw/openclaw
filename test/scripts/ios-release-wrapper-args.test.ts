import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const gemfilePath = path.join(process.cwd(), "apps", "ios", "Gemfile");
const releaseArgs = ["--version", "2026.7.2", "--revision", "1", "--build-number", "3"];
const runBash = (args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(BASH_BIN, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

describe("iOS release shell wrapper arguments", () => {
  it("rejects App Store release relay URL overrides before release work", () => {
    const result = runBash(
      [
        ...(process.platform === "win32" ? [] : ["--noprofile", "--norc"]),
        "scripts/ios-release-prepare.sh",
        ...releaseArgs,
      ],
      {
        IOS_DEVELOPMENT_TEAM: "FWJYW4S8P8",
        OPENCLAW_PUSH_RELAY_BASE_URL: "https://relay.example.com",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("custom relay URL overrides are not allowed");
    expect(result.stderr).not.toContain("fastlane");
    expect(result.stdout).toBe("");
  });

  it("requires stamped build metadata for App Store release preparation", () => {
    const script = readFileSync(path.join(process.cwd(), "scripts/ios-release-prepare.sh"), "utf8");

    for (const marker of [
      "OPENCLAW_REQUIRE_BUILD_METADATA=1",
      'RELEASE_SOURCE_HELPER="${ROOT_DIR}/scripts/apple-release-source-check.sh"',
      '--expected-commit "${RELEASE_GIT_COMMIT}"',
      'export GIT_COMMIT="${RELEASE_GIT_COMMIT}"',
    ]) {
      expect(script).toContain(marker);
    }
    expect(script.indexOf('bash "${RELEASE_SOURCE_HELPER}"')).toBeLessThan(
      script.lastIndexOf("prepare_build_dir"),
    );
  });

  function runSharedFastlane(args: string[], bundleGemfile = "") {
    const binDir = tempDirs.make("openclaw-fastlane-test-");
    const bundle = path.join(binDir, "bundle");
    const fastlane = path.join(binDir, "fastlane");
    writeFileSync(
      bundle,
      "#!/usr/bin/env bash\n" +
        '[[ "$BUNDLE_GEMFILE" == "$OPENCLAW_FASTLANE_EXPECTED_GEMFILE" ]] || exit 91\n' +
        '[[ "${1:-}" == "_4.0.23_" ]] || exit 92\n' +
        '[[ "${2:-}" != "check" ]] || exit 0\n' +
        '[[ "${2:-}" == "exec" && "${3:-}" == "fastlane" ]] || exit 93\n' +
        "shift 3\n" +
        'exec fastlane "$@"\n',
    );
    writeFileSync(fastlane, `#!/usr/bin/env bash\nprintf '%s\\n' "$*"\nexit 0\n`);
    chmodSync(bundle, 0o755);
    chmodSync(fastlane, 0o755);
    return runBash(args, {
      BUNDLE_GEMFILE: bundleGemfile,
      OPENCLAW_FASTLANE_EXPECTED_GEMFILE: gemfilePath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });
  }

  it("routes stage recovery to the non-uploading lane with the saved identity", () => {
    const result = runSharedFastlane([
      "scripts/ios-release-upload.sh",
      "--stage-only",
      ...releaseArgs,
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      "ios release_stage release_version:2026.7.2 app_store_revision:1 build_number:3\n",
    );
  });

  it("keeps the repository Gemfile after the caller changes directories", () => {
    const result = runSharedFastlane(
      ["-c", "source scripts/lib/ios-fastlane.sh; cd apps/ios; run_ios_fastlane ios release_plan"],
      "/tmp/hostile/Gemfile",
    );

    expect(result.status).toBe(0);
  });
});

it("rejects non-canonical signing teams before generating release inputs", () => {
  const result = runBash(
    [
      ...(process.platform === "win32" ? [] : ["--noprofile", "--norc"]),
      "scripts/ios-release-prepare.sh",
      ...releaseArgs,
    ],
    { IOS_DEVELOPMENT_TEAM: "Y3YUZP442G" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "iOS App Store release must use official OpenClaw Team ID FWJYW4S8P8",
  );
  expect(result.stderr).toContain("got Y3YUZP442G");
});

const runSigning = (...args: string[]) =>
  spawnSync(process.execPath, ["scripts/ios-release-signing.mjs", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

it.each([
  ["--mode", "--manifest"],
  ["--mode", "-h"],
  ["--manifest", "-h"],
])("rejects missing values for %s before reading signing manifests", (...args) => {
  const result = runSigning(...args);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`Missing value for ${args[0]}.`);
  expect(result.stderr).not.toContain("ENOENT");
  expect(result.stdout).toBe("");
});

it.each([
  {
    name: "emits manual App Store profile settings for every signed target",
    mode: "xcconfig",
    contains: [
      "OPENCLAW_CODE_SIGN_STYLE = Manual",
      "OPENCLAW_CODE_SIGN_IDENTITY = Apple Distribution",
      "OPENCLAW_APP_GROUP_ID = group.ai.openclawfoundation.app.shared",
      "OPENCLAW_APP_PROFILE = OpenClaw App Store ai.openclawfoundation.app",
      "OPENCLAW_SHARE_PROFILE = OpenClaw App Store ai.openclawfoundation.app.share",
      "OPENCLAW_ACTIVITY_WIDGET_PROFILE = OpenClaw App Store ai.openclawfoundation.app.activitywidget",
      "OPENCLAW_WATCH_APP_PROFILE = OpenClaw App Store ai.openclawfoundation.app.watchkitapp",
    ],
    excludes: "OPENCLAW_WATCH_EXTENSION_PROFILE",
  },
  {
    name: "documents the canonical release signing plan",
    mode: "plan",
    contains: [
      "Team ID: FWJYW4S8P8",
      "Signing repo: git@github.com:openclaw/apps-signing.git",
      "Signing branch: main",
      "Signing setup and sync: Fastlane match",
      "capabilities: PUSH_NOTIFICATIONS, APP_GROUPS, APP_ATTEST, HEALTH_KIT",
      "app groups: group.ai.openclawfoundation.app.shared",
    ],
    excludes: "OpenClawWatchExtension",
  },
])("$name", ({ mode, contains, excludes }) => {
  const result = runSigning("--mode", mode);
  expect(result.status, result.stderr).toBe(0);
  for (const text of contains) {
    expect(result.stdout).toContain(text);
  }
  expect(result.stdout).not.toContain(excludes);
});
