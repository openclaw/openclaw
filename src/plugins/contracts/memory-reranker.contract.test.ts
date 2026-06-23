// Memory reranker contract tests cover memory plugin reranker lifecycle behavior.
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearMemoryRerankers,
  getRegisteredMemoryReranker,
  getRegisteredMemoryRerankerEntry,
  registerMemoryReranker,
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

describe("MMR upgrade path", () => {
  afterEach(() => {
    clearMemoryRerankers();
  });

  it("before plugin registers: getRegisteredMemoryReranker returns undefined", () => {
    // Registry is empty (cleared by afterEach from any prior test). Proves that
    // a configured reranker stage doesn't phantom-resolve to a stale or default
    // reranker when the plugin is absent.
    expect(getRegisteredMemoryReranker("memory-mmr")).toBeUndefined();
  });

  it("after plugin registers: getRegisteredMemoryReranker returns the reranker", () => {
    registerMemoryReranker({
      id: "memory-mmr",
      rerank: async (params) =>
        params.documents.map((document) => ({ id: document.id, score: document.score })),
    });

    expect(getRegisteredMemoryReranker("memory-mmr")?.id).toBe("memory-mmr");
  });

  it("after reload clears registry: lookup reverts to undefined (reload doesn't silently break reranking)", () => {
    // Simulates plugin being loaded, then a reload/restart clearing the registry
    // before the plugin re-registers. createReranker will receive undefined and
    // fall through to score-sorted results rather than calling a stale adapter.
    registerMemoryReranker({
      id: "memory-mmr",
      rerank: async (params) =>
        params.documents.map((document) => ({ id: document.id, score: document.score })),
    });

    clearMemoryRerankers();

    expect(getRegisteredMemoryReranker("memory-mmr")).toBeUndefined();
  });
});
