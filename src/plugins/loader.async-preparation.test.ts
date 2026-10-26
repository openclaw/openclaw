import { availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createGatewayStartupTrace } from "../gateway/server-startup-trace.js";
import { createDeferredCore } from "../shared/deferred.js";
import { loadOpenClawPlugins, loadOpenClawPluginsAsync } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import * as preparation from "./plugin-generation-worker.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

function fixture() {
  useNoBundledPlugins();
  const provider = (id: string, label: string) =>
    writePlugin({
      id: `${id}-external`,
      registration: `api.registerProvider({ id: "${id}", label: "${label}", auth: [] });`,
    });
  const first = provider("first", "First");
  const second = provider("second", "Second");
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

async function isolated<T>(run: (input: ReturnType<typeof fixture>) => Promise<T>) {
  await using cache = createPluginCache();
  return await withPluginSourceCaptureStorage(
    { stateDir: makePluginLoaderTempDir(), placement: "state" },
    () => withPluginCache(cache, () => run(fixture())),
  );
}

it("reports the shared external preparation worker once in ordinary startup logs", () =>
  isolated(async ({ options }) => {
    const info = vi.fn();
    const trace = createGatewayStartupTrace({ info } as never);
    try {
      const registry = await loadOpenClawPluginsAsync({ ...options, startupTrace: trace });
      expect(registry.plugins.filter((plugin) => plugin.status === "loaded")).toHaveLength(2);
      const preparationMessages = info.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.startsWith("startup trace: plugins.gateway-load.plugin."));
      expect(
        preparationMessages.filter((message) =>
          message.includes("plugin-generation-preparation.worker.js:1"),
        ),
        preparationMessages.join("\n"),
      ).toHaveLength(1);
    } finally {
      trace.close();
    }
  }));

it("bounds source acquisition and waits before publishing registrations in order", () =>
  isolated(async ({ options }) => {
    const more = Array.from({ length: 4 }, (_, index) =>
      writePlugin({ id: `extra-${index}`, registration: "" }),
    );
    options.config.plugins.allow.push(...more.map(({ id }) => id));
    options.config.plugins.load.paths.push(...more.map(({ file }) => file));
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const prepare = preparation.preparePluginGenerationArtifact;
    const detail = vi.fn();
    const now = performance.now.bind(performance);
    let preparationDelay = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now() + preparationDelay);
    let published = false;
    let active = 0;
    let peak = 0;
    vi.spyOn(preparation, "preparePluginGenerationArtifact").mockImplementation(async (params) => {
      peak = Math.max(peak, ++active);
      if (active === Math.min(4, availableParallelism())) {
        entered.resolve();
      }
      try {
        await release.promise;
        preparationDelay += 1_000;
        return await prepare(params);
      } finally {
        active--;
      }
    });
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
    expect(peak).toBe(Math.min(4, availableParallelism()));
    expect(registry.providers.map(({ provider }) => provider.label)).toEqual(["First", "Second"]);
    expect(registry.plugins.map(({ id, status }) => [id, status])).toEqual([
      ["first-external", "loaded"],
      ["second-external", "loaded"],
      ...more.map(({ id }) => [id, "loaded"]),
    ]);
    expect(registry.diagnostics.filter(({ level }) => level === "error")).toEqual([]);
    for (const id of ["first-external", "second-external"]) {
      const metrics = Object.fromEntries(
        detail.mock.calls.find(([name]) => name === `plugins.gateway-load.plugin.${id}`)![1],
      );
      expect(metrics.modulePreparationMs).toBeGreaterThanOrEqual(1_000);
      expect(metrics.modulePreparationMs).toBeLessThanOrEqual(metrics.loadMs);
    }
  }));

it("records acquisition failure for one plugin and still loads its sibling", () =>
  isolated(async ({ first, second, options }) => {
    const prepare = preparation.preparePluginGenerationArtifact;
    vi.spyOn(preparation, "preparePluginGenerationArtifact").mockImplementation(async (params) => {
      if (params.rootDir === first.dir) {
        throw new Error("source acquisition failed");
      }
      return prepare(params);
    });
    const invalid = writePlugin({
      id: "invalid-external",
      registration: "throw new Error('invalid config must not execute');",
      configSchema: { type: "object", required: ["missing"] },
    });
    options.config.plugins.allow.push(invalid.id);
    options.config.plugins.load.paths.splice(1, 0, invalid.file);
    const registry = await loadOpenClawPluginsAsync(options);
    expect(
      registry.diagnostics.filter(({ level }) => level === "error").map(({ pluginId }) => pluginId),
    ).toEqual([first.id, invalid.id]);
    expect(registry.plugins.map(({ id }) => id)).toEqual([first.id, invalid.id, second.id]);
    expect(registry.plugins.find((plugin) => plugin.id === first.id)?.status).toBe("error");
    expect(registry.plugins.find((plugin) => plugin.id === second.id)?.status).toBe("loaded");
    expect(registry.providers.map(({ provider }) => provider.label)).toEqual(["Second"]);
  }));

it.each(["synchronous CLI", "cached async"])("loads %s without worker acquisition", (mode) =>
  isolated(async ({ options }) => {
    const first = mode === "cached async" ? await loadOpenClawPluginsAsync(options) : undefined;
    vi.spyOn(preparation, "preparePluginGenerationArtifact").mockRejectedValue(
      new Error("worker unavailable"),
    );
    const registry =
      mode === "cached async"
        ? await loadOpenClawPluginsAsync(options)
        : loadOpenClawPlugins(options);
    if (first) {
      expect(registry).toBe(first);
    }
    expect(registry.providers.map(({ provider }) => provider.label)).toEqual(["First", "Second"]);
  }),
);
