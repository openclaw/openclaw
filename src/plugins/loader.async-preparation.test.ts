import { performance } from "node:perf_hooks";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { loadOpenClawPlugins, loadOpenClawPluginsAsync } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import * as preparation from "./plugin-generation-worker.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

function fixture() {
  useNoBundledPlugins();
  const first = writePlugin({
    id: "first-external",
    registration: 'api.registerProvider({ id: "first", label: "First", auth: [] });',
  });
  const second = writePlugin({
    id: "second-external",
    registration: 'api.registerProvider({ id: "second", label: "Second", auth: [] });',
  });
  return {
    first,
    second,
    options: {
      activate: false,
      config: {
        plugins: {
          allow: [first.id, second.id],
          load: { paths: [first.file, second.file] },
          slots: { memory: "none" },
        },
      },
    },
  };
}

async function isolated<T>(run: () => Promise<T>) {
  const cache = createPluginCache();
  try {
    return await withPluginSourceCaptureStorage(
      { stateDir: makePluginLoaderTempDir(), placement: "state" },
      () => withPluginCache(cache, run),
    );
  } finally {
    await retirePluginCache(cache);
  }
}

it("waits for selected external source acquisition before publishing registrations", async () => {
  const { options } = fixture();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const prepare = preparation.preparePluginGenerationArtifact;
  const detail = vi.fn();
  const now = performance.now.bind(performance);
  let preparationDelay = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now() + preparationDelay);
  let published = false;
  vi.spyOn(preparation, "preparePluginGenerationArtifact").mockImplementation(async (params) => {
    entered.resolve();
    await release.promise;
    preparationDelay += 1_000;
    return prepare(params);
  });
  await isolated(async () => {
    const loading = loadOpenClawPluginsAsync({ ...options, startupTrace: { detail } }).then(
      (registry) => {
        published = true;
        return registry;
      },
    );
    try {
      await Promise.race([
        entered.promise,
        loading.then(() => {
          throw new Error("Registry published before source acquisition");
        }),
      ]);
      expect(published).toBe(false);
    } finally {
      release.resolve();
    }
    const registry = await loading;
    expect(registry.providers.map(({ provider }) => provider.label)).toEqual(["First", "Second"]);
    expect(registry.plugins.every((plugin) => plugin.status === "loaded")).toBe(true);
    for (const id of ["first-external", "second-external"]) {
      const metrics = Object.fromEntries(
        detail.mock.calls.find(([name]) => name === `plugins.gateway-load.plugin.${id}`)![1],
      );
      expect(metrics.modulePreparationMs).toBeGreaterThanOrEqual(1_000);
      expect(metrics.modulePreparationMs).toBeLessThanOrEqual(metrics.loadMs);
    }
  });
});

it("records acquisition failure for one plugin and still loads its sibling", async () => {
  const { first, second, options } = fixture();
  const prepare = preparation.preparePluginGenerationArtifact;
  vi.spyOn(preparation, "preparePluginGenerationArtifact").mockImplementation(async (params) => {
    if (params.rootDir === first.dir) {
      throw new Error("source acquisition failed");
    }
    return prepare(params);
  });
  await isolated(async () => {
    const registry = await loadOpenClawPluginsAsync(options);
    expect(registry.plugins.find((plugin) => plugin.id === first.id)?.status).toBe("error");
    expect(registry.plugins.find((plugin) => plugin.id === second.id)?.status).toBe("loaded");
    expect(registry.providers.map(({ provider }) => provider.label)).toEqual(["Second"]);
  });
});

it("keeps synchronous CLI loading independent of worker acquisition", async () => {
  const { options } = fixture();
  vi.spyOn(preparation, "preparePluginGenerationArtifact").mockRejectedValue(
    new Error("worker unavailable"),
  );
  await isolated(async () => {
    const registry = loadOpenClawPlugins(options);
    expect(registry.providers.map(({ provider }) => provider.label)).toEqual(["First", "Second"]);
  });
});

it("reuses a loaded registry without reacquiring its external sources", async () => {
  const { options } = fixture();
  await isolated(async () => {
    const first = await loadOpenClawPluginsAsync(options);
    vi.spyOn(preparation, "preparePluginGenerationArtifact").mockRejectedValue(
      new Error("new acquisition unavailable"),
    );
    const second = await loadOpenClawPluginsAsync(options);
    expect(second).toBe(first);
    expect(second.providers.map(({ provider }) => provider.label)).toEqual(["First", "Second"]);
  });
});
