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

const MEMORY_EMBEDDING_PROVIDERS_KEY = Symbol.for("openclaw.memoryEmbeddingProviders");

function createAdapter(id: string): MemoryEmbeddingProviderAdapter {
  return {
    id,
    create: async () => ({ provider: null }),
  };
}

function expectRegisteredProviderEntry(
  id: string,
  entry: {
    adapter: MemoryEmbeddingProviderAdapter;
    ownerPluginId?: string;
  },
) {
  expect(getRegisteredMemoryEmbeddingProvider(id)).toEqual(entry);
}

function createOwnedAdapterEntry(id: string) {
  return {
    adapter: createAdapter(id),
    ownerPluginId: "memory-core",
  };
}

function expectMemoryEmbeddingProviderIds(expectedIds: readonly string[]) {
  expect(listMemoryEmbeddingProviders().map((adapter) => adapter.id)).toEqual([...expectedIds]);
}

afterEach(() => {
  clearMemoryEmbeddingProviders();
});

describe("memory embedding provider registry", () => {
  it("registers and lists adapters in insertion order", () => {
    registerMemoryEmbeddingProvider(createAdapter("alpha"));
    registerMemoryEmbeddingProvider(createAdapter("beta"));

    expect(getMemoryEmbeddingProvider("alpha")?.id).toBe("alpha");
    expectMemoryEmbeddingProviderIds(["alpha", "beta"]);
  });

  it("restores a previous snapshot", () => {
    const alpha = createAdapter("alpha");
    const beta = createAdapter("beta");
    registerMemoryEmbeddingProvider(alpha);

    restoreMemoryEmbeddingProviders([beta]);

    expect(getMemoryEmbeddingProvider("alpha")).toBeUndefined();
    expect(getMemoryEmbeddingProvider("beta")).toBe(beta);
  });

  it.each([
    {
      name: "tracks owner plugin ids in registered snapshots",
      entry: createOwnedAdapterEntry("alpha"),
      setup: (entry: { adapter: MemoryEmbeddingProviderAdapter; ownerPluginId?: string }) =>
        registerMemoryEmbeddingProvider(entry.adapter, { ownerPluginId: entry.ownerPluginId }),
      expectList: true,
    },
    {
      name: "restores registered snapshots with owner metadata",
      entry: createOwnedAdapterEntry("beta"),
      setup: (entry: { adapter: MemoryEmbeddingProviderAdapter; ownerPluginId?: string }) =>
        restoreRegisteredMemoryEmbeddingProviders([entry]),
      expectList: false,
    },
  ] as const)("$name", ({ entry, setup, expectList }) => {
    const expectedEntry = entry;

    setup(entry);

    expectRegisteredProviderEntry(entry.adapter.id, expectedEntry);
    if (expectList) {
      expect(listRegisteredMemoryEmbeddingProviders()).toEqual([expectedEntry]);
    }
  });

  it("clears the registry", () => {
    registerMemoryEmbeddingProvider(createAdapter("alpha"));

    clearMemoryEmbeddingProviders();

    expectMemoryEmbeddingProviderIds([]);
  });

  it("stores adapters in a process-global singleton map", () => {
    const alpha = createAdapter("alpha");
    registerMemoryEmbeddingProvider(alpha, { ownerPluginId: "memory-core" });

    const globalRegistry = (globalThis as Record<PropertyKey, unknown>)[
      MEMORY_EMBEDDING_PROVIDERS_KEY
    ] as Map<string, { adapter: MemoryEmbeddingProviderAdapter; ownerPluginId?: string }>;

    expect(globalRegistry.get("alpha")).toEqual({
      adapter: alpha,
      ownerPluginId: "memory-core",
    });
  });
});
