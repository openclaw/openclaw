import assert from "node:assert/strict";
import path from "node:path";
import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import type { OpenKeyedStoreOptions } from "../plugin-state/plugin-state-store.types.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createPluginRegistry, type PluginRecord } from "../plugins/registry.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import {
  resolveBundledPluginPublicModulePath,
  resolveRelativeBundledPluginPublicModuleId,
} from "../test-utils/bundled-plugin-public-surface.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";

// Load the real plugin fixture during collection, outside individual test deadlines.
const { createMemoryRuntime } = await vi.importActual<
  typeof import("../../extensions/memory-core/runtime-api.js")
>(
  resolveRelativeBundledPluginPublicModuleId({
    fromModuleUrl: import.meta.url,
    pluginId: "memory-core",
    artifactBasename: "runtime-api.js",
  }),
);

export function createGatewayMemoryCloseRegistryFactory(config: OpenClawConfig) {
  // Workers must use the same source artifacts as the imported real Memory fixture.
  const workerApi = resolveBundledPluginPublicModulePath({
    pluginId: "memory-core",
    artifactBasename: "worker-api.js",
  });
  // The enclosing Gateway/state fixture owns restoration of these selectors.
  deleteTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS");
  setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", path.dirname(path.dirname(workerApi)));
  const env = { ...process.env };
  return (close: () => Promise<void>, beforeEmbedBatch?: () => Promise<void>) => {
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
    const addPlugin = (id: string, contracts?: PluginRecord["contracts"]) => {
      const record = createPluginRecord({
        id,
        source: "fixture",
        origin: "config",
        enabled: true,
        configSchema: false,
        contracts,
      });
      builder.registry.plugins.push(record);
      return record;
    };
    const memory = addPlugin("memory-fixture");
    memory.kind = "memory";
    memory.memorySlotSelected = true;
    const api = builder.createApi(memory, { config });
    const { runInBackgroundContext } = api.lifecycle;
    assert(runInBackgroundContext);
    // Runtime creation initializes dreaming in the plugin's instance context (#167724).
    const runtime = runInBackgroundContext(() =>
      createMemoryRuntime({
        runInBackgroundContext,
        openKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
          createPluginStateKeyedStore<T>("memory-core", { ...options, env }),
      }),
    );
    api.registerMemoryCapability({ runtime });
    const embedding = addPlugin("fixture-embedding", { embeddingProviders: ["fixture-embedding"] });
    builder.createApi(embedding, { config }).registerEmbeddingProvider({
      id: "fixture-embedding",
      transport: "remote",
      create: async () => ({
        provider: {
          id: "fixture-embedding",
          model: "synthetic-embedding",
          embed: async () => [1, 0, 0],
          embedBatch: async (inputs) => {
            await beforeEmbedBatch?.();
            return inputs.map(() => [1, 0, 0]);
          },
          close,
        },
      }),
    });
    return { ...builder, runtime, instance: getPluginInstance(memory)! };
  };
}
