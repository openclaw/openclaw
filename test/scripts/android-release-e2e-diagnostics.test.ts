import { expect, it } from "vitest";
import {
  androidReleaseCommandFacts as commandFacts,
  androidReleaseErrorFacts as errorFacts,
  androidReleaseNativeFacts as nativeFacts,
} from "../../scripts/lib/android-release-e2e-diagnostics.js";

const phases = ["initial", "relaunch", "phone-restart", "long-reply", "reader"];
const phaseReady = (ready: boolean) => Object.fromEntries(phases.map((phase) => [phase, ready]));
const nativeDefaults = {
  class: "unknown",
  frames: [],
  processCrashed: false,
  instrumentationFailed: false,
  OKsingle: false,
  phaseReady: phaseReady(false),
};

it.each([
  [
    "failed to copy /private/setup-secret: Permission denied",
    { permissionDenied: true, failedToCopy: true },
  ],
  ["No such file or directory: /private/setup-secret", { missingFile: true }],
  ["device offline: private-device", { deviceOffline: true }],
  ["Connection reset by peer: private-device", { connectionReset: true }],
  ["private-device timed out", { timeout: true }],
  ["adb: error: closed", { transportClosed: true }],
  ["adb: error: failed to get feature set: closed", { transportClosed: true }],
  ["adb: device 'private-device' not found", { deviceMissing: true }],
  ["adb: no devices/emulators found", { deviceMissing: true }],
  ["failed to stat remote object '/private/setup-secret'", { remoteStatFailure: true }],
  ["remote object '/private/setup-secret' does not exist", { remoteStatFailure: true }],
  ["protocol fault: private-device returned an unexpected response", { protocolFault: true }],
  [
    "failed to copy /private/setup-secret: No space left on device",
    { failedToCopy: true, noSpace: true },
  ],
])("redacts SDK facts from either stream: %s", (output, expected) => {
  for (const isStdout of [true, false]) {
    const stdout = isStdout ? output : "private-token";
    const stderr = isStdout ? "private-token" : output;
    const facts = commandFacts(
      "/private/sdk/adb",
      ["-s", "private-device", "pull", "/private/setup-secret", "/private/output"],
      stdout,
      stderr,
    );
    expect(facts).toMatchObject({ tool: "adb", operation: "pull", ...expected });
    expect(JSON.stringify(facts)).not.toMatch(/private|secret|token/u);
  }
});

it("drops unknown tool, operation, output and phase names", () => {
  expect(
    commandFacts("/private/unknown-secret", ["secret"], "private-token", "private-secret"),
  ).toMatchObject({ tool: "other", operation: "other" });
  const facts = nativeFacts(
    "private.UnknownException: private-token\n at private.Secret(secret.kt:5)\n" +
      "OPENCLAW_ANDROID_PHASE_READY private-secret\nOPENCLAW_ANDROID_PHASE_READY initial-private-token\n",
  );
  expect(facts).toMatchObject(nativeDefaults);
  expect(JSON.stringify(facts)).not.toMatch(/private|secret|token|UnknownException/u);
});

it("publishes known managed failures without messages, causes or arbitrary codes", () => {
  const error = Object.assign(new Error("private-token"), {
    code: "ETIMEDOUT",
    cause: new Error("private-secret"),
  });
  expect(errorFacts(error)).toEqual({ class: "Error", code: "ETIMEDOUT" });
  error.name = "private-name";
  error.code = "private-code";
  expect(errorFacts(error)).toEqual({ class: "unknown", code: undefined });
  expect(errorFacts({ message: "private", code: "ETIMEDOUT" })).toEqual({
    class: "unknown",
    code: undefined,
  });
});

it.each([
  ["java.lang.AssertionError: private-token", "AssertionError"],
  ["androidx.test.uiautomator.StaleObjectException", "StaleObjectException"],
])("redacts native source locations: %s", (exception, expectedClass) => {
  const facts = nativeFacts(
    `${exception}\n at ai.openclaw.wear.AndroidReleaseWearTest.releasePhase(AndroidReleaseWearTest.kt:121)\n at private.Secret(secret.kt:5)\n at ai.openclaw.release.ReleaseValidationUi.read(ReleaseValidationUi.kt:88)`,
  );
  expect(facts).toEqual({
    ...nativeDefaults,
    class: expectedClass,
    frames: [
      { file: "AndroidReleaseWearTest.kt", line: 121 },
      { file: "ReleaseValidationUi.kt", line: 88 },
    ],
  });
  expect(JSON.stringify(facts)).not.toMatch(/private|token|Secret/u);
});

it.each([
  ["INSTRUMENTATION_RESULT: shortMsg=Process crashed.\nprivate-token", "processCrashed"],
  ["INSTRUMENTATION_FAILED: private-token", "instrumentationFailed"],
  ["OK (1 test)\nprivate-token", "OKsingle"],
])("retains native terminal facts for %s without raw results", (text, expected) => {
  const facts = nativeFacts(
    phases.map((phase) => `OPENCLAW_ANDROID_PHASE_READY ${phase}\n`).join("") + text,
  );
  expect(facts).toEqual({ ...nativeDefaults, [expected]: true, phaseReady: phaseReady(true) });
  expect(JSON.stringify(facts)).not.toMatch(
    /private|token|INSTRUMENTATION_|Process crashed|OK \(1 test\)/u,
  );
});
