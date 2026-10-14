import { describe, expect, it } from "vitest";
import {
  androidReleaseCommandFacts,
  androidReleaseErrorFacts,
  androidReleaseNativeFacts,
} from "../../scripts/lib/android-release-e2e-diagnostics.js";

describe("Android release public failure diagnostics", () => {
  it("identifies the failing SDK operation while excluding private arguments and stderr", () => {
    const facts = androidReleaseCommandFacts(
      "/private/sdk/adb",
      ["-s", "private-device", "pull", "/private/setup-secret", "/private/output"],
      "failed to copy /private/setup-secret: Permission denied; private-token",
    );
    expect(facts).toMatchObject({
      tool: "adb",
      operation: "pull",
      permissionDenied: true,
      failedToCopy: true,
    });
    expect(JSON.stringify(facts)).not.toMatch(/private|secret|token/u);
    expect(
      androidReleaseCommandFacts("/private/unknown-secret", ["secret"], "secret"),
    ).toMatchObject({ tool: "other", operation: "other" });
  });

  it("publishes known managed failures without messages, causes or arbitrary codes", () => {
    const error = Object.assign(new Error("private-token"), {
      code: "ETIMEDOUT",
      cause: new Error("private-secret"),
    });
    expect(androidReleaseErrorFacts(error)).toEqual({ class: "Error", code: "ETIMEDOUT" });
    error.name = "private-name";
    error.code = "private-code";
    expect(androidReleaseErrorFacts(error)).toEqual({ class: "unknown", code: undefined });
    expect(androidReleaseErrorFacts({ message: "private", code: "ETIMEDOUT" })).toEqual({
      class: "unknown",
      code: undefined,
    });
  });

  it.each([
    ["java.lang.AssertionError: private-token", "AssertionError"],
    ["androidx.test.uiautomator.StaleObjectException", "StaleObjectException"],
  ])("retains native source locations for %s without private text", (exception, expectedClass) => {
    const facts = androidReleaseNativeFacts(
      `${exception}\n at ai.openclaw.wear.AndroidReleaseWearTest.releasePhase(AndroidReleaseWearTest.kt:121)\n at private.Secret(secret.kt:5)\n at ai.openclaw.release.ReleaseValidationUi.read(ReleaseValidationUi.kt:88)`,
    );
    expect(facts).toEqual({
      class: expectedClass,
      frames: [
        { file: "AndroidReleaseWearTest.kt", line: 121 },
        { file: "ReleaseValidationUi.kt", line: 88 },
      ],
    });
    expect(JSON.stringify(facts)).not.toMatch(/private|token|Secret/u);
  });
});
