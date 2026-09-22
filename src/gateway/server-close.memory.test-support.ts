// Real Memory Core manager and embedding close contract shared by Gateway close tests.
import assert from "node:assert/strict";
import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import type { MemoryPluginRuntime } from "../plugins/registry-contribution-types.js";
import { createPluginRegistry } from "../plugins/registry.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../test-utils/bundled-plugin-public-surface.js";

export async function createGatewayMemoryCloseRegistryFactory(config: OpenClawConfig) {
  const { memoryRuntime } = await vi.importActual<{ memoryRuntime: MemoryPluginRuntime }>(
    resolveRelativeBundledPluginPublicModuleId({
      fromModuleUrl: import.meta.url,
      pluginId: "memory-core",
      artifactBasename: "runtime-api.js",
    }),
  );
  const registry = (close: () => Promise<void>) => {
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
    builder.createApi(memory, { config }).registerMemoryCapability({ runtime: memoryRuntime });
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
          embedBatch: async () => [[1, 0, 0]],
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
