import { afterEach, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { setGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import * as installedPluginIndexInstallRecords from "./installed-plugin-index-install-records.js";
import * as installedPluginIndexRecords from "./installed-plugin-index-records.js";
import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import * as registrationConfig from "./loader-registration-config.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { restorePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import {
  readPreparedSyntheticAuthFact,
  restorePreparedSyntheticAuthFacts,
} from "./provider-synthetic-auth.js";

afterEach(() => {
  clearCurrentPluginMetadataSnapshot();
  vi.restoreAllMocks();
});

it("reuses registration facts per captured runtime/source pair and replaces them on reload", async () => {
  await using owner = createPluginCache();
  withPluginCache(owner, () => {
    const config = (value: string, enabled = true) =>
      freezeJsonSnapshot({
        plugins: { slots: { memory: "none" }, entries: { alpha: { enabled, config: { value } } } },
      });
    const runtime = config("resolved");
    const source = config("authored");
    const replacement = config("replacement", false);
    const metadataSnapshot = restorePluginMetadataSnapshot(createPluginMetadataSnapshotFixture());
    const derive = vi.spyOn(registrationConfig, "resolvePluginRegistrationConfigKey");
    const read = (activationSourceConfig: typeof source, current = runtime) =>
      resolvePluginLoadCacheContext({ config: current, activationSourceConfig, metadataSnapshot });
    const first = read(source);
    const next = read(replacement);
    expect(next.registrationConfigKey).not.toBe(first.registrationConfigKey);
    expect(read(source).cacheKey).toBe(first.cacheKey);
    expect(read(replacement).cacheKey).toBe(next.cacheKey);
    const reloaded = read(source, replacement);
    expect(reloaded.registrationConfigKey).not.toBe(first.registrationConfigKey);
    expect(read(source, replacement).cacheKey).toBe(reloaded.cacheKey);
    expect(derive).toHaveBeenCalledTimes(3);
  });
});

it.each([false, true])(
  "inherits closed capture auth only without raw env substitution (%s)",
  async (resolveRawConfigEnvVars) => {
    await using owner = createPluginCache();
    withPluginCache(owner, () => {
      const config = { messages: { ackReaction: "${CATALOG_AUTH_TEST}" } };
      const env = { NODE_ENV: "test", CATALOG_AUTH_TEST: "resolved" };
      const workspaceDir = "/workspace";
      const fact = { providerRef: "native-auth", result: null };
      restorePreparedSyntheticAuthFacts([fact], [{ config, env, workspaceDir }]);
      const context = resolvePluginLoadCacheContext({
        config,
        env,
        workspaceDir,
        resolveRawConfigEnvVars,
        metadataSnapshot: restorePluginMetadataSnapshot(createPluginMetadataSnapshotFixture()),
      });
      expect(context.cfg.messages?.ackReaction).toBe(
        resolveRawConfigEnvVars ? "resolved" : "${CATALOG_AUTH_TEST}",
      );
      expect(
        readPreparedSyntheticAuthFact(
          { config: context.cfg, provider: "native-auth" },
          { env: context.env, workspaceDir },
        ),
      ).toEqual(resolveRawConfigEnvVars ? undefined : fact);
    });
  },
);

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
