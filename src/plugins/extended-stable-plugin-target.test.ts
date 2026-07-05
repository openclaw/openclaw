import { describe, expect, it } from "vitest";
import {
  resolveExtendedStableCohortPackageNames,
  resolveExtendedStablePluginTarget,
} from "./extended-stable-plugin-target.js";

const support = {
  schemaVersion: 1 as const,
  plugins: [
    {
      pluginId: "slack",
      packageName: "@openclaw/slack",
      packageDir: "extensions/slack",
      acceptanceProfile: "slack-channel-v1",
    },
  ],
};
const cohort = { schemaVersion: 1 as const, releaseLine: "2026.6", baselineVersion: "2026.6.21" };
const cohortPackageNames = new Set(["@openclaw/matrix"]);

describe("resolveExtendedStablePluginTarget", () => {
  it("derives deduplicated official npm cohort membership minus support", () => {
    const entries = [
      { source: "official", openclaw: { install: { npmSpec: "@openclaw/slack" } } },
      { source: "official", openclaw: { install: { npmSpec: "@openclaw/matrix" } } },
      { source: "official", openclaw: { install: { npmSpec: "@openclaw/matrix@latest" } } },
      { source: "community", openclaw: { install: { npmSpec: "third-party" } } },
    ];
    expect([...resolveExtendedStableCohortPackageNames({ support, entries })]).toEqual([
      "@openclaw/matrix",
    ]);
  });

  it("targets covered default intent to the exact installed core version", () => {
    expect(
      resolveExtendedStablePluginTarget({
        requestedSpec: "@openclaw/slack@latest",
        officialPackageName: "@openclaw/slack",
        updateChannel: "extended-stable",
        installedCoreVersion: "2026.6.34",
        support,
        cohort,
        cohortPackageNames,
      }),
    ).toEqual({
      kind: "covered",
      code: "extended_stable_target",
      installSpec: "@openclaw/slack@2026.6.34",
      recordSpec: "@openclaw/slack@latest",
    });
  });

  it("targets non-covered official default intent to the monthly baseline", () => {
    expect(
      resolveExtendedStablePluginTarget({
        requestedSpec: "@openclaw/matrix",
        officialPackageName: "@openclaw/matrix",
        updateChannel: "extended-stable",
        installedCoreVersion: "2026.6.34",
        support,
        cohort,
        cohortPackageNames,
      }),
    ).toMatchObject({
      kind: "cohort",
      code: "monthly_cohort_target",
      installSpec: "@openclaw/matrix@2026.6.21",
      recordSpec: "@openclaw/matrix",
    });
  });

  it("preserves exact pins and leaves other channels unchanged", () => {
    expect(
      resolveExtendedStablePluginTarget({
        requestedSpec: "@openclaw/matrix@2026.6.20",
        officialPackageName: "@openclaw/matrix",
        updateChannel: "extended-stable",
        support,
        cohort,
        cohortPackageNames,
      }).kind,
    ).toBe("preserved");
    expect(
      resolveExtendedStablePluginTarget({
        requestedSpec: "@openclaw/matrix",
        officialPackageName: "@openclaw/matrix",
        updateChannel: "stable",
        support,
        cohort,
        cohortPackageNames,
      }).kind,
    ).toBe("unchanged");
  });
});
