import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMemoryEmbeddingProviders,
  registerMemoryEmbeddingProvider,
  type MemoryEmbeddingProviderAdapter,
} from "./memory-embedding-providers.js";

const mocks = vi.hoisted(() => ({
  resolvePluginCapabilityProviders: vi.fn<
    typeof import("./capability-provider-runtime.js").resolvePluginCapabilityProviders
  >(() => []),
}));

vi.mock("./capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: mocks.resolvePluginCapabilityProviders,
}));

let runtimeModule: typeof import("./memory-embedding-provider-runtime.js");

function createCapabilityAdapter(id: string): MemoryEmbeddingProviderAdapter {
  return {
    id,
    create: async () => ({ provider: null }),
  };
}

beforeEach(async () => {
  clearMemoryEmbeddingProviders();
  mocks.resolvePluginCapabilityProviders.mockReset();
  mocks.resolvePluginCapabilityProviders.mockReturnValue([]);
  runtimeModule = await import("./memory-embedding-provider-runtime.js");
});

afterEach(() => {
  clearMemoryEmbeddingProviders();
});

describe("memory embedding provider runtime resolution", () => {
  it("prefers registered adapters over capability fallback adapters", () => {
    registerMemoryEmbeddingProvider({
      id: "registered",
      create: async () => ({ provider: null }),
    });
    mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("capability")]);

    expect(runtimeModule.listMemoryEmbeddingProviders().map((adapter) => adapter.id)).toEqual([
      "registered",
    ]);
    expect(runtimeModule.getMemoryEmbeddingProvider("registered")?.id).toBe("registered");
    expect(mocks.resolvePluginCapabilityProviders).not.toHaveBeenCalled();
  });

  it("falls back to declared capability adapters when the registry is cold", () => {
    mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("ollama")]);

    expect(runtimeModule.listMemoryEmbeddingProviders().map((adapter) => adapter.id)).toEqual([
      "ollama",
    ]);
    expect(runtimeModule.getMemoryEmbeddingProvider("ollama")?.id).toBe("ollama");
    expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(2);
  });

  it("does not consult capability fallback once runtime adapters are registered", () => {
    registerMemoryEmbeddingProvider({
      id: "openai",
      create: async () => ({ provider: null }),
    });
    mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("ollama")]);

    expect(runtimeModule.getMemoryEmbeddingProvider("ollama")).toBeUndefined();
    expect(mocks.resolvePluginCapabilityProviders).not.toHaveBeenCalled();
  });
});
