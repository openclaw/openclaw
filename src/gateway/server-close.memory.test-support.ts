// Real Memory Core manager and embedding close contract shared by Gateway close tests.
import assert from "node:assert/strict";
import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "../plugin-state/plugin-state-store.types.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import type { MemoryPluginRuntime } from "../plugins/registry-contribution-types.js";
import { createPluginRegistry } from "../plugins/registry.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../test-utils/bundled-plugin-public-surface.js";

export async function createGatewayMemoryCloseRegistryFactory(config: OpenClawConfig) {
  const { createMemoryRuntime, configureMemoryCoreDreamingState } = await vi.importActual<{
    createMemoryRuntime: (host: {
      runInBackgroundContext: <T>(run: () => T) => T;
    }) => MemoryPluginRuntime;
    configureMemoryCoreDreamingState: (
      open: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
    ) => void;
  }>(
    resolveRelativeBundledPluginPublicModuleId({
      fromModuleUrl: import.meta.url,
      pluginId: "memory-core",
      artifactBasename: "runtime-api.js",
    }),
  );
  const env = { ...process.env };
  const registry = (close: () => Promise<void>, beforeEmbedBatch?: () => Promise<void>) => {
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
    const memory = createPluginRecord({
      id: "memory-fixture",
      source: "fixture",
      origin: "config",
      enabled: true,
      configSchema: false,
    });
    memory.kind = "memory";
    memory.memorySlotSelected = true;
    builder.registry.plugins.push(memory);
    const api = builder.createApi(memory, { config });
    assert(api.lifecycle.runInBackgroundContext);
    // Dreaming state is instance-owned (#167724): configure it where the memory
    // registration runs, as Memory Core's own register() does.
    api.lifecycle.runInBackgroundContext(() =>
      configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStore<T>("memory-core", { ...options, env }),
      ),
    );
    api.registerMemoryCapability({
      runtime: createMemoryRuntime({
        runInBackgroundContext: api.lifecycle.runInBackgroundContext,
      }),
    });
    const embedding = createPluginRecord({
      id: "fixture-embedding",
      source: "fixture",
      origin: "config",
      enabled: true,
      configSchema: false,
      contracts: { embeddingProviders: ["fixture-embedding"] },
    });
    builder.registry.plugins.push(embedding);
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
    const runtime = builder.registry.memoryCapabilities[0]?.capability.runtime;
    assert(runtime);
    return { ...builder, runtime, instance: getPluginInstance(memory)! };
  };
  return registry;
}
