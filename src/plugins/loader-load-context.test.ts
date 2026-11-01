import { afterEach, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { setGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import * as installedPluginIndexInstallRecords from "./installed-plugin-index-install-records.js";
import * as installedPluginIndexRecords from "./installed-plugin-index-records.js";
import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { restorePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

afterEach(() => {
  clearCurrentPluginMetadataSnapshot();
  vi.restoreAllMocks();
});

it("uses supplied install records without extracting the startup snapshot again", async () => {
  await using owner = createPluginCache();
  withPluginCache(owner, () => {
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ id: "alpha", origin: "global" }],
    });
    snapshot.index.installRecords = { alpha: { source: "npm", spec: "alpha@1" } };
    const prepared = restorePluginMetadataSnapshot(snapshot);
    const extract = vi.spyOn(
      installedPluginIndexInstallRecords,
      "extractPluginInstallRecordsFromInstalledPluginIndex",
    );
    const read = vi.spyOn(
      installedPluginIndexRecords,
      "loadInstalledPluginIndexInstallRecordsSync",
    );
    const suppliedLedgers: Record<string, PluginInstallRecord>[] = [
      { alpha: { source: "npm", spec: "alpha@2" } },
      {},
    ];
    for (const installRecords of suppliedLedgers) {
      const context = resolvePluginLoadCacheContext({
        metadataSnapshot: prepared,
        installRecords,
        config: { plugins: { installs: { beta: { source: "npm", spec: "beta@3" } } } },
      });
      expect(context.installRecords).toEqual({
        ...installRecords,
        beta: { source: "npm", spec: "beta@3" },
      });
      expect(context.metadataSnapshot).toBe(prepared);
    }
    expect(prepared.index.installRecords).toEqual({ alpha: { source: "npm", spec: "alpha@1" } });
    expect(read).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
  });
});

it("uses the published install ledger for projected manifests and follows its replacement", async () => {
  await using owner = createPluginCache();
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      { id: "alpha", origin: "global" },
      { id: "beta", origin: "global" },
    ],
  });
  snapshot.index.installRecords = {
    alpha: { source: "npm", spec: "alpha@1" },
    beta: { source: "npm", spec: "beta@1" },
  };
  const prepared = withPluginCache(owner, () => restorePluginMetadataSnapshot(snapshot));
  const manifestRegistry = {
    plugins: prepared.manifestRegistry.plugins.filter((plugin) => plugin.id === "alpha"),
    diagnostics: [],
  };
  const read = vi
    .spyOn(installedPluginIndexRecords, "loadInstalledPluginIndexInstallRecordsSync")
    .mockImplementation(() => {
      throw new Error("Projected manifests must use the prepared install ledger");
    });

  setGatewayPluginMetadataSnapshot(prepared);
  const first = resolvePluginLoadCacheContext({ manifestRegistry, onlyPluginIds: ["alpha"] });
  expect(first.metadataSnapshot).toBe(prepared);
  expect(first.installRecords).toEqual({
    alpha: { source: "npm", spec: "alpha@1" },
    beta: { source: "npm", spec: "beta@1" },
  });

  const replacementIndex: typeof snapshot.index = {
    ...snapshot.index,
    installRecords: { alpha: { source: "npm", spec: "alpha@2" } },
  };
  const replacement = withPluginCache(owner, () =>
    restorePluginMetadataSnapshot({
      ...snapshot,
      index: replacementIndex,
      registryIndex: replacementIndex,
    }),
  );
  setGatewayPluginMetadataSnapshot(replacement);
  const next = resolvePluginLoadCacheContext({ manifestRegistry, onlyPluginIds: ["alpha"] });
  expect(next.metadataSnapshot).toBe(replacement);
  expect(next.installRecords).toEqual({ alpha: { source: "npm", spec: "alpha@2" } });
  expect(first.installRecords.alpha?.spec).toBe("alpha@1");
  expect(read).not.toHaveBeenCalled();
});
