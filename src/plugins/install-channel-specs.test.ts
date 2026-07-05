import { describe, expect, it } from "vitest";
import { resolveNpmInstallSpecsForUpdateChannel } from "./install-channel-specs.js";

const extendedStableTargetContext = {
  installedCoreVersion: "2026.6.34",
  snapshotVersion: "2026.6.33",
  support: {
    schemaVersion: 1 as const,
    plugins: [
      {
        pluginId: "slack",
        packageName: "@openclaw/slack",
        packageDir: "extensions/slack",
        acceptanceProfile: "slack-channel-v1",
      },
    ],
  },
  snapshotPackageNames: new Set(["@openclaw/matrix"]),
};

describe("extended-stable npm install specs", () => {
  it("targets covered and snapshot packages while retaining default intent", () => {
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@openclaw/slack@latest",
        updateChannel: "extended-stable",
        officialPackageName: "@openclaw/slack",
        extendedStableTargetContext,
      }),
    ).toEqual({
      installSpec: "@openclaw/slack@2026.6.34",
      recordSpec: "@openclaw/slack@latest",
      targetCode: "extended_stable_target",
    });
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@openclaw/matrix",
        updateChannel: "extended-stable",
        officialPackageName: "@openclaw/matrix",
        extendedStableTargetContext,
      }),
    ).toEqual({
      installSpec: "@openclaw/matrix@2026.6.33",
      recordSpec: "@openclaw/matrix",
      targetCode: "monthly_snapshot_target",
    });
  });

  it("preserves exact pins and leaves stable behavior unchanged", () => {
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@openclaw/matrix@2026.6.20",
        updateChannel: "extended-stable",
        officialPackageName: "@openclaw/matrix",
        extendedStableTargetContext,
      }),
    ).toEqual({
      installSpec: "@openclaw/matrix@2026.6.20",
      recordSpec: "@openclaw/matrix@2026.6.20",
      targetCode: "user_pin_preserved",
    });
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@openclaw/matrix",
        updateChannel: "stable",
        officialPackageName: "@openclaw/matrix",
        extendedStableTargetContext,
      }),
    ).toEqual({ installSpec: "@openclaw/matrix", recordSpec: "@openclaw/matrix" });
  });

  it("fails closed when an official extended-stable target has no packaged metadata", () => {
    expect(() =>
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@openclaw/slack@latest",
        updateChannel: "extended-stable",
        officialPackageName: "@openclaw/slack",
      }),
    ).toThrow(/requires packaged metadata/u);
  });
});
