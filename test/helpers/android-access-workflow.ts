import { spawnSync } from "node:child_process";

export function selectAndroidAccessTests(run: string, env: Record<string, string> = {}) {
  const start = run.indexOf('test "$(adb -s emulator-5554 shell getconf PAGE_SIZE');
  const end = run.indexOf("node --import ./scripts/tsx.mjs", start);
  if (start < 0 || end < 0) {
    throw new Error("Missing native test selection");
  }
  return spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
adb() { printf '4096\\n'; }
${run.slice(start, end)}
printf '%s\\n%s\\n' "$ACCESS_NATIVE_TEST_CLASSES" "$native_test_filter"`,
    ],
    { encoding: "utf8", env: { ...process.env, EXPECTED_PAGE_SIZE: "4096", ...env } },
  );
}

export function verifyAndroidAccessReports(
  root: string,
  run: string,
  mode: string,
  selectedClasses: string,
  reportedClasses: string = selectedClasses,
) {
  const verification = run.split("python3 - <<'PY'\n")[1]?.split("\nPY")[0];
  if (!verification) {
    throw new Error("Missing native report verification");
  }
  return spawnSync(
    "python3",
    [
      "-c",
      String.raw`
from pathlib import Path
import json, os, sys, zipfile
mode = sys.argv[1]
reports = Path('apps/android/app/build/outputs/androidTest-results/connected/debug')
reports.mkdir(parents=True)
names = os.environ['ACCESS_NATIVE_REPORTED_CLASSES'].split(',')
if mode == 'wrong-class': names[0] = 'OtherTest'
if mode == 'missing-store': names = names[:1]
if mode == 'duplicate': names.append(names[0])
child = '<failure/>' if mode == 'failed' else '<error/>' if mode == 'error' else '<skipped/>' if mode == 'skipped' else ''
cases = '' if mode == 'empty' else ''.join(f'<testcase classname="{name}" name="native">{child}</testcase>' for name in names)
(reports / 'TEST-device.xml').write_text(f'<testsuite>{cases}</testsuite>')
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
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ACCESS_NATIVE_TEST_CLASSES: selectedClasses,
        ACCESS_NATIVE_REPORTED_CLASSES: reportedClasses,
      },
    },
  );
}
