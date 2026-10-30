import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { resolveWorkflowBash } from "../helpers/workflow-bash.js";
import { readCiWorkflow } from "./ci-workflow.test-support.js";

const workflow = readCiWorkflow();
const job = workflow.jobs["android-access-native"];
const step = job.steps.find(
  (entry: { name?: string }) =>
    entry.name === "Run packaged Access crypto and production TLS on Android",
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workflowBash = resolveWorkflowBash();
const invalidReports = [
  "empty",
  "wrong-class",
  "failed",
  "skipped",
  "missing-tls",
  "duplicate-tls",
  "wrong-tls-method",
  "failed-tls",
  "skipped-tls",
];
const invalidApks = ["missing-abi", "wrong-variant", "ambiguous-output", "outside-output"];

function rootAdmission(
  rootStatus: number,
  rootOutput: string,
  uidStatus = 0,
  uid = "0",
  waitStatus = 0,
) {
  const root = tempDirs.make("openclaw-android-root-");
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  const calls = path.join(root, "calls.txt");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "uname"), "#!/bin/bash\nprintf 'Linux\\n'\n", { mode: 0o755 });
  writeFileSync(
    path.join(bin, "adb"),
    `#!/bin/bash
set -euo pipefail
[[ "$1/$2" == -s/emulator-5554 ]]
shift 2
printf '%s\\n' "$*" >> "$ADB_TEST_CALLS"
case "$*" in
  'shell getprop ro.kernel.qemu') echo 1 ;;
  root) printf '%s\\n' "$ADB_TEST_ROOT_OUTPUT" >&2; exit "$ADB_TEST_ROOT_STATUS" ;;
  wait-for-device) exit "$ADB_TEST_WAIT_STATUS" ;;
  'shell id -u') printf '%s\\r\\n' "$ADB_TEST_UID"; exit "$ADB_TEST_UID_STATUS" ;;
  'shell getprop ro.build.fingerprint') exit 91 ;;
  'shell am force-stop ai.openclaw.app.debug' | uninstall*) ;;
  'shell pm list packages ai.openclaw.app.debug') ;;
  *) echo "Unexpected adb command: $*" >&2; exit 99 ;;
esac
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    ADB_TEST_CALLS: calls,
    ADB_TEST_ROOT_OUTPUT: rootOutput,
    ADB_TEST_ROOT_STATUS: String(rootStatus),
    ADB_TEST_WAIT_STATUS: String(waitStatus),
    ADB_TEST_UID: uid,
    ADB_TEST_UID_STATUS: String(uidStatus),
  };
  const run = (mode: string) =>
    spawnSync(workflowBash, ["scripts/android-native-tls-trust.sh", mode, state], {
      env,
      encoding: "utf8",
      timeout: 5_000,
    });
  return { result: run("prepare"), run, state, calls };
}

it.each([
  ["ordinary root restart", 0, "restarting adbd as root", 0, "0", 0, 91],
  ["closed root transport", 1, "adb: unable to connect for root: closed", 0, "0", 0, 91],
  ["another root error", 1, "adb: unable to connect for root: unauthorized", 0, "0", 0, 1],
  ["another root exit status", 2, "adb: unable to connect for root: closed", 0, "0", 0, 2],
  ["nonroot device", 0, "adbd cannot run as root", 0, "2000", 0, 1],
  ["closed transport without root", 1, "adb: unable to connect for root: closed", 0, "2000", 0, 1],
  ["failed UID query printing zero", 0, "adbd is already running as root", 42, "0", 0, 42],
  ["failed reconnect", 1, "adb: unable to connect for root: closed", 0, "0", 43, 43],
] as const)(
  "checks actual device authority after %s before touching trust",
  (_name, rootStatus, rootOutput, uidStatus, uid, waitStatus, status) => {
    const fixture = rootAdmission(rootStatus, rootOutput, uidStatus, uid, waitStatus);
    expect(fixture.result.status, fixture.result.stderr).toBe(status);
    const calls = readFileSync(fixture.calls, "utf8");
    expect(calls.includes("shell getprop ro.build.fingerprint")).toBe(status === 91);
    expect(calls).not.toMatch(/push |mount |mkdir /);
    expect(readFileSync(path.join(fixture.state, "adb-root-request.log"), "utf8")).toBe(
      `${rootOutput}\n`,
    );
    expect(readFileSync(path.join(fixture.state, "adb-root-request.status"), "utf8")).toBe(
      `${rootStatus}\n`,
    );
  },
);

it("can clean up a rejected root admission without a trust baseline", () => {
  const fixture = rootAdmission(1, "adb: unable to connect for root: closed", 0, "2000");
  expect(fixture.result.status).toBe(1);
  const cleanup = fixture.run("cleanup");
  expect(cleanup.status, cleanup.stderr).toBe(0);
  expect(readFileSync(path.join(fixture.state, "CLEANUP.txt"), "utf8")).toBe(
    "No trust baseline captured; no trust mutation attempted.\n",
  );
});

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
tls_methods = {
    'ai.openclaw.app.gateway.GatewaySessionTlsNativeTest': [
        'platformRootReachesReadyWithMatchingHostname',
        'platformRootRejectsWrongHostnameBeforeWebSocketUpgrade',
        'platformRootCannotBypassBlocklistedRawIntermediate',
        'matchingLeafPinReachesReadyDespiteDiscoveredIpHostnameMismatch',
        'wrongLeafPinRejectsBeforeWebSocketUpgrade',
        'matchingLeafPinCannotBypassBlocklistedRawIntermediate'],
    'ai.openclaw.app.ui.chat.ChatInlineWidgetTlsNativeTest': [
        'platformRootFetchesDocumentWithMatchingHostname',
        'platformRootRejectsWrongHostnameWithoutOriginRequest',
        'platformRootCannotFetchThroughBlocklistedRawIntermediate',
        'matchingLeafPinFetchesDocumentDespiteDiscoveredIpHostnameMismatch',
        'wrongLeafPinReturnsUnavailableWithoutOriginRequest',
        'matchingLeafPinCannotFetchThroughBlocklistedRawIntermediate']}
tls_cases = [f'<testcase classname="{cls}" name="{method}"/>'
             for cls, methods in tls_methods.items() for method in methods]
if mode == 'missing-tls': tls_cases.pop()
if mode == 'duplicate-tls': tls_cases[-1] = tls_cases[0]
if mode == 'wrong-tls-method': tls_cases[-1] = tls_cases[-1].replace('matchingLeafPinCannotFetchThroughBlocklistedRawIntermediate', 'notTheRequiredCase')
if mode in ('failed-tls', 'skipped-tls'):
    tag = 'failure' if mode == 'failed-tls' else 'skipped'
    tls_cases[-1] = tls_cases[-1].replace('/>', f'><{tag}/></testcase>')
(reports / 'TEST-device.xml').write_text(f'<testsuite>{case}{"".join(tls_cases)}</testsuite>')
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

it("uses read-only permissions and installed alignment tooling", () => {
  expect(job.permissions).toEqual({ contents: "read" });
  const zipalignVersion = step.run.match(/\/build-tools\/([^/]+)\/zipalign"/)?.[1];
  expect(zipalignVersion).toBeDefined();
  expect(readFileSync(".github/actions/setup-android-toolchain/action.yml", "utf8")).toContain(
    `"build-tools;${zipalignVersion}"`,
  );
});

it("requires ordinary and strict simulated 16 KiB packaged execution", () => {
  const guard = step.run.slice(
    step.run.indexOf('test "$(adb -s emulator-5554 shell getconf PAGE_SIZE'),
    step.run.indexOf("bash scripts/android-native-tls-trust.sh prepare"),
  );
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
