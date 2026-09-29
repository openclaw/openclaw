import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createHookRunner } from "./hooks.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  resetPluginLoaderTestStateForTest,
  makePluginLoaderTempDir,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { capturePluginRuntimeRecovery } from "./plugin-runtime-artifact-binding.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry-types.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import { getPluginRuntimeLoadContext } from "./runtime/load-context.js";

it("registers preserved code and config with a fresh owner while retaining unaffected plugins", async () => {
  useNoBundledPlugins();
  const plugin = writePlugin({
    id: "recover-owner",
    body: `let count = 0;
      module.exports = { id: 'recover-owner', register(api) {
        api.registerTool({ name: 'recover_probe', description: 'Recovery fixture',
          parameters: { type: 'object', properties: {} },
          execute() { return { content: [{type: 'text', text: api.pluginConfig.marker + ':' + ++count}] }; }
        });
      } };`,
  });
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: plugin.id,
      configSchema: { type: "object", properties: { marker: { type: "string" } } },
      contracts: { tools: ["recover_probe"] },
    }),
  );
  const unaffected = writePlugin({
    id: "retained-owner",
    body: `module.exports = { id: 'retained-owner', register() {} };`,
  });
  const config = {
    plugins: {
      allow: [plugin.id, unaffected.id],
      load: { paths: [plugin.file, unaffected.file] },
      slots: { memory: "none" },
      entries: { [plugin.id]: { config: { marker: "original" } } },
    },
  };
  const options = {
    config,
    activate: false,
    runtimeSideEffects: true,
    cache: false,
    throwOnLoadError: true,
  };
  let previous: PluginRegistry | undefined;
  let restored: PluginRegistry | undefined;
  let recovery: ReturnType<typeof capturePluginRuntimeRecovery>;
  try {
    previous = loadOpenClawPlugins(options);
    const oldRecord = previous.plugins.find((record) => record.id === plugin.id)!;
    const oldInstance = getPluginInstance(oldRecord)!;
    recovery = capturePluginRuntimeRecovery(oldRecord);
    expect(recovery).toBeDefined();
    const oldTool = previous.tools[0]!.factory({});
    if (!oldTool || Array.isArray(oldTool)) {
      throw new Error("Expected recovery fixture tool");
    }
    expect(await oldTool.execute("old", {})).toMatchObject({
      content: [{ text: "original:1" }],
    });
    const manifestRegistry = getPluginRuntimeLoadContext(previous)!.manifestRegistry;
    fs.writeFileSync(plugin.file, "throw new Error('replacement entry must not run');");
    await oldInstance.dispose();
    fs.rmSync(plugin.dir, { recursive: true });

    restored = loadOpenClawPlugins({
      ...options,
      manifestRegistry,
      previousRegistry: previous,
      moduleRecoveries: new Map([[plugin.id, recovery!]]),
    });
    const restoredRecord = restored.plugins.find((record) => record.id === plugin.id)!;
    expect(restoredRecord).not.toBe(oldRecord);
    expect(getPluginInstance(restoredRecord)).not.toBe(oldInstance);
    expect(restored.plugins.find((record) => record.id === unaffected.id)).toBe(
      previous.plugins.find((record) => record.id === unaffected.id),
    );
    const tool = restored.tools[0]!.factory({});
    if (!tool || Array.isArray(tool)) {
      throw new Error("Expected recovered fixture tool");
    }
    expect(await tool.execute("restored", {})).toMatchObject({
      content: [{ text: "original:1" }],
    });
    expect(() => oldTool.execute("retired", {})).toThrow();
  } finally {
    recovery?.module.dispose();
    if (restored) {
      await disposePluginRegistryInstances(restored);
    }
    if (previous) {
      await disposePluginRegistryInstances(previous);
    }
    resetPluginLoaderTestStateForTest();
  }
});

