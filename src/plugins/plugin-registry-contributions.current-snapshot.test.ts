// Verifies current plugin registry contribution snapshots.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import {
  makeEmptyPluginMetadataOwners,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import * as installedIndex from "./installed-plugin-index.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import {
  loadPluginManifestRegistryForPluginRegistry,
  listPluginContributionIds,
  resolveManifestContractOwnerPluginId,
  resolveManifestContractPluginIds,
  resolvePluginContributionOwners,
} from "./plugin-registry-contributions.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
});

function createSnapshot(params: {
  config: OpenClawConfig;
  workspaceDir: string;
}): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash(params.config);
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: ["enabled", "disabled"].map((id) => ({
      id,
      origin: "global",
      rootDir: `/plugins/${id}`,
      channelConfigs: {},
      contracts: { webSearchProviders: [`${id}-search`] },
    })),
  });
  snapshot.index.policyHash = policyHash;
  for (const plugin of snapshot.index.plugins) {
    plugin.enabled = plugin.pluginId === "enabled";
    delete plugin.enabledByDefault;
  }
  return {
    ...snapshot,
    policyHash,
    workspaceDir: params.workspaceDir,
    configFingerprint: "",
    normalizePluginId: (pluginId: string) => pluginId,
    owners: makeEmptyPluginMetadataOwners(),
  };
}

function publishSnapshot(config: OpenClawConfig = {}) {
  const params = {
    config,
    env: { HOME: "/tmp/openclaw-test-home", OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    workspaceDir: "/workspace",
  };
  const snapshot = createSnapshot(params);
  setCurrentPluginMetadataSnapshot(snapshot, params);
  return { ...params, snapshot };
}

function manifestIds(params: Parameters<typeof loadPluginManifestRegistryForPluginRegistry>[0]) {
  return loadPluginManifestRegistryForPluginRegistry(params).plugins.map((plugin) => plugin.id);
}

describe("loadPluginManifestRegistryForPluginRegistry current snapshot", () => {
  it("reuses unpublished metadata until explicit discovery or lifecycle invalidation", () => {
    const root = tempDirs.make("openclaw-registry-metadata-reuse-");
    const pluginRoot = path.join(root, "plugin");
    fs.mkdirSync(pluginRoot);
    const fixture = createColdPluginFixture({ rootDir: pluginRoot, pluginId: "reuse-fixture" });
    const config: OpenClawConfig = {
      plugins: {
        allow: [fixture.pluginId],
        load: { paths: [pluginRoot] },
        entries: { [fixture.pluginId]: { enabled: true } },
      },
    };
    const env = {
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const params = { config, env };
    expect(loadPluginMetadataSnapshot(params).plugins.map((plugin) => plugin.id)).toEqual([
      fixture.pluginId,
    ]);
    const derive = vi.spyOn(installedIndex, "loadInstalledPluginIndexWithDiscovery");

    expect(
      loadPluginManifestRegistryForPluginRegistry(params).plugins.map((plugin) => plugin.id),
    ).toEqual([fixture.pluginId]);
    expect(listPluginContributionIds({ ...params, contribution: "channels" })).toEqual([
      fixture.channelId,
    ]);
    expect(
      resolvePluginContributionOwners({
        ...params,
        contribution: "channels",
        matches: fixture.channelId,
      }),
    ).toEqual([fixture.pluginId]);
    expect(derive).not.toHaveBeenCalled();
    expect(getCurrentPluginMetadataSnapshot(params)).toBeUndefined();

    expect(
      loadPluginManifestRegistryForPluginRegistry({
        ...params,
        preferPersisted: false,
        candidates: [],
      }).plugins,
    ).toEqual([]);
    expect(derive).toHaveBeenCalledOnce();

    clearPluginMetadataLifecycleCaches();
    expect(
      loadPluginManifestRegistryForPluginRegistry(params).plugins.map((plugin) => plugin.id),
    ).toEqual([fixture.pluginId]);
    expect(listPluginContributionIds({ ...params, contribution: "channels" })).toEqual([
      fixture.channelId,
    ]);
    expect(derive).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(fixture.runtimeMarker)).toBe(false);
  });

  it("reuses an allowlisted published snapshot for configless manifest reads", () => {
    const { env, snapshot } = publishSnapshot({ plugins: { allow: ["enabled"] } });
    const readDirectory = vi.spyOn(fs, "readdirSync");
    const readFile = vi.spyOn(fs, "readFileSync");

    expect(loadManifestMetadataSnapshot({ env })).toBe(snapshot);
    expect(readDirectory).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("projects supplied contract manifests without dropping disabled owners", () => {
    const { snapshot, ...params } = publishSnapshot({ plugins: { allow: ["enabled"] } });
    const readDirectory = vi.spyOn(fs, "readdirSync");
    const readFile = vi.spyOn(fs, "readFileSync");

    expect(resolveManifestContractPluginIds({ contract: "webSearchProviders", ...params })).toEqual(
      ["disabled", "enabled"],
    );
    expect(
      resolveManifestContractOwnerPluginId({
        contract: "webSearchProviders",
        value: " DISABLED-SEARCH ",
        ...params,
      }),
    ).toBe("disabled");
    expect(
      resolveManifestContractPluginIds({
        contract: "webSearchProviders",
        config: { plugins: { allow: ["incompatible-policy"] } },
        env: params.env,
        manifestRecords: snapshot.plugins,
        onlyPluginIds: ["disabled"],
      }),
    ).toEqual(["disabled"]);
    expect(
      resolveManifestContractOwnerPluginId({
        contract: "webSearchProviders",
        value: "disabled-search",
        config: { plugins: { allow: ["incompatible-policy"] } },
        env: params.env,
        manifestRecords: snapshot.plugins,
      }),
    ).toBe("disabled");
    expect(readDirectory).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("reuses compatible current manifest metadata", () => {
    const { config, env, workspaceDir } = publishSnapshot();
    const params = { config, env, workspaceDir };
    expect(manifestIds(params)).toEqual(["enabled"]);
    expect(manifestIds({ ...params, includeDisabled: true })).toEqual(["enabled", "disabled"]);
    expect(manifestIds({ ...params, includeDisabled: true, pluginIds: [] })).toEqual([]);
    expect(manifestIds({ ...params, includeDisabled: true, pluginIds: ["disabled"] })).toEqual([
      "disabled",
    ]);
    expect(loadPluginManifestRegistryForPluginRegistry({ config, env }).plugins).toEqual([]);
  });
});
