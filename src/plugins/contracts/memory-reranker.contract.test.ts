// Memory reranker contract tests cover memory plugin reranker lifecycle behavior.
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it } from "vitest";
import {
  getRegisteredMemoryReranker,
  getRegisteredMemoryRerankerEntry,
} from "../../plugin-sdk/memory-core-host-engine-reranker.js";

describe("memory reranker registration", () => {
  it("rejects non-memory plugins that did not declare the capability contract", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "not-memory",
      name: "Not Memory",
      register(api) {
        api.registerMemoryReranker({
          id: "forbidden-reranker",
          rerank: async (params) =>
            params.documents.map((document) => ({ id: document.id, score: document.score })),
        });
      },
    });

    expect(getRegisteredMemoryReranker("forbidden-reranker")).toBeUndefined();
    const diagnostic = registry.registry.diagnostics.find(
      (entry) => entry.pluginId === "not-memory",
    );
    expect(diagnostic?.message).toBe(
      "plugin must own memory slot or declare contracts.memoryRerankers for reranker: forbidden-reranker",
    );
  });

  it("allows non-memory plugins that declare the capability contract", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "external-reranker",
      name: "External Reranker",
      contracts: {
        memoryRerankers: ["external-reranker"],
      },
      register(api) {
        api.registerMemoryReranker({
          id: "external-reranker",
          rerank: async (params) =>
            params.documents.map((document) => ({ id: document.id, score: document.score })),
        });
      },
    });

    const reranker = getRegisteredMemoryReranker("external-reranker");
    const entry = getRegisteredMemoryRerankerEntry("external-reranker");
    expect(reranker?.id).toBe("external-reranker");
    expect(entry?.ownerPluginId).toBe("external-reranker");
  });

  it("records the owning memory plugin id for registered rerankers", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "memory-core",
      name: "Memory Core",
      kind: "memory",
      register(api) {
        api.registerMemoryReranker({
          id: "demo-reranker",
          rerank: async (params) =>
            params.documents.map((document) => ({ id: document.id, score: document.score })),
        });
      },
    });

    const reranker = getRegisteredMemoryReranker("demo-reranker");
    const entry = getRegisteredMemoryRerankerEntry("demo-reranker");
    expect(reranker?.id).toBe("demo-reranker");
    expect(entry?.ownerPluginId).toBe("memory-core");
  });
});
