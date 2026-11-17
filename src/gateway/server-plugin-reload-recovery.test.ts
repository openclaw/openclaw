import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { loadOpenClawPluginsAsync } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import * as preparation from "../plugins/plugin-generation-worker.js";
import { withPluginSourceCaptureStorage } from "../plugins/plugin-source-capture-context.js";
import { createDeferredCore } from "../shared/deferred.js";
import { prepareGatewayPluginLoad } from "./server-plugin-bootstrap.js";
import { createPluginReloadRecovery } from "./server-plugin-reload-recovery.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

function recoveryFixture(id: string, body: string) {
  useNoBundledPlugins();
  const plugin = writePlugin({ id, body });
  let root: string | undefined;
  const prepare = preparation.preparePluginGenerationArtifact;
  vi.spyOn(preparation, "preparePluginGenerationArtifact").mockImplementation(async (params) => {
    const prepared = await prepare(params);
    root = prepared.artifact.boundaryRoot;
    return prepared;
  });
  const stateDir = makePluginLoaderTempDir();
  const caches: ReturnType<typeof createPluginCache>[] = [];
  return {
    plugin,
    stateDir,
    capturedRoot(this: void) {
      expect(root).toBeDefined();
      return root!;
    },
    load(this: void) {
      const cache = createPluginCache();
      caches.push(cache);
      return withPluginCache(cache, () =>
        loadOpenClawPluginsAsync({
          activate: false,
          config: {
            plugins: { allow: [id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
          },
        }),
      );
    },
    run<T>(run: () => T) {
      return withPluginSourceCaptureStorage({ stateDir, placement: "state" }, run);
    },
    async [Symbol.asyncDispose]() {
      for (const cache of caches) {
        await retirePluginCache(cache);
      }
    },
  };
}

it("joins host-local recovery cleanup without synchronous recursive removal", async ({
  signal,
}) => {
  await using fixture = recoveryFixture(
    "recovery-cleanup",
    'module.exports = { id: "recovery-cleanup", register(api) { api.registerProvider({ id: "recovery-provider", label: "Active", auth: [], normalizeModelId: ({ modelId }) => `active:${modelId}` }); } };',
  );
  const { plugin, load, capturedRoot } = fixture;
  await fixture.run(async () => {
    const previous = await load();
    // Recovery owns a host-local copy independently of the broker's source directory.
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const copy = fs.promises.cp;
    using copies = vi.spyOn(fs.promises, "cp").mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return copy(...args);
    });
    const recovery = createPluginReloadRecovery(previous, prepareGatewayPluginLoad);
    let settled = false;
    const capturing = recovery.capture(new Set([plugin.id])).finally(() => {
      settled = true;
    });
    try {
      await withinTest(entered.promise, signal);
      await setImmediate();
      expect(settled).toBe(false);
      release.resolve();
      expect(await capturing).toEqual([]);
      expect(copies).toHaveBeenCalledTimes(1);
      const [source, recoveryRoot] = copies.mock.calls[0]!;
      expect(source).toBe(capturedRoot());
      expect(recoveryRoot).not.toBe(source);
      expect(fs.existsSync(recoveryRoot)).toBe(true);
      // Native async removal can finish before a queued microtask; observe blocking work instead.
      using synchronousRemovals = vi.spyOn(fs, "rmSync");
      await recovery.dispose();
      expect(
        synchronousRemovals.mock.calls.filter(([, options]) => options?.recursive),
      ).toHaveLength(0);
      expect(fs.existsSync(recoveryRoot)).toBe(false);
      expect(fs.existsSync(capturedRoot())).toBe(true);
      expect(
        previous.providers[0]!.provider.normalizeModelId!({
          provider: "recovery-provider",
          modelId: "still-callable",
        }),
      ).toBe("active:still-callable");
    } finally {
      release.resolve();
      try {
        await capturing;
      } finally {
        await recovery.dispose();
      }
    }
  });
});

it("replaces a worker-backed plugin when its previous captured source is missing", async () => {
  await using fixture = recoveryFixture(
    "missing-capture",
    'module.exports = { id: "missing-capture", register(api) { api.registerProvider({ id: "replacement", label: "Old", auth: [] }); } };',
  );
  const { plugin, load, capturedRoot, stateDir } = fixture;
  await fixture.run(async () => {
    const previous = await load();
    const root = capturedRoot();
    const relativeCapture = path.relative(stateDir, root);
    expect(relativeCapture).not.toBe("");
    expect(relativeCapture.startsWith("..") || path.isAbsolute(relativeCapture)).toBe(false);
    fs.rmSync(root, { recursive: true });
    const recovery = createPluginReloadRecovery(previous, prepareGatewayPluginLoad);
    try {
      expect(await recovery.capture(new Set([plugin.id]))).toEqual([
        `Plugin ${plugin.id} captured source is missing. Continuing replacement; rollback cannot restore this plugin's previous code.`,
      ]);
      expect([...recovery.unavailablePluginIds]).toEqual([plugin.id]);
      fs.writeFileSync(
        plugin.file,
        'module.exports = { id: "missing-capture", register(api) { api.registerProvider({ id: "replacement", label: "New", auth: [] }); } };',
      );
      const replacement = await load();
      expect(replacement.plugins.find(({ id }) => id === plugin.id)?.status).toBe("loaded");
      expect(replacement.providers.map(({ provider }) => provider.label)).toEqual(["New"]);
    } finally {
      await recovery.dispose();
    }
  });
});
