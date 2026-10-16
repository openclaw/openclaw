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
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { prepareGatewayPluginLoad } from "./server-plugin-bootstrap.js";
import { createPluginReloadRecovery } from "./server-plugin-reload-recovery.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";

it("preserves readiness when rollback restores an already unavailable startup plugin", () => {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: "startup-error", status: "error" }));
  const selected = new Set(["startup-error"]);
  const recovery = createPluginReloadRecovery(registry, prepareGatewayPluginLoad);
  expect(recovery.capture(selected)).toEqual([]);
  const generation = createGatewayPluginRuntimeGeneration({
    getServices: () => null,
    setServices() {},
  });
  const rejected = generation.reserve();
  rejected.reject();
  rejected.finishReload("restored", selected, registry, recovery.unavailablePluginIds);
  expect(generation.getReloadStatus()).toBeUndefined();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it("replaces a worker-backed plugin when its previous captured source is missing", async () => {
  useNoBundledPlugins();
  const plugin = writePlugin({
    id: "missing-capture",
    body: 'module.exports = { id: "missing-capture", register(api) { api.registerProvider({ id: "replacement", label: "Old", auth: [] }); } };',
  });
  let capturedRoot: string | undefined;
  const prepare = preparation.preparePluginGenerationArtifact;
  vi.spyOn(preparation, "preparePluginGenerationArtifact").mockImplementation(async (params) => {
    const prepared = await prepare(params);
    capturedRoot = prepared.artifact.boundaryRoot;
    return prepared;
  });
  const captureState = makePluginLoaderTempDir();
  const oldCache = createPluginCache();
  const newCache = createPluginCache();
  const options = {
    activate: false,
    config: {
      plugins: { allow: [plugin.id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
    },
  };
  try {
    await withPluginSourceCaptureStorage(
      { stateDir: captureState, placement: "state" },
      async () => {
        const previous = await withPluginCache(oldCache, () => loadOpenClawPluginsAsync(options));
        expect(previous.providers.map(({ provider }) => provider.label)).toEqual(["Old"]);
        expect(capturedRoot).toBeDefined();
        const relativeCapture = path.relative(captureState, capturedRoot!);
        expect(relativeCapture).not.toBe("");
        expect(relativeCapture.startsWith("..") || path.isAbsolute(relativeCapture)).toBe(false);
        fs.rmSync(capturedRoot!, { recursive: true });
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
          const replacement = await withPluginCache(newCache, () =>
            loadOpenClawPluginsAsync(options),
          );
          expect(replacement.plugins.find(({ id }) => id === plugin.id)?.status).toBe("loaded");
          expect(replacement.providers.map(({ provider }) => provider.label)).toEqual(["New"]);
        } finally {
          recovery.dispose();
        }
      },
    );
  } finally {
    await retirePluginCache(oldCache);
    await retirePluginCache(newCache);
  }
});
