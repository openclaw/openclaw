import { describe, expect, it } from "vitest";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../../../test/helpers/plugins/contracts-testkit.js";
import { getRegisteredMemoryEmbeddingProvider } from "../memory-embedding-providers.js";

describe("memory embedding provider registration", () => {
  it("rejects non-memory plugins that did not declare the capability contract", () => {
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
          message:
            "plugin must own memory slot or declare contracts.memoryEmbeddingProviders for adapter: forbidden",
        }),
      ]),
    );
  });

  it("allows non-memory plugins that declare the capability contract", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "ollama",
      name: "Ollama",
      contracts: {
        memoryEmbeddingProviders: ["ollama"],
      },
      register(api) {
        api.registerMemoryEmbeddingProvider({
          id: "ollama",
          create: async () => ({ provider: null }),
        });
      },
    });

    expect(getRegisteredMemoryEmbeddingProvider("ollama")).toEqual({
      adapter: expect.objectContaining({ id: "ollama" }),
      ownerPluginId: "ollama",
    });
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
