// iOS release wrapper tests keep release args fail-closed before Fastlane work.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const gemfilePath = path.join(process.cwd(), "apps", "ios", "Gemfile");

function runScript(
  scriptPath: string,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): { ok: boolean; stdout: string; stderr: string } {
  const scriptArgs =
    process.platform === "win32" ? [scriptPath] : ["--noprofile", "--norc", scriptPath];
  try {
    const stdout = execFileSync(BASH_BIN, [...scriptArgs, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown };
    const stdout = Buffer.isBuffer(e.stdout)
      ? e.stdout.toString("utf8")
      : ((e.stdout ?? "") as string);
    const stderr = Buffer.isBuffer(e.stderr)
      ? e.stderr.toString("utf8")
      : ((e.stderr ?? "") as string);
    return { ok: false, stdout, stderr };
  }
}

describe("iOS release shell wrapper arguments", () => {
  it("rejects App Store release relay URL overrides before release work", () => {
    const result = runScript(
      path.join(process.cwd(), "scripts/ios-release-prepare.sh"),
      ["--version", "2026.7.2", "--revision", "1", "--build-number", "3"],
      {
        IOS_DEVELOPMENT_TEAM: "FWJYW4S8P8",
        OPENCLAW_PUSH_RELAY_BASE_URL: "https://relay.example.com",
      },
    );

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("custom relay URL overrides are not allowed");
    expect(result.stderr).not.toContain("fastlane");
    expect(result.stdout).toBe("");
  });

  it("requires stamped build metadata for App Store release preparation", () => {
    const script = readFileSync(path.join(process.cwd(), "scripts/ios-release-prepare.sh"), "utf8");

    expect(script).toContain("OPENCLAW_REQUIRE_BUILD_METADATA=1");
    expect(script).toContain(
      'RELEASE_SOURCE_HELPER="${ROOT_DIR}/scripts/apple-release-source-check.sh"',
    );
    expect(script).toContain('--expected-commit "${RELEASE_GIT_COMMIT}"');
    expect(script.indexOf('bash "${RELEASE_SOURCE_HELPER}"')).toBeLessThan(
      script.lastIndexOf("prepare_build_dir"),
    );
    expect(script).toContain('export GIT_COMMIT="${RELEASE_GIT_COMMIT}"');
  });

  function runSharedFastlane(options: {
    fastlaneExit: number;
    bundleGemfile?: string;
    changeDirectoryAfterSource?: boolean;
    uploadArgs?: string[];
  }) {
    const binDir = tempDirs.make("openclaw-fastlane-test-");
    const bundle = path.join(binDir, "bundle");
    const fastlane = path.join(binDir, "fastlane");
    writeFileSync(
      bundle,
      "#!/usr/bin/env bash\n" +
        '[[ "$BUNDLE_GEMFILE" == "$OPENCLAW_FASTLANE_EXPECTED_GEMFILE" ]] || exit 91\n' +
        '[[ "${1:-}" == "_4.0.22_" ]] || exit 92\n' +
        '[[ "${2:-}" != "check" ]] || exit 0\n' +
        '[[ "${2:-}" == "exec" && "${3:-}" == "fastlane" ]] || exit 93\n' +
        "shift 3\n" +
        'exec fastlane "$@"\n',
    );
    writeFileSync(
      fastlane,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*"\nexit ${options.fastlaneExit}\n`,
    );
    chmodSync(bundle, 0o755);
    chmodSync(fastlane, 0o755);
    return spawnSync(
      BASH_BIN,
      options.uploadArgs
        ? ["scripts/ios-release-upload.sh", ...options.uploadArgs]
        : [
            "-c",
            options.changeDirectoryAfterSource
              ? "source scripts/lib/ios-fastlane.sh; cd apps/ios; run_ios_fastlane ios release_plan"
              : "source scripts/lib/ios-fastlane.sh; run_ios_fastlane ios release_plan",
          ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BUNDLE_GEMFILE: options.bundleGemfile ?? "",
          OPENCLAW_FASTLANE_EXPECTED_GEMFILE: gemfilePath,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
      },
    );
  }

  it("routes stage recovery to the non-uploading lane with the saved identity", () => {
    const result = runSharedFastlane({
      fastlaneExit: 0,
      uploadArgs: [
        "--stage-only",
        "--version",
        "2026.7.2",
        "--revision",
        "1",
        "--build-number",
        "3",
      ],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      "ios release_stage release_version:2026.7.2 app_store_revision:1 build_number:3\n",
    );
  });

  it("keeps the repository Gemfile after the caller changes directories", () => {
    const result = runSharedFastlane({
      bundleGemfile: "/tmp/hostile/Gemfile",
      changeDirectoryAfterSource: true,
      fastlaneExit: 0,
    });

    expect(result.status).toBe(0);
  });
});
