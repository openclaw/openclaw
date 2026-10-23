import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  evaluateWorkflowRunner,
  expectIncludes as containsAll,
  readCiWorkflow,
} from "./ci-workflow.test-support.js";

const workflow = readCiWorkflow();
const job = workflow.jobs["android-access-native"];
const step = job.steps.find(
  (entry: { name?: string }) => entry.name === "Run packaged Access crypto on Android",
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const pageSizes = [
  { "page-size": 4096, image: "google_apis" },
  { "page-size": 16384, image: "google_apis_ps16k" },
];
const invalidReports = ["empty", "wrong-class", "failed", "skipped"];
const invalidApks = ["missing-abi", "wrong-variant", "ambiguous-output", "outside-output"];

function verifyReports(mode: string) {
  const root = tempDirs.make("openclaw-access-reports-");
  const verification = step.run.split("python3 - <<'PY'\n")[1]?.split("\nPY")[0];
  if (!verification) {
    throw new Error("Missing native report verification");
  }
  const fixture = String.raw`
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
`;
  return spawnSync("python3", ["-c", fixture + verification, mode], {
    cwd: root,
    encoding: "utf8",
  });
}

it("runs the packaged class with pinned Android tooling", () => {
  expect(job.permissions).toEqual({ contents: "read" });
  expect(evaluateWorkflowRunner(job["runs-on"], { eventName: "pull_request" })).toBe(
    "ubuntu-24.04",
  );
  expect(workflow.jobs.preflight.outputs.run_android_access_native).toBe(
    "${{ steps.manifest.outputs.run_android_access_native }}",
  );
  containsAll(step.run, [
    ":app:connectedPlayDebugAndroidTest",
    "-Pandroid.testInstrumentationRunnerArguments.class=ai.openclaw.app.gateway.CloudflareAccessNativeTest",
    'zipalign" -c -P 16 -v 4 "$apk"',
  ]);
  const zipalignVersion = step.run.match(/\/build-tools\/([^/]+)\/zipalign"/)?.[1];
  expect(zipalignVersion).toBeDefined();
  expect(readFileSync(".github/actions/setup-android-toolchain/action.yml", "utf8")).toContain(
    `"build-tools;${zipalignVersion}"`,
  );
});

it("requires ordinary and strict simulated 16 KiB packaged execution", () => {
  expect(job.strategy).toEqual({ "fail-fast": false, matrix: { include: pageSizes } });
  expect(step.env).toMatchObject({
    EXPECTED_PAGE_SIZE: "${{ matrix.page-size }}",
    SYSTEM_IMAGE: "system-images;android-36;${{ matrix.image }};x86_64",
  });
  expect(step.run).toContain(
    '-Pandroid.testInstrumentationRunnerArguments.expectedPageSize="$EXPECTED_PAGE_SIZE"',
  );
  const guard = step.run.slice(
    step.run.indexOf('test "$(adb -s emulator-5554 shell getconf PAGE_SIZE'),
    step.run.indexOf("node --import ./scripts/tsx.mjs"),
  );
  containsAll(guard, [
    "setprop bionic.linker.16kb.app_compat.enabled false",
    "setprop pm.16kb.app_compat.disabled true",
  ]);
  for (const [pageSize, linker, packageManager, passes] of [
    [16384, "false", "true", true],
    [4096, "false", "true", false],
    [16384, "true", "true", false],
    [16384, "false", "false", false],
  ] as const) {
    const fixture = `set -euo pipefail
EXPECTED_PAGE_SIZE=16384
adb() {
  case "$*" in
    *"getconf PAGE_SIZE") echo ${pageSize} ;;
    *"getprop bionic.linker.16kb.app_compat.enabled") echo ${linker} ;;
    *"getprop pm.16kb.app_compat.disabled") echo ${packageManager} ;;
  esac
}
${guard}`;
    const result = spawnSync("bash", ["-c", fixture], { encoding: "utf8" });
    expect(result.status === 0, result.stderr).toBe(passes);
  }
});

it.each(["passed", ...invalidReports, ...invalidApks])(
  "validates %s native evidence independently of Gradle's exit code",
  (mode) => {
    const result = verifyReports(mode);
    if (mode === "passed") {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(
        "apps/android/app/build/outputs/apk/play/debug/openclaw-2099.1.2-play-debug.apk",
      );
    } else {
      expect(result.status, result.stderr).not.toBe(0);
    }
  },
);
