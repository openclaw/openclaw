import { performance } from "node:perf_hooks";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import * as moduleRuntime from "./loader-module-runtime.js";
import { loadOpenClawPlugins, loadOpenClawPluginsAsync } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import * as capture from "./plugin-generation-artifact.js";
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

it("waits for each external acquisition before executing its registration", async () => {
  const { first, second, options } = fixture();
  const createGate = (id: string) => ({
    id,
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  });
  const gates = [createGate(first.id), createGate(second.id)] as const;
  const detail = vi.fn();
  const now = performance.now.bind(performance);
  let preparationDelay = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now() + preparationDelay);
  const createLoader = moduleRuntime.createPluginModuleLoader;
  vi.spyOn(moduleRuntime, "createPluginModuleLoader").mockImplementation((...args) => {
    const loader = createLoader(...args);
    const prepare = loader.prepare.bind(loader);
    loader.prepare = async (source, owner) => {
      const gate = gates.find(({ id }) => id === owner.record.id);
      if (gate) {
        gate.entered.resolve();
        await gate.release.promise;
        preparationDelay += 1_000;
      }
      await prepare(source, owner);
    };
    return loader;
  });
  const registrations = vi.spyOn(moduleRuntime, "runPluginRegisterSyncInRegistry");
  const registeredIds = () => registrations.mock.calls.map((call) => call[3]);
  await isolated(async () => {
    const loading = loadOpenClawPluginsAsync({ ...options, startupTrace: { detail } });
    try {
      await gates[0].entered.promise;
      // Let a caller that incorrectly ignores preparation advance to registration.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(registeredIds()).toEqual([]);
      gates[0].release.resolve();
      await gates[1].entered.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(registeredIds()).toEqual([first.id]);
      gates[1].release.resolve();
      const registry = await loading;
      expect(registeredIds()).toEqual([first.id, second.id]);
      expect(registry.providers.map(({ provider }) => provider.label)).toEqual(["First", "Second"]);
      expect(registry.plugins.every((plugin) => plugin.status === "loaded")).toBe(true);
      for (const id of [first.id, second.id]) {
        const metrics = Object.fromEntries(
          detail.mock.calls.find(([name]) => name === `plugins.gateway-load.plugin.${id}`)![1],
        );
        expect(metrics.modulePreparationMs).toBeGreaterThanOrEqual(1_000);
        expect(metrics.modulePreparationMs).toBeLessThanOrEqual(metrics.loadMs);
      }
    } finally {
      for (const gate of gates) {
        gate.release.resolve();
      }
      await loading;
    }
  });
});

it("records acquisition failure for one plugin and still loads its sibling", async () => {
  const { first, second, options } = fixture();
  const acquire = capture.capturePreparedPluginGenerationArtifactSteps;
  vi.spyOn(capture, "capturePreparedPluginGenerationArtifactSteps").mockImplementation(
    (...args) => {
      if (args[0] === first.dir) {
        throw new Error("source acquisition failed");
      }
      return acquire(...args);
    },
  );
  await isolated(async () => {
    const registry = await loadOpenClawPluginsAsync(options);
    expect(registry.plugins.find((plugin) => plugin.id === first.id)?.status).toBe("error");
    expect(registry.plugins.find((plugin) => plugin.id === second.id)?.status).toBe("loaded");
    expect(registry.providers.map(({ provider }) => provider.label)).toEqual(["Second"]);
  });
});

it("keeps synchronous CLI loading independent of worker acquisition", async () => {
  const { options } = fixture();
  vi.spyOn(preparation, "preparePluginGenerationSource").mockRejectedValue(
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
    vi.spyOn(capture, "capturePreparedPluginGenerationArtifactSteps").mockImplementation(() => {
      throw new Error("new acquisition unavailable");
    });
    const second = await loadOpenClawPluginsAsync(options);
    expect(second).toBe(first);
    expect(second.providers.map(({ provider }) => provider.label)).toEqual(["First", "Second"]);
  });
});

it("rejects changed source before publishing its provider while loading its sibling", async () => {
  const { first, second, options } = fixture();
  await isolated(async () => {
    const registry = await loadOpenClawPluginsAsync({
      ...options,
      expectedSourceDigests: { [first.id]: "0".repeat(64) },
    });
    expect(registry.plugins.find((plugin) => plugin.id === first.id)?.error).toMatch(
      /source changed after installation/,
    );
    expect(registry.plugins.find((plugin) => plugin.id === second.id)?.status).toBe("loaded");
    expect(registry.providers.map(({ provider }) => provider.label)).toEqual(["Second"]);
  });
});
