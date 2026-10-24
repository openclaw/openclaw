import { afterEach, expect, it, vi } from "vitest";
import { setGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import * as installedPluginIndexRecords from "./installed-plugin-index-records.js";
import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { restorePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

afterEach(() => {
  clearCurrentPluginMetadataSnapshot();
  vi.restoreAllMocks();
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