it("joins a failed candidate's declared stop hook before recovering the previous resource owner", async () => {
  useNoBundledPlugins();
  const lock = path.join(makePluginLoaderTempDir(), "owned.lock");
  const gate = createDeferredCore();
  const plugin = writePlugin({
    id: "failed-resource-owner",
    body: `const fs = require('node:fs');
      module.exports = { id: 'failed-resource-owner', register(api) {
        const lock = ${JSON.stringify(lock)};
        const fd = fs.openSync(lock, 'wx');
        api.on('gateway_stop', async () => {
          require('./close.cjs').close(fd, lock);
        });
        if (api.pluginConfig.fail) throw new Error('candidate registration failed');
      } };`,
  });
  fs.writeFileSync(
    path.join(plugin.dir, "close.cjs"),
    "exports.close = (fd, lock) => { const fs = require('node:fs'); fs.closeSync(fd); fs.unlinkSync(lock); };",
  );
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: plugin.id,
      configSchema: { type: "object", properties: { fail: { type: "boolean" } } },
    }),
  );
  const config = {
    plugins: {
      allow: [plugin.id],
      load: { paths: [plugin.file] },
      slots: { memory: "none" },
      entries: { [plugin.id]: { config: { fail: false } } },
    },
  };
  const options = { config, activate: false, runtimeSideEffects: true, cache: false };
  const registries: PluginRegistry[] = [];
  let recovery: ReturnType<typeof capturePluginRuntimeRecovery>;
  const stop = (registry: PluginRegistry) =>
    createHookRunner(registry, { catchErrors: false }).runGatewayStop(
      { reason: "plugin replacement" },
      { port: 0, config, getCron: () => undefined },
    );
  try {
    const old = loadOpenClawPlugins(options);
    registries.push(old);
    recovery = capturePluginRuntimeRecovery(old.plugins[0]!);
    const manifestRegistry = getPluginRuntimeLoadContext(old)!.manifestRegistry;
    await stop(old);
    await disposePluginRegistryInstances(old);
    const candidate = loadOpenClawPlugins({
      ...options,
      config: {
        plugins: {
          ...config.plugins,
          entries: { [plugin.id]: { config: { fail: true } } },
        },
      },
      manifestRegistry,
      previousRegistry: old,
      prepareRegistrationFailureCleanup(registry, record) {
        const hooks = createEmptyPluginRegistry();
        hooks.typedHooks = registry.typedHooks.filter(
          (hook) => hook.pluginId === record.id && hook.hookName === "gateway_stop",
        );
        getPluginInstance(record)!.lifecycle.onDispose(async () => {
          await gate.promise;
          await stop(hooks);
        });
      },
    });
    registries.push(candidate);
    expect(candidate.plugins[0]!.error).toContain("candidate registration failed");
    expect(candidate.typedHooks).toEqual([]);
    expect(fs.existsSync(lock)).toBe(true);
    let retired = false;
    const retirement = disposePluginRegistryInstances(candidate).then(() => {
      retired = true;
    });
    await Promise.resolve();
    expect(retired).toBe(false);
    gate.resolve();
    await retirement;
    expect(fs.existsSync(lock)).toBe(false);

    const restored = loadOpenClawPlugins({
      ...options,
      manifestRegistry,
      previousRegistry: old,
      moduleRecoveries: new Map([[plugin.id, recovery!]]),
      throwOnLoadError: true,
    });
    registries.push(restored);
    expect(restored.plugins[0]!.status).toBe("loaded");
    expect(fs.existsSync(lock)).toBe(true);
    await stop(restored);
    expect(fs.existsSync(lock)).toBe(false);
  } finally {
    gate.resolve();
    recovery?.module.dispose();
    for (const registry of registries.toReversed()) {
      await disposePluginRegistryInstances(registry);
    }
    resetPluginLoaderTestStateForTest();
  }
});

it("preserves the registration error and disposes resources when cleanup preparation also fails", async () => {
  useNoBundledPlugins();
  const marker = path.join(makePluginLoaderTempDir(), "disposed");
  const plugin = writePlugin({
    id: "cleanup-preparation-failure",
    body: `module.exports = { id: 'cleanup-preparation-failure', register(api) {
      api.lifecycle.onDispose(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'disposed'));
      throw new Error('original registration failure');
    } };`,
  });
  let registry: PluginRegistry | undefined;
  try {
    registry = loadOpenClawPlugins({
      config: {
        plugins: { allow: [plugin.id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
      },
      activate: false,
      cache: false,
      prepareRegistrationFailureCleanup() {
        throw new Error("cleanup preparation failure");
      },
    });
    expect(registry.plugins[0]!.error).toContain("original registration failure");
    expect(registry.plugins[0]!.error).toContain("cleanup preparation failure");
    await disposePluginRegistryInstances(registry);
    expect(fs.readFileSync(marker, "utf8")).toBe("disposed");
  } finally {
    if (registry) {
      await disposePluginRegistryInstances(registry);
    }
    resetPluginLoaderTestStateForTest();
  }
});
