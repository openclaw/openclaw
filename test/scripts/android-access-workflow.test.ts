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
