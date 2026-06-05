import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { listMemoryRerankProviders, resetMemoryPluginState } from "../memory-state.js";

afterEach(() => {
  resetMemoryPluginState();
});

describe("memory rerank provider registration", () => {
  it("rejects plugins that did not declare the capability contract", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "not-rerank",
      name: "Not Rerank",
      register(api) {
        api.registerMemoryRerankProvider({ rerank: async () => [] });
      },
    });

    expect(listMemoryRerankProviders()).toHaveLength(0);
    const diagnostic = registry.registry.diagnostics.find(
      (entry) => entry.pluginId === "not-rerank",
    );
    expect(diagnostic?.message).toBe(
      "plugin must declare contracts.memoryRerankProviders to register a memory rerank provider",
    );
  });

  it("allows plugins that declare the capability contract", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "cross-encoder",
      name: "Cross Encoder",
      contracts: {
        memoryRerankProviders: ["cross-encoder"],
      },
      register(api) {
        api.registerMemoryRerankProvider({ rerank: async () => [] });
      },
    });

    expect(listMemoryRerankProviders().map((entry) => entry.pluginId)).toEqual(["cross-encoder"]);
  });

  it("warns and keeps the existing owner when a second declaring plugin claims the exclusive slot", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "first-reranker",
      name: "First Reranker",
      contracts: { memoryRerankProviders: ["first-reranker"] },
      register(api) {
        api.registerMemoryRerankProvider({ rerank: async () => [] });
      },
    });
    registerVirtualTestPlugin({
      registry,
      config,
      id: "second-reranker",
      name: "Second Reranker",
      contracts: { memoryRerankProviders: ["second-reranker"] },
      register(api) {
        api.registerMemoryRerankProvider({ rerank: async () => [] });
      },
    });

    expect(listMemoryRerankProviders().map((entry) => entry.pluginId)).toEqual(["first-reranker"]);
    const diagnostic = registry.registry.diagnostics.find(
      (entry) => entry.pluginId === "second-reranker",
    );
    expect(diagnostic?.message).toBe(
      "memory rerank provider already registered (owner: first-reranker)",
    );
  });
});
