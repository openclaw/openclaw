import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { withPluginSourceCaptureDirectory } from "../plugins/plugin-package-metadata-capture.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { prepareGatewayPluginLoad } from "./server-plugin-bootstrap.js";
import { createPluginReloadRecovery } from "./server-plugin-reload-recovery.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

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

it.each(["directory", "file"])(
  "can replace a generation with a missing capture %s without recovering it from changed installed code",
  async (missing) => {
    const root = temp.make("plugin-reload-missing-source-");
    const captures = path.join(root, "captures");
    const bundled = path.join(root, "bundled");
    fs.mkdirSync(captures);
    fs.mkdirSync(bundled);
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundled);
    const ids = ["missing-capture", "healthy-capture"];
    const paths = ids.map((id) => {
      const directory = path.join(root, id);
      fs.mkdirSync(path.join(directory, "dist", ".setup"), { recursive: true });
      fs.writeFileSync(
        path.join(directory, "openclaw.plugin.json"),
        JSON.stringify({ id, providers: [id], configSchema: { type: "object" } }),
      );
      fs.writeFileSync(
        path.join(directory, "index.cjs"),
        `const { label } = require('./dist/.setup/value.cjs');
         exports.filename = __filename;
         exports.id = ${JSON.stringify(id)};
         exports.register = api => api.registerProvider({ id: exports.id, label, auth: [] });`,
      );
      fs.writeFileSync(
        path.join(directory, "dist", ".setup", "value.cjs"),
        'exports.label = "old";',
      );
      return directory;
    });
    const params = {
      cfg: { plugins: { allow: ids, load: { paths }, slots: { memory: "none" } } },
      pluginIds: ids,
      baseMethods: [],
      log: { info() {}, warn() {}, error() {}, debug() {} },
      loadIntent: "replacement" as const,
    };
    const caches = [createPluginCache(), createPluginCache(), createPluginCache()];
    const previous = withPluginSourceCaptureDirectory(captures, () =>
      withPluginCache(caches[0]!, () => prepareGatewayPluginLoad(params)),
    );
    const recovery = createPluginReloadRecovery(previous.pluginRegistry, prepareGatewayPluginLoad);
    const loaded = [previous];
    try {
      expect(previous.pluginRegistry.providers.map((entry) => entry.provider.label)).toEqual([
        "old",
        "old",
      ]);
      const record = previous.pluginRegistry.plugins.find((entry) => entry.id === ids[0])!;
      const instance = getPluginInstance(record)!;
      const filename = (instance.loadModule(record.source) as { filename: string }).filename;
      const captureRoot = path.join(
        captures,
        path.relative(captures, filename).split(path.sep)[0]!,
      );
      fs.rmSync(
        missing === "directory"
          ? captureRoot
          : path.join(path.dirname(filename), "dist", ".setup", "value.cjs"),
        { recursive: true },
      );

      const warnings = withPluginSourceCaptureDirectory(captures, () =>
        recovery.capture(new Set(ids)),
      );
      const generation = createGatewayPluginRuntimeGeneration({
        getServices: () => null,
        setServices() {},
      });
      const resumed = generation.reserve();
      resumed.reject();
      resumed.finishReload(
        "restored",
        new Set(ids),
        previous.pluginRegistry,
        recovery.unavailablePluginIds,
      );
      expect(generation.getReloadStatus()).toBeUndefined();
      for (const directory of paths) {
        fs.writeFileSync(
          path.join(directory, "dist", ".setup", "value.cjs"),
          'exports.label = "new";',
        );
      }
      await disposePluginRegistryInstances(previous.pluginRegistry);
      const restored = withPluginSourceCaptureDirectory(captures, () =>
        withPluginCache(caches[1]!, () =>
          recovery.prepare(
            {
              ...params,
              previousRegistry: previous.pluginRegistry,
              replacePluginIds: new Set(ids),
            },
            new Error("candidate failed"),
          ),
        ),
      );
      loaded.push(restored);
      expect(
        restored.pluginRegistry.providers.map((entry) => [entry.pluginId, entry.provider.label]),
      ).toEqual([[ids[1], "old"]]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(ids[0]);
      const failed = generation.reserve();
      failed.reject();
      failed.finishReload(
        "restored",
        new Set(ids),
        restored.pluginRegistry,
        recovery.unavailablePluginIds,
      );
      expect(generation.getReloadStatus()).toMatchObject({ phase: "failed", pluginIds: [ids[0]] });

      const replacement = withPluginSourceCaptureDirectory(captures, () =>
        withPluginCache(caches[2]!, () => prepareGatewayPluginLoad(params)),
      );
      loaded.push(replacement);
      expect(replacement.pluginRegistry.providers.map((entry) => entry.provider.label)).toEqual([
        "new",
        "new",
      ]);
      const applied = generation.reserve();
      applied.commit();
      applied.finishReload("applied", new Set(ids), replacement.pluginRegistry, new Set());
      expect(generation.getReloadStatus()).toBeUndefined();
    } finally {
      recovery.dispose();
      for (const registry of loaded.toReversed()) {
        registry.retireGatewayRuntimeBindings();
        await disposePluginRegistryInstances(registry.pluginRegistry);
      }
      for (const cache of caches) {
        await retirePluginCache(cache);
      }
    }
  },
);
