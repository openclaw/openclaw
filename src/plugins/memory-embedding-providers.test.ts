import { afterEach, describe, expect, it } from "vitest";
import {
  clearMemoryEmbeddingProviders,
  getMemoryEmbeddingProvider,
  getRegisteredMemoryEmbeddingProvider,
  listMemoryEmbeddingProviders,
  listRegisteredMemoryEmbeddingProviders,
  registerMemoryEmbeddingProvider,
  restoreRegisteredMemoryEmbeddingProviders,
  restoreMemoryEmbeddingProviders,
  type MemoryEmbeddingProviderAdapter,
} from "./memory-embedding-providers.js";

function createAdapter(id: string): MemoryEmbeddingProviderAdapter {
  return {
    id,
    create: async () => ({ provider: null }),
  };
}

afterEach(() => {
  clearMemoryEmbeddingProviders();
});

describe("memory embedding provider registry", () => {
  it("registers and lists adapters in insertion order", () => {
    registerMemoryEmbeddingProvider(createAdapter("alpha"));
    registerMemoryEmbeddingProvider(createAdapter("beta"));

    expect(getMemoryEmbeddingProvider("alpha")?.id).toBe("alpha");
    expect(listMemoryEmbeddingProviders().map((adapter) => adapter.id)).toEqual(["alpha", "beta"]);
  });

  it("restores a previous snapshot", () => {
    const alpha = createAdapter("alpha");
    const beta = createAdapter("beta");
    registerMemoryEmbeddingProvider(alpha);

    restoreMemoryEmbeddingProviders([beta]);

    expect(getMemoryEmbeddingProvider("alpha")).toBeUndefined();
    expect(getMemoryEmbeddingProvider("beta")).toBe(beta);
  });

  it("tracks owner plugin ids in registered snapshots", () => {
    const alpha = createAdapter("alpha");
    registerMemoryEmbeddingProvider(alpha, { ownerPluginId: "memory-core" });

    expect(getRegisteredMemoryEmbeddingProvider("alpha")).toEqual({
      adapter: alpha,
      ownerPluginId: "memory-core",
    });
    expect(listRegisteredMemoryEmbeddingProviders()).toEqual([
      {
        adapter: alpha,
        ownerPluginId: "memory-core",
      },
    ]);
  });

  it("restores registered snapshots with owner metadata", () => {
    const beta = createAdapter("beta");

    restoreRegisteredMemoryEmbeddingProviders([
      {
        adapter: beta,
        ownerPluginId: "memory-core",
      },
    ]);

    expect(getRegisteredMemoryEmbeddingProvider("beta")).toEqual({
      adapter: beta,
      ownerPluginId: "memory-core",
    });
  });

  it("clears the registry", () => {
    registerMemoryEmbeddingProvider(createAdapter("alpha"));

    clearMemoryEmbeddingProviders();

    expect(listMemoryEmbeddingProviders()).toEqual([]);
  });
});
