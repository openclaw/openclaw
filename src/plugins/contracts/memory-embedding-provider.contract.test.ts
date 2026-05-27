import { describe, expect, it } from "vitest";
import { getRegisteredMemoryEmbeddingProvider } from "../memory-embedding-providers.js";
import { createPluginRegistryFixture, registerVirtualTestPlugin } from "./testkit.js";

describe("memory embedding provider registration", () => {
  it("only allows memory plugins to register adapters", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "not-memory",
      name: "Not Memory",
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
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "memory-core",
      name: "Memory Core",
      kind: "memory",
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
