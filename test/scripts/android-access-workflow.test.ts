import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const job = workflow.jobs["android-access-native"];
const step = job.steps.find(
  (entry: { name?: string }) => entry.name === "Run packaged Access crypto on Android",
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function verifyReports(mode: string) {
  const root = tempDirs.make("openclaw-access-reports-");
  const verification = step.run.split("python3 - <<'PY'\n")[1]?.split("\nPY")[0];
  if (!verification) throw new Error("Missing native report verification");
  return spawnSync(
    "python3",
    [
      "-c",
      String.raw`
from pathlib import Path
import json, sys, zipfile
mode = sys.argv[1]
reports = Path('apps/android/app/build/outputs/androidTest-results/connected/debug')
reports.mkdir(parents=True)
name = 'OtherTest' if mode == 'wrong-class' else 'ai.openclaw.app.gateway.CloudflareAccessNativeTest'
child = '<failure/>' if mode == 'failed' else '<skipped/>' if mode == 'skipped' else ''
case = '' if mode == 'empty' else f'<testcase classname="{name}" name="vector">{child}</testcase>'
(reports / 'TEST-device.xml').write_text(f'<testsuite>{case}</testsuite>')
apk = Path('apps/android/app/build/outputs/apk/play/debug/openclaw-2099.1.2-play-debug.apk')
apk.parent.mkdir(parents=True)
element = {'outputFile': '../outside.apk' if mode == 'outside-output' else apk.name, 'filters': []}
metadata = {'variantName': 'thirdPartyDebug' if mode == 'wrong-variant' else 'playDebug',
            'artifactType': {'type': 'APK'}, 'elements': [element, element] if mode == 'ambiguous-output' else [element]}
(apk.parent / 'output-metadata.json').write_text(json.dumps(metadata))
abis = ['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64']
if mode == 'missing-abi': abis.pop()
with zipfile.ZipFile(apk, 'w') as archive:
    for abi in abis: archive.writestr(f'lib/{abi}/libsodium.so', b'test-only')
` + verification,
      mode,
    ],
    { cwd: root, encoding: "utf8" },
  );
}

describe("Android Access native workflow", () => {
  it("runs the packaged class on current Android targets and includes its result in CI", () => {
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job.if).toContain("run_android_job == 'true'");
    expect(job.if).toContain("compatibility_target != 'true'");
    expect(step.run).toContain(":app:connectedPlayDebugAndroidTest");
    expect(step.run).toContain(
      "-Pandroid.testInstrumentationRunnerArguments.class=ai.openclaw.app.gateway.CloudflareAccessNativeTest",
    );
    expect(step.run).toContain('zipalign" -c -P 16 -v 4');
    expect(step.run).toContain('zipalign" -c -P 16 -v 4 "$apk"');
    expect(workflow.jobs["ci-gate"].needs).toContain("android-access-native");
    expect(workflow.jobs["ci-gate"].steps[0].env.JOB_RESULTS).toContain(
      "android-access-native=${{ needs.android-access-native.result }}|",
    );
  });

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

  it("accepts an executed passing native vector and all four packaged ABIs", () => {
    const result = verifyReports("passed");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      "apps/android/app/build/outputs/apk/play/debug/openclaw-2099.1.2-play-debug.apk",
    );
  });

  it.each([
    "empty",
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
