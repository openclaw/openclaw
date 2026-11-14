import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
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

it("joins host-local recovery cleanup without blocking foreground work", async () => {
  await using fixture = recoveryFixture(
    "recovery-cleanup",
    'module.exports = { id: "recovery-cleanup", register(api) { api.registerProvider({ id: "recovery-provider", label: "Active", auth: [], normalizeModelId: ({ modelId }) => `active:${modelId}` }); } };',
  );
  const { plugin, load, capturedRoot } = fixture;
  await fixture.run(async () => {
    const previous = await load();
    // The transferred source stays in worker scratch; recovery owns a host-local sibling.
    const workerScratch = path.dirname(capturedRoot());
    const captureParent = path.dirname(workerScratch);
    const capturesBefore = fs.readdirSync(captureParent);
    const recovery = createPluginReloadRecovery(previous, prepareGatewayPluginLoad);
    try {
      expect(recovery.capture(new Set([plugin.id]))).toEqual([]);
      const addedCaptures = fs
        .readdirSync(captureParent)
        .filter((entry) => !capturesBefore.includes(entry));
      expect(addedCaptures).toHaveLength(1);
      const recoveryRoot = path.join(captureParent, addedCaptures[0]!);
      // Physical removal must yield to already queued foreground work, not synchronously drain.
      const foreground = Promise.resolve().then(() => {
        expect(fs.existsSync(recoveryRoot)).toBe(true);
      });
      await Promise.all([recovery.dispose(), foreground]);
      expect(fs.existsSync(recoveryRoot)).toBe(false);
      expect(fs.readdirSync(captureParent)).toEqual(capturesBefore);
      expect(
        previous.providers[0]!.provider.normalizeModelId!({
          provider: "recovery-provider",
          modelId: "still-callable",
        }),
      ).toBe("active:still-callable");
    } finally {
      await recovery.dispose();
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
      expect(recovery.capture(new Set([plugin.id]))).toEqual([
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
