import fs from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as bundledDiscoveryState from "./bundled-discovery-state.js";
import { hostedFeedDiffsEntry } from "./management-service.test-helpers.js";
import {
  clearPluginMetadataLifecycleCaches,
  registerPluginMetadataProcessMemoLifecycleClear,
} from "./plugin-metadata-lifecycle.js";

vi.mock("./install.js", () => {
  throw new Error("Plugin inventory must not load source installers");
});

const mocks = vi.hoisted(() => ({
  currentMetadata: undefined as unknown,
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
  preparePackage: vi.fn(),
}));

vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
  resolvePluginMetadataSnapshot: (...args: unknown[]) => {
    if (mocks.currentMetadata !== undefined) {
      return mocks.currentMetadata;
    }
    const loaded = mocks.metadata(...args);
    mocks.currentMetadata = loaded;
    return loaded;
  },
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./official-external-plugin-catalog.js")>();
  return {
    ...actual,
    loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
      mocks.officialCatalog(...args),
    resolveOfficialExternalPluginInstall: (
      ...args: Parameters<typeof actual.resolveOfficialExternalPluginInstall>
    ) => {
      mocks.preparePackage(...args);
      return actual.resolveOfficialExternalPluginInstall(...args);
    },
  };
});

const { metadata, officialCatalog, preparePackage } = mocks;
const { listManagedPlugins } = await import("./management-service.js");
const emptyCatalog = { source: "hosted" as const, entries: [] };
const list = (config: OpenClawConfig = {}, env = {}) => listManagedPlugins({ config, env });

registerPluginMetadataProcessMemoLifecycleClear(() => {
  mocks.currentMetadata = undefined;
});

function metadataSnapshot(pluginId?: string) {
  return {
    index: {
      plugins: pluginId
        ? [{ pluginId, packageName: `community/${pluginId}`, origin: "global", enabled: true }]
        : [],
      installRecords: {},
    },
    byPluginId: new Map(),
    plugins: [],
    diagnostics: [],
    normalizePluginId: (rawPluginId: string) => rawPluginId,
  };
}

function pluginMetadata(
  pluginId: string,
  options: {
    origin?: "global" | "bundled";
    enabledByDefault?: boolean;
    providers?: string[];
    channels?: string[];
    packageBuild?: { bundledDist?: boolean };
    dependencies?: Record<string, string>;
  } = {},
) {
  const snapshot = metadataSnapshot(pluginId);
  const rootDir = `/__openclaw_plugin_dependency_health__/${pluginId}`;
  const shared = {
    rootDir,
    origin: options.origin ?? "global",
    ...(options.enabledByDefault ? { enabledByDefault: true } : {}),
  };
  const record = {
    ...snapshot.index.plugins[0]!,
    ...shared,
    contributions: { providers: options.providers, channels: options.channels },
    ...(options.packageBuild ? { packageBuild: options.packageBuild } : {}),
  };
  const manifest = {
    ...shared,
    id: pluginId,
    name: pluginId,
    channels: options.channels ?? [],
    providers: options.providers ?? [],
    cliBackends: [],
    skills: [],
    source: `${rootDir}/index.js`,
    packageDependencies: options.dependencies ?? {},
  };
  return {
    ...snapshot,
    index: { ...snapshot.index, plugins: [record] },
    byPluginId: new Map([[pluginId, manifest]]),
    plugins: [manifest],
  };
}

beforeEach(() => {
  metadata.mockReset().mockReturnValue(metadataSnapshot());
  officialCatalog.mockReset().mockResolvedValue(emptyCatalog);
  preparePackage.mockClear();
  clearPluginMetadataLifecycleCaches();
});

it("serves the first plugins.list load from prewarmed metadata and official catalog caches", async () => {
  metadata
    .mockReturnValueOnce(metadataSnapshot())
    .mockReturnValueOnce(metadataSnapshot("fresh-plugin"));
  officialCatalog.mockResolvedValueOnce({
    source: "hosted",
    entries: [hostedFeedDiffsEntry],
  });

  const prewarmed = await list();
  const coldPreparations = preparePackage.mock.calls.length;
  preparePackage.mockClear();
  const firstHandlerLoad = await list();

  expect(prewarmed.plugins).toEqual([expect.objectContaining({ id: "diffs" })]);
  expect(firstHandlerLoad.plugins).toEqual(prewarmed.plugins);
  expect(metadata).toHaveBeenCalledTimes(1);
  expect(officialCatalog).toHaveBeenCalledTimes(1);
  expect(preparePackage.mock.calls.length).toBeLessThan(coldPreparations);

  firstHandlerLoad.plugins.length = 0;
  const secondHandlerLoad = await list();
  expect(secondHandlerLoad.plugins).toEqual(prewarmed.plugins);

  clearPluginMetadataLifecycleCaches();

  const refreshed = await list();

  expect(metadata).toHaveBeenCalledTimes(2);
  expect(officialCatalog).toHaveBeenCalledTimes(2);
  expect(refreshed.plugins).toEqual([
    expect.objectContaining({ id: "fresh-plugin", installed: true, enabled: true }),
  ]);
});

