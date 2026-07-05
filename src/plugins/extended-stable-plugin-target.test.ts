import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadExtendedStablePluginTargetContextFromRoot,
  resolveExtendedStableSnapshotPackageNames,
  resolveExtendedStablePluginTarget,
  resolveExtendedStableSnapshotVersion,
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
const snapshotPackageNames = new Set(["@openclaw/matrix"]);

describe("resolveExtendedStablePluginTarget", () => {
  it("reads and validates the core identity and version from the package root", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "openclaw-target-context-"));
    mkdirSync(join(rootDir, "release"));
    writeFileSync(join(rootDir, "package.json"), '{"name":"openclaw","version":"2026.6.34"}\n');
    writeFileSync(
      join(rootDir, "release/extended-stable-plugin-support.json"),
      JSON.stringify({
        schemaVersion: 1,
        plugins: [
          {
            pluginId: "codex",
            packageName: "@openclaw/codex",
            packageDir: "extensions/codex",
            acceptanceProfile: "codex-provider-v1",
          },
          {
            pluginId: "discord",
            packageName: "@openclaw/discord",
            packageDir: "extensions/discord",
            acceptanceProfile: "discord-channel-v1",
          },
          {
            pluginId: "slack",
            packageName: "@openclaw/slack",
            packageDir: "extensions/slack",
            acceptanceProfile: "slack-channel-v1",
          },
        ],
      }),
    );
    try {
      expect(() =>
        loadExtendedStablePluginTargetContextFromRoot({
          rootDir,
          expectedCoreVersion: "2026.6.35",
        }),
      ).toThrow(/does not match expected/u);
      expect(
        loadExtendedStablePluginTargetContextFromRoot({
          rootDir,
          expectedCoreVersion: "2026.6.34",
        }),
      ).toMatchObject({
        installedCoreVersion: "2026.6.34",
        snapshotVersion: "2026.6.33",
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("derives deduplicated official npm snapshot membership minus support", () => {
    const entries = [
      { source: "official", openclaw: { install: { npmSpec: "@openclaw/slack" } } },
      { source: "official", openclaw: { install: { npmSpec: "@openclaw/matrix" } } },
      { source: "official", openclaw: { install: { npmSpec: "@openclaw/matrix@latest" } } },
      { source: "community", openclaw: { install: { npmSpec: "third-party" } } },
    ];
    expect([...resolveExtendedStableSnapshotPackageNames({ support, entries })]).toEqual([
      "@openclaw/matrix",
    ]);
  });

  it.each([
    "2026.6.32",
    "2026.06.33",
    "2026.13.33",
    "2026.6.033",
    "2026.6.33-beta.1",
    "v2026.6.33",
  ])("rejects non-extended-stable core version %s", (version) => {
    expect(() => resolveExtendedStableSnapshotVersion(version)).toThrow(
      /final YYYY\.M\.PATCH with PATCH >= 33/u,
    );
  });

  it("derives the monthly .33 snapshot from a maintenance patch", () => {
    expect(resolveExtendedStableSnapshotVersion("2026.12.104")).toBe("2026.12.33");
  });

  it("targets covered default intent to the exact installed core version", () => {
    expect(
      resolveExtendedStablePluginTarget({
        requestedSpec: "@openclaw/slack@latest",
        officialPackageName: "@openclaw/slack",
        updateChannel: "extended-stable",
        installedCoreVersion: "2026.6.34",
        support,
        snapshotPackageNames,
      }),
    ).toEqual({
      kind: "covered",
      code: "extended_stable_target",
      installSpec: "@openclaw/slack@2026.6.34",
      recordSpec: "@openclaw/slack@latest",
    });
  });

  it("targets non-covered official default intent to the monthly .33 snapshot", () => {
    expect(
      resolveExtendedStablePluginTarget({
        requestedSpec: "@openclaw/matrix",
        officialPackageName: "@openclaw/matrix",
        updateChannel: "extended-stable",
        installedCoreVersion: "2026.6.34",
        support,
        snapshotPackageNames,
      }),
    ).toMatchObject({
      kind: "snapshot",
      code: "monthly_snapshot_target",
      installSpec: "@openclaw/matrix@2026.6.33",
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
        snapshotPackageNames,
      }).kind,
    ).toBe("preserved");
    expect(
      resolveExtendedStablePluginTarget({
        requestedSpec: "@openclaw/matrix",
        officialPackageName: "@openclaw/matrix",
        updateChannel: "stable",
        support,
        snapshotPackageNames,
      }).kind,
    ).toBe("unchanged");
  });
});
