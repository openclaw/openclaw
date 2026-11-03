import { describe, expect, it } from "vitest";
import { resolvePinnedClientMetadata } from "./connect-device-metadata.js";

const unpinnedRuntime = { clientId: "test", clientMode: "test", pairedDeviceFamily: undefined };

function resolvePlatforms(
  claimedPlatform: string,
  pairedPlatform: string,
  deviceFamily: string,
  overrides: Parameters<typeof resolvePinnedClientMetadata>[0] = {},
) {
  return resolvePinnedClientMetadata({
    clientId: "node-host",
    clientMode: "node",
    claimedPlatform,
    pairedPlatform,
    claimedDeviceFamily: deviceFamily,
    pairedDeviceFamily: deviceFamily,
    ...overrides,
  });
}

describe("resolvePinnedClientMetadata", () => {
  it.each([
    ["windows", "win32", "Windows", unpinnedRuntime, "windows", false],
    ["macos", "darwin", "Mac", unpinnedRuntime, "macos", false],
    ["darwin", "darwin", "Mac", {}, "macos", false],
    ["win32", "win32", "Windows", {}, "windows", false],
    ["iOS 26.5.0", "iOS 26.4.2", "iPhone", { clientId: "openclaw-ios" }, "iOS 26.5.0", true],
    ["iPadOS 26.5.0", "iOS 26.4.2", "iPad", { clientId: "openclaw-ios" }, "iPadOS 26.5.0", true],
    ["Android 16", "Android 15", "Android", { clientId: "openclaw-android" }, "Android 16", true],
    ["macos", "macOS 26.5.2", "Mac", {}, "macOS 26.5.2", false],
    [
      "macOS 26.5.2",
      "macos",
      "Mac",
      { clientId: "openclaw-macos", clientMode: "ui" },
      "macOS 26.5.2",
      true,
    ],
  ] as const)("accepts %s / %s (%j, %j)", (claimed, paired, family, overrides, pinned, refresh) => {
    expect(resolvePlatforms(claimed, paired, family, overrides)).toEqual({
      platformMismatch: false,
      deviceFamilyMismatch: false,
      pinnedPlatform: pinned,
      pinnedDeviceFamily: "pairedDeviceFamily" in overrides ? overrides.pairedDeviceFamily : family,
      ...(refresh ? { refreshPairedPlatform: claimed } : {}),
    });
  });

  it.each([undefined, "Windows"])("keeps the CLI device-family pin for %s", (family) => {
    expect(
      resolvePlatforms("macos", "macOS 26.5.2", "Mac", {
        clientId: "cli",
        clientMode: "probe",
        claimedDeviceFamily: family,
      }),
    ).toMatchObject({
      deviceFamilyMismatch: true,
      pinnedDeviceFamily: "Mac",
    });
  });

  it("still requires approval when an iOS device family changes", () => {
    expect(
      resolvePlatforms("iOS 26.5.0", "iOS 26.4.2", "iPad", {
        clientId: "openclaw-ios",
        pairedDeviceFamily: "iPhone",
      }),
    ).toEqual({
      platformMismatch: false,
      deviceFamilyMismatch: true,
      pinnedPlatform: "iOS 26.5.0",
      pinnedDeviceFamily: "iPhone",
      refreshPairedPlatform: "iOS 26.5.0",
    });
  });

  it.each([
    ["windows", "linux", "Windows", unpinnedRuntime, false],
    ["windows", "win32", "Linux", unpinnedRuntime, false],
    [
      "windows",
      "win32",
      "Windows",
      { clientId: "openclaw-tui", clientMode: "ui", pairedDeviceFamily: "Linux" },
      true,
    ],
    ["macos", "macOS 26.5.2", "Mac", { clientId: "cli", clientMode: "backend" }, false],
    ["macos", "macOS 26.5.2", "Mac", { clientId: "openclaw-tui", clientMode: "cli" }, false],
    ["linux", "macOS 26.5.2", "Mac", { clientId: "cli", clientMode: "probe" }, false],
    ["macOS 26.5.2", "macOS 26.5.1", "Mac", { clientId: "node-host" }, false],
    ["macOS anything", "macOS previous", "Mac", { clientId: "openclaw-macos" }, false],
  ] as const)(
    "keeps %s / %s approval-bound (%j, %j)",
    (claimed, paired, family, overrides, deviceFamilyMismatch) => {
      expect(resolvePlatforms(claimed, paired, family, overrides)).toMatchObject({
        platformMismatch: true,
        deviceFamilyMismatch,
        pinnedPlatform: undefined,
        pinnedDeviceFamily:
          "pairedDeviceFamily" in overrides ? overrides.pairedDeviceFamily : family,
      });
    },
  );
});
