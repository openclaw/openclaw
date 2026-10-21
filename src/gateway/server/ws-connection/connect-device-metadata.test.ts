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
    ["runtime alias", "win32", "windows", "Windows", true],
    ["runtime alias", "darwin", "macos", "Mac", true],
    ["legacy node-host", "darwin", "macos", "Mac", false],
    ["legacy node-host", "win32", "windows", "Windows", false],
  ] as const)("accepts %s %s as %s", (_kind, legacy, canonical, family, unpinnedFamily) => {
    expectPinned(
      resolvePlatforms(
        unpinnedFamily ? canonical : legacy,
        legacy,
        family,
        unpinnedFamily ? unpinnedRuntime : {},
      ),
      canonical,
      unpinnedFamily ? undefined : family,
    );
  });

  it.each([
    { pairedPlatform: "linux", claimedDeviceFamily: "Windows" },
    { pairedPlatform: "win32", claimedDeviceFamily: "Linux" },
    { pairedPlatform: "darwin", claimedDeviceFamily: "Windows" },
  ] as const)(
    "keeps non-equivalent runtime tuples approval-bound: %j",
    ({ pairedPlatform, claimedDeviceFamily }) => {
      expect(
        resolvePlatforms("windows", pairedPlatform, claimedDeviceFamily, unpinnedRuntime),
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

  it.each([
    ["node-host", "node", "macos", "macOS 26.5.2", undefined],
    ["cli", "cli", "macos", "macOS 26.5.2", undefined],
    ["cli", "cli", "darwin", "macOS 26.5.2", undefined],
    ["cli", "probe", "macos", "macOS 26.5.2", undefined],
    ["cli", "probe", "darwin", "macOS 26.5.2", undefined],
    ["openclaw-macos", "ui", "macOS 26.5.2", "macos", "macOS 26.5.2"],
  ] as const)("shares the macOS pin with %s", (clientId, clientMode, claimed, paired, refresh) => {
    expectPinned(
      resolvePlatforms(claimed, paired, "Mac", { clientId, clientMode }),
      "macOS 26.5.2",
      "Mac",
      refresh,
    );
  });

  it.each([
    { clientId: "cli", clientMode: "backend" },
    { clientId: "openclaw-tui", clientMode: "cli" },
    { clientId: "cli", clientMode: "probe", claimedPlatform: "linux" },
  ])("keeps non-CLI Mac aliases approval-bound: %j", (overrides) => {
    expect(resolvePlatforms("macos", "macOS 26.5.2", "Mac", overrides)).toMatchObject({
      platformMismatch: true,
      deviceFamilyMismatch: false,
      pinnedPlatform: undefined,
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
