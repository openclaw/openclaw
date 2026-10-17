import { describe, expect, it } from "vitest";
import { resolvePinnedClientMetadata } from "./connect-device-metadata.js";

type Metadata = Parameters<typeof resolvePinnedClientMetadata>[0];
function resolvePlatforms(
  claimedPlatform: string,
  pairedPlatform: string,
  deviceFamily: string,
  overrides: Metadata = {},
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

function expectPinned(
  result: ReturnType<typeof resolvePinnedClientMetadata>,
  pinnedPlatform: string,
  pinnedDeviceFamily: string | undefined,
  refreshPairedPlatform?: string,
) {
  expect(result).toEqual({
    platformMismatch: false,
    deviceFamilyMismatch: false,
    pinnedPlatform,
    pinnedDeviceFamily,
    ...(refreshPairedPlatform ? { refreshPairedPlatform } : {}),
  });
}

describe("resolvePinnedClientMetadata", () => {
  it.each([
    ["win32", "windows", "Windows"],
    ["darwin", "macos", "Mac"],
  ])(
    "accepts equivalent runtime alias %s as %s regardless of client mode",
    (pairedPlatform, claimedPlatform, claimedDeviceFamily) => {
      expectPinned(
        resolvePlatforms(claimedPlatform, pairedPlatform, claimedDeviceFamily, {
          clientId: "test",
          clientMode: "test",
          pairedDeviceFamily: undefined,
        }),
        claimedPlatform,
        undefined,
      );
    },
  );

  it.each([
    { pairedPlatform: "linux", claimedDeviceFamily: "Windows" },
    { pairedPlatform: "win32", claimedDeviceFamily: "Linux" },
    { pairedPlatform: "darwin", claimedDeviceFamily: "Windows" },
  ])(
    "keeps non-equivalent runtime tuples approval-bound: %j",
    ({ pairedPlatform, claimedDeviceFamily }) => {
      expect(
        resolvePlatforms("windows", pairedPlatform, claimedDeviceFamily, {
          clientId: "test",
          clientMode: "test",
          pairedDeviceFamily: undefined,
        }),
      ).toMatchObject({
        platformMismatch: true,
        deviceFamilyMismatch: false,
      });
    },
  );

  it("does not replace a conflicting family pin during a runtime-alias upgrade", () => {
    expect(
      resolvePlatforms("windows", "win32", "Windows", {
        clientId: "openclaw-tui",
        clientMode: "ui",
        pairedDeviceFamily: "Linux",
      }),
    ).toMatchObject({
      platformMismatch: true,
      deviceFamilyMismatch: true,
      pinnedDeviceFamily: "Linux",
    });
  });

  it.each([
    ["darwin", "macos", "Mac"],
    ["win32", "windows", "Windows"],
  ])(
    "normalizes exact legacy node-host platform %s to canonical %s",
    (legacyPlatform, canonicalPlatform, deviceFamily) => {
      expectPinned(
        resolvePlatforms(legacyPlatform, legacyPlatform, deviceFamily),
        canonicalPlatform,
        deviceFamily,
      );
    },
  );

  it.each([
    ["openclaw-ios", "iOS 26.5.0", "iOS 26.4.2", "iPhone"],
    ["openclaw-ios", "iPadOS 26.5.0", "iPadOS 26.4.2", "iPad"],
    ["openclaw-ios", "iPadOS 26.5.0", "iOS 26.4.2", "iPad"],
    ["openclaw-android", "Android 16", "Android 15", "Android"],
    ["openclaw-macos", "macOS 26.5.1", "macOS 26.5.0", "Mac"],
  ])(
    "allows %s platform version refresh without metadata-upgrade approval",
    (clientId, claimedPlatform, pairedPlatform, deviceFamily) => {
      expectPinned(
        resolvePlatforms(claimedPlatform, pairedPlatform, deviceFamily, { clientId }),
        claimedPlatform,
        deviceFamily,
        claimedPlatform,
      );
    },
  );

  it("accepts a node-host macOS alias against the shared Mac app platform pin", () => {
    expectPinned(resolvePlatforms("macos", "macOS 26.5.2", "Mac"), "macOS 26.5.2", "Mac");
  });

  it("refreshes a shared node-host macOS pin from the native Mac app", () => {
    expectPinned(
      resolvePlatforms("macOS 26.5.2", "macos", "Mac", {
        clientId: "openclaw-macos",
        clientMode: "ui",
      }),
      "macOS 26.5.2",
      "Mac",
      "macOS 26.5.2",
    );
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
    ["node-host", "macOS 26.5.2", "macOS 26.5.1"],
    ["openclaw-macos", "macOS anything", "macOS previous"],
    ["openclaw-macos", "macOS", "macOS 26.5.1"],
  ])(
    "keeps non-version macOS platform changes approval-bound for %s",
    (clientId, claimed, paired) => {
      expect(resolvePlatforms(claimed, paired, "Mac", { clientId })).toMatchObject({
        platformMismatch: true,
        deviceFamilyMismatch: false,
        pinnedPlatform: undefined,
      });
    },
  );
});
