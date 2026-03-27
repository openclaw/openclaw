import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getRegisteredMemoryEmbeddingProvider } from "../memory-embedding-providers.js";
import { createPluginRegistry, type PluginRecord } from "../registry.js";
import type { PluginRuntime } from "../runtime/types.js";
import { createPluginRecord } from "../status.test-helpers.js";
import type { OpenClawPluginApi } from "../types.js";

function registerTestPlugin(params: {
  registry: ReturnType<typeof createPluginRegistry>;
  config: OpenClawConfig;
  record: PluginRecord;
  register(api: OpenClawPluginApi): void;
}) {
  params.registry.registry.plugins.push(params.record);
  params.register(
    params.registry.createApi(params.record, {
      config: params.config,
    }),
  );
}

describe("memory embedding provider registration", () => {
  it("only allows memory plugins to register adapters", () => {
    const config = {} as OpenClawConfig;
    const registry = createPluginRegistry({
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      runtime: {} as PluginRuntime,
    });

    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "not-memory",
        name: "Not Memory",
        source: "/virtual/not-memory/index.ts",
      }),
      register(api) {
        api.registerMemoryEmbeddingProvider({
          id: "forbidden",
          create: async () => ({ provider: null }),
        });
      },
    });

    expect(getRegisteredMemoryEmbeddingProvider("forbidden")).toBeUndefined();
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "not-memory",
          message: "only memory plugins can register memory embedding providers",
        }),
      ]),
    );
  });

  it("records the owning memory plugin id for registered adapters", () => {
    const config = {} as OpenClawConfig;
    const registry = createPluginRegistry({
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      runtime: {} as PluginRuntime,
    });

    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "memory-core",
        name: "Memory Core",
        kind: "memory",
        source: "/virtual/memory-core/index.ts",
      }),
      register(api) {
        api.registerMemoryEmbeddingProvider({
          id: "demo-embedding",
          create: async () => ({ provider: null }),
        });
      },
    });

    expect(getRegisteredMemoryEmbeddingProvider("demo-embedding")).toEqual({
      adapter: expect.objectContaining({ id: "demo-embedding" }),
      ownerPluginId: "memory-core",
    });
  });
});
