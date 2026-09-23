import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  selectAndroidAccessTests,
  verifyAndroidAccessReports,
} from "../helpers/android-access-workflow.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const job = workflow.jobs["android-access-native"];
const step = job.steps.find(
  (entry: { name?: string }) => entry.name === "Run packaged Access crypto on Android",
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function verifyReports(mode: string) {
  const selection = selectAndroidAccessTests(step.run, { RUN_ACCESS_PERSISTENCE: "true" });
  expect(selection.status, selection.stderr).toBe(0);
  return verifyAndroidAccessReports(
    tempDirs.make("openclaw-access-reports-"),
    step.run,
    mode,
    selection.stdout.trim().split("\n")[0] ?? "",
  );
}

describe("Android Access native workflow", () => {
  it("runs the packaged class on current Android targets and includes its result in CI", () => {
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(workflow.jobs.preflight.outputs.run_android_access_native).toBe(
      "${{ steps.manifest.outputs.run_android_access_native }}",
    );
    expect(job.if).toBe("needs.preflight.outputs.run_android_access_native == 'true'");
    expect(step.run).toContain(":app:connectedPlayDebugAndroidTest");
    expect(step.run).toContain('"$native_test_filter"');
    expect(workflow.jobs.preflight.outputs.run_android_access_persistence).toBe(
      "${{ steps.manifest.outputs.run_android_access_persistence }}",
    );
    expect(step.env.RUN_ACCESS_PERSISTENCE).toBe(
      "${{ needs.preflight.outputs.run_android_access_persistence }}",
    );
    expect(step.run).toContain('zipalign" -c -P 16 -v 4');
    expect(step.run).toContain('zipalign" -c -P 16 -v 4 "$apk"');
    expect(workflow.jobs["ci-gate"].needs).toContain("android-access-native");
    expect(workflow.jobs["ci-gate"].steps[0].env.JOB_RESULTS).toContain(
      "android-access-native=${{ needs.android-access-native.result }}|${{ needs.preflight.outputs.run_android_access_native }}",
    );
  });

  it.each([false, true])(
    "selects supported Debug methods with adb quoting (persistence=%s)",
    (persistence) => {
      const result = selectAndroidAccessTests(step.run, {
        RUN_ACCESS_PERSISTENCE: String(persistence),
      });
      expect(result.status, result.stderr).toBe(0);
      const [classes = "", filter = ""] = result.stdout.trim().split("\n");
      const prefix = "-Pandroid.testInstrumentationRunnerArguments.tests_regex=";
      expect(filter.startsWith(prefix)).toBe(true);
      const value = filter.slice(prefix.length);
      expect(value).not.toContain(",");
      expect(value.startsWith("'") && value.endsWith("'")).toBe(true);
      const remote = spawnSync("bash", ["-c", `printf '%s' ${value}`], { encoding: "utf8" });
      expect(remote.status, remote.stderr).toBe(0);
      expect(remote.stdout.startsWith("^") && remote.stdout.endsWith("$")).toBe(true);
      const selection = new RegExp(remote.stdout);
      const methods = [
        "ai.openclaw.app.gateway.CloudflareAccessNativeTest#packagedSodiumLoadsAndDecryptsTheGoTransferVector",
        "ai.openclaw.app.gateway.CloudflareAccessPersistenceNativeTest#encryptedGrantRestoresAndDeletesWithoutChangingGatewayPairing",
      ];
      expect(classes.split(",")).toEqual(
        methods.slice(0, persistence ? 2 : 1).map((method) => method.split("#")[0]),
      );
      for (const [index, method] of methods.entries()) {
        expect(selection.test(method)).toBe(index === 0 || persistence);
        expect(selection.test(`other.${method}`)).toBe(false);
        expect(selection.test(`${method}Extra`)).toBe(false);
        expect(selection.test(method.replace(/#.+$/, "#otherMethod"))).toBe(false);
      }
    },
  );

  it("requires ordinary and strict simulated 16 KiB packaged execution", () => {
    expect(job.strategy).toEqual({
      "fail-fast": false,
      matrix: {
        include: [
          { "page-size": 4096, image: "google_apis" },
          { "page-size": 16384, image: "google_apis_ps16k" },
        ],
      },
    });
    expect(step.env.EXPECTED_PAGE_SIZE).toBe("${{ matrix.page-size }}");
    expect(step.env.SYSTEM_IMAGE).toBe("system-images;android-36;${{ matrix.image }};x86_64");
    expect(step.run).toContain(
      '-Pandroid.testInstrumentationRunnerArguments.expectedPageSize="$EXPECTED_PAGE_SIZE"',
    );
    const guard = step.run.slice(
      step.run.indexOf('test "$(adb -s emulator-5554 shell getconf PAGE_SIZE'),
      step.run.indexOf("node --import ./scripts/tsx.mjs"),
    );
    expect(guard).toContain("setprop bionic.linker.16kb.app_compat.enabled false");
    expect(guard).toContain("setprop pm.16kb.app_compat.disabled true");
    for (const [pageSize, linker, packageManager, passes] of [
      [16384, "false", "true", true],
      [4096, "false", "true", false],
      [16384, "true", "true", false],
      [16384, "false", "false", false],
    ] as const) {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
EXPECTED_PAGE_SIZE=16384
RUN_ACCESS_PERSISTENCE=true
adb() {
  case "$*" in
    *"getconf PAGE_SIZE") echo ${pageSize} ;;
    *"getprop bionic.linker.16kb.app_compat.enabled") echo ${linker} ;;
    *"getprop pm.16kb.app_compat.disabled") echo ${packageManager} ;;
  esac
}
${guard}`,
        ],
        { encoding: "utf8" },
      );
      expect(result.status === 0, result.stderr).toBe(passes);
    }
  });

  it("accepts executed native crypto and persistence tests with all four packaged ABIs", () => {
    const result = verifyReports("passed");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      "apps/android/app/build/outputs/apk/play/debug/openclaw-2099.1.2-play-debug.apk",
    );
  });

  it.each([
    "empty",
    "duplicate",
    "missing-store",
    "error",
    "wrong-class",
    "failed",
    "skipped",
    "missing-abi",
    "wrong-variant",
    "ambiguous-output",
    "outside-output",
  ])("rejects %s evidence even when Gradle returned success", (mode) => {
    const result = verifyReports(mode);
    expect(result.status, result.stderr).not.toBe(0);
  });
});