it("retries a failed official catalog prewarm and keeps the recovered catalog process-stable", async () => {
  officialCatalog.mockRejectedValueOnce(new Error("transient catalog bootstrap"));

  await expect(list()).rejects.toThrow("transient catalog bootstrap");
  await expect(list()).resolves.toMatchObject({ plugins: [] });
  await expect(list()).resolves.toMatchObject({ plugins: [] });
  expect(officialCatalog).toHaveBeenCalledTimes(2);
});

it("uses current config after awaiting the hosted catalog", async () => {
  const config = { plugins: { entries: { "phase-plugin": { enabled: true } } } };
  const hosted = createDeferred<typeof emptyCatalog>();
  metadata.mockReturnValue(pluginMetadata("phase-plugin"));
  officialCatalog.mockReturnValue(hosted.promise);

  const pending = list(config);
  config.plugins.entries["phase-plugin"].enabled = false;
  hosted.resolve(emptyCatalog);
  const catalog = await pending;

  expect(catalog.plugins[0]).toMatchObject({
    id: "phase-plugin",
    enabled: false,
    state: "disabled",
  });
  expect(catalog.diagnostics).toEqual([]);
});

it.each(["compat", "allowlist"] as const)(
  "uses selected %s discovery policy for enablement and diagnostics",
  async (selectedMode) => {
    const providerEnabled = selectedMode === "compat";
    const env = { OPENCLAW_STATE_DIR: "/__openclaw_management_selected_root__" };
    const readMode = vi
      .spyOn(bundledDiscoveryState, "readBundledDiscoveryModeMemoized")
      .mockImplementation((selectedEnv) =>
        selectedEnv?.OPENCLAW_STATE_DIR === env.OPENCLAW_STATE_DIR ? selectedMode : "compat",
      );
    try {
      const provider = pluginMetadata("bundled-provider", {
        origin: "bundled",
        enabledByDefault: true,
        providers: ["fixture-provider"],
        channels: ["fixture-chat"],
        ...(!providerEnabled
          ? { packageBuild: { bundledDist: false }, dependencies: { "missing-runtime": "1.0.0" } }
          : {}),
      });
      const ordinary = pluginMetadata("bundled-ordinary", {
        origin: "bundled",
        enabledByDefault: true,
      });
      metadata.mockReturnValue({
        ...provider,
        index: {
          ...provider.index,
          plugins: [...provider.index.plugins, ...ordinary.index.plugins],
        },
        byPluginId: new Map([...provider.byPluginId, ...ordinary.byPluginId]),
        plugins: [...provider.plugins, ...ordinary.plugins],
      });
      const catalog = await list({ plugins: { allow: ["listed"] } }, env);

      const providerEntry = catalog.plugins.find((plugin) => plugin.id === "bundled-provider");
      expect(providerEntry).toMatchObject({
        enabled: providerEnabled,
        state: providerEnabled ? "enabled" : "disabled",
      });
      expect(providerEntry).not.toHaveProperty("error");
      const ordinaryEntry = catalog.plugins.find((plugin) => plugin.id === "bundled-ordinary");
      expect(ordinaryEntry).toMatchObject({ enabled: false, state: "disabled" });
      expect(catalog.diagnostics).toEqual([]);
    } finally {
      readMode.mockRestore();
    }
  },
);

it("keeps a refreshed catalog when an older lifecycle generation rejects later", async () => {
  const retiredCatalog = createDeferred<typeof emptyCatalog>();
  officialCatalog.mockReturnValueOnce(retiredCatalog.promise);

  const retiredLoad = list();
  const retiredFailure = expect(retiredLoad).rejects.toThrow("retired catalog bootstrap");
  await Promise.resolve();
  expect(officialCatalog).toHaveBeenCalledTimes(1);

  clearPluginMetadataLifecycleCaches();

  await expect(list()).resolves.toMatchObject({ plugins: [] });
  retiredCatalog.reject(new Error("retired catalog bootstrap"));
  await retiredFailure;

  await expect(list()).resolves.toMatchObject({ plugins: [] });
  expect(officialCatalog).toHaveBeenCalledTimes(2);
});

it("checks dependency health once per immutable metadata lifecycle", async () => {
  metadata.mockImplementation(() =>
    pluginMetadata("lifecycle-missing-runtime", {
      origin: "global",
      enabledByDefault: true,
      dependencies: { "missing-runtime": "1.0.0" },
    }),
  );
  const existsSync = vi.spyOn(fs, "existsSync");
  const dependencyProbeCount = () =>
    existsSync.mock.calls.filter(([candidate]) =>
      String(candidate).includes("node_modules/missing-runtime"),
    ).length;

  const first = await list();
  expect(first.plugins[0]?.state).toBe("error");
  const initialProbes = dependencyProbeCount();
  expect(initialProbes).toBeGreaterThan(0);

  for (const enabled of [false, true]) {
    const catalog = await list({
      plugins: { entries: { "lifecycle-missing-runtime": { enabled } } },
    });
    expect(catalog.plugins[0]).toMatchObject({ enabled, state: enabled ? "error" : "disabled" });
    expect(catalog.diagnostics).toHaveLength(enabled ? 1 : 0);
    expect(dependencyProbeCount()).toBe(initialProbes);
  }

  await list();
  expect(dependencyProbeCount()).toBe(initialProbes);

  clearPluginMetadataLifecycleCaches();
  await list();
  expect(dependencyProbeCount()).toBeGreaterThan(initialProbes);
  existsSync.mockRestore();
});
