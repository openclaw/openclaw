import fs from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as bundledDiscoveryState from "./bundled-discovery-state.js";
import { emptyMetadataSnapshot, hostedFeedDiffsEntry } from "./management-service.test-helpers.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import {
  clearPluginMetadataLifecycleCaches,
  registerPluginMetadataProcessMemoLifecycleClear,
} from "./plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

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
  loadPluginMetadataSnapshot: mocks.metadata,
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
    loadConfiguredHostedOfficialExternalPluginCatalogEntries: mocks.officialCatalog,
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

type MetadataPlugin = Partial<PluginManifestRecord> &
  Pick<PluginManifestRecord, "id"> & { packageBuild?: { bundledDist?: boolean } };
function pluginMetadata(...plugins: MetadataPlugin[]) {
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: plugins.map(({ packageBuild: _packageBuild, ...plugin }) => ({
      name: plugin.id,
      origin: "global",
      rootDir: `/__openclaw_plugin_dependency_health__/${plugin.id}`,
      ...plugin,
    })),
  });
  snapshot.index.plugins.forEach((record, index) => {
    const plugin = plugins[index]!;
    Object.assign(record, {
      packageName: `community/${plugin.id}`,
      enabledByDefault: plugin.enabledByDefault,
      contributions: { providers: plugin.providers, channels: plugin.channels },
      ...(plugin.packageBuild ? { packageBuild: plugin.packageBuild } : {}),
    });
  });
  return snapshot;
}

beforeEach(() => {
  metadata.mockReset().mockReturnValue(emptyMetadataSnapshot());
  officialCatalog.mockReset().mockResolvedValue(emptyCatalog);
  preparePackage.mockClear();
  clearPluginMetadataLifecycleCaches();
});

it("serves the first plugins.list load from prewarmed metadata and official catalog caches", async () => {
  metadata
    .mockReturnValueOnce(emptyMetadataSnapshot())
    .mockReturnValueOnce(pluginMetadata({ id: "fresh-plugin" }));
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

it("serves installed rows while catalog enrichment is pending, then reuses the prepared facts", async () => {
  const hosted = createDeferred<typeof emptyCatalog>();
  metadata.mockReturnValue(pluginMetadata({ id: "phase-plugin" }));
  officialCatalog.mockReturnValue(hosted.promise);
  const config = { plugins: { entries: { "phase-plugin": { enabled: true } } } };
  const params = { config, env: {}, cachedCatalogOnly: true };
  const pending = listManagedPlugins(params);
  try {
    const first = await Promise.race([pending, nextTurn().then(() => undefined)]);
    expect(first?.plugins).toContainEqual(
      expect.objectContaining({ id: "phase-plugin", installed: true, enabled: true }),
    );
    expect(first?.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("pending") }),
    );
  } finally {
    hosted.resolve(emptyCatalog);
    await pending;
  }
  const prepared = await list(config);
  expect(await listManagedPlugins(params)).toEqual(prepared);
  config.plugins.entries["phase-plugin"].enabled = false;
  expect((await listManagedPlugins(params)).plugins).toContainEqual(
    expect.objectContaining({ id: "phase-plugin", enabled: false, state: "disabled" }),
  );
  expect(officialCatalog).toHaveBeenCalledOnce();
});

it("uses current config after awaiting the hosted catalog", async () => {
  const config = { plugins: { entries: { "phase-plugin": { enabled: true } } } };
  const hosted = createDeferred<typeof emptyCatalog>();
  metadata.mockReturnValue(pluginMetadata({ id: "phase-plugin" }));
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
      metadata.mockReturnValue(
        pluginMetadata(
          {
            id: "bundled-provider",
            origin: "bundled",
            enabledByDefault: true,
            providers: ["fixture-provider"],
            channels: ["fixture-chat"],
            ...(!providerEnabled
              ? {
                  packageBuild: { bundledDist: false },
                  packageDependencies: { "missing-runtime": "1.0.0" },
                }
              : {}),
          },
          {
            id: "bundled-ordinary",
            origin: "bundled",
            enabledByDefault: true,
          },
        ),
      );
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
    pluginMetadata({
      id: "lifecycle-missing-runtime",
      origin: "global",
      enabledByDefault: true,
      packageDependencies: { "missing-runtime": "1.0.0" },
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
