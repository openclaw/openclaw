import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearEmbeddingProviders,
  registerEmbeddingProvider,
  type EmbeddingProviderAdapter,
} from "./embedding-providers.js";

const mocks = vi.hoisted(() => ({
  resolvePluginCapabilityProviders: vi.fn<
    typeof import("./capability-provider-runtime.js").resolvePluginCapabilityProviders
  >(() => []),
  resolvePluginCapabilityProvider: vi.fn<
    typeof import("./capability-provider-runtime.js").resolvePluginCapabilityProvider
  >(() => undefined),
}));

vi.mock("./capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProvider: mocks.resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviders: mocks.resolvePluginCapabilityProviders,
}));

let runtimeModule: typeof import("./embedding-provider-runtime.js");

function createCapabilityAdapter(id: string): EmbeddingProviderAdapter {
  return {
    id,
    create: async () => ({ provider: null }),
  };
}

beforeEach(async () => {
  clearEmbeddingProviders();
  mocks.resolvePluginCapabilityProviders.mockReset();
  mocks.resolvePluginCapabilityProviders.mockReturnValue([]);
  mocks.resolvePluginCapabilityProvider.mockReset();
  mocks.resolvePluginCapabilityProvider.mockReturnValue(undefined);
  runtimeModule = await import("./embedding-provider-runtime.js");
});

afterEach(() => {
  clearEmbeddingProviders();
});

describe("embedding provider runtime resolution", () => {
  it("merges registered and declared capability fallback adapters", () => {
    registerEmbeddingProvider({
      id: "registered",
      create: async () => ({ provider: null }),
    });
    mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("capability")]);

    expect(runtimeModule.listEmbeddingProviders().map((adapter) => adapter.id)).toEqual([
      "registered",
      "capability",
    ]);
    expect(runtimeModule.getEmbeddingProvider("registered")?.id).toBe("registered");
    expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(1);
  });

  it("falls back to declared capability adapters when the registry is cold", () => {
    mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("ollama")]);
    mocks.resolvePluginCapabilityProvider.mockReturnValue(createCapabilityAdapter("ollama"));

    expect(runtimeModule.listEmbeddingProviders().map((adapter) => adapter.id)).toEqual(["ollama"]);
    expect(runtimeModule.getEmbeddingProvider("ollama")?.id).toBe("ollama");
    expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(1);
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledWith({
      key: "embeddingProviders",
      providerId: "ollama",
      cfg: undefined,
    });
  });

  it("resolves configured provider aliases through their api owner", () => {
    const registered = {
      id: "openai-compatible",
      create: async () => ({ provider: null }),
    } satisfies EmbeddingProviderAdapter;
    registerEmbeddingProvider(registered);

    expect(
      runtimeModule.getEmbeddingProvider("tenant-embeddings", {
        models: {
          providers: {
            "tenant-embeddings": {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:11434/v1",
              models: [],
            },
          },
        },
      })?.id,
    ).toBe("openai-compatible");
  });

  it("loads declared capability adapters through configured provider aliases", () => {
    const adapter = createCapabilityAdapter("openai-compatible");
    mocks.resolvePluginCapabilityProvider.mockImplementation(({ providerId }) =>
      providerId === "openai-compatible" ? adapter : undefined,
    );

    expect(
      runtimeModule.getEmbeddingProvider("tenant-embeddings", {
        models: {
          providers: {
            "tenant-embeddings": {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:11434/v1",
              models: [],
            },
          },
        },
      })?.id,
    ).toBe("openai-compatible");
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledWith({
      key: "embeddingProviders",
      providerId: "tenant-embeddings",
      cfg: expect.any(Object),
    });
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledWith({
      key: "embeddingProviders",
      providerId: "openai-compatible",
      cfg: expect.any(Object),
    });
  });

  it("maps baseUrl-only configured provider aliases to OpenAI-compatible embeddings", () => {
    const adapter = createCapabilityAdapter("openai-compatible");
    mocks.resolvePluginCapabilityProvider.mockImplementation(({ providerId }) =>
      providerId === "openai-compatible" ? adapter : undefined,
    );

    expect(
      runtimeModule.getEmbeddingProvider("tenant-embeddings", {
        models: {
          providers: {
            "tenant-embeddings": {
              baseUrl: "http://127.0.0.1:11434/v1",
              models: [],
            },
          },
        },
      })?.id,
    ).toBe("openai-compatible");
  });

  it("prefers registered adapters over declared capability fallback adapters with the same id", () => {
    const registered = {
      id: "openai",
      create: async () => ({ provider: null }),
    } satisfies EmbeddingProviderAdapter;
    registerEmbeddingProvider({
      ...registered,
    });
    mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("openai")]);

    expect(runtimeModule.getEmbeddingProvider("openai")).toStrictEqual(registered);
    expect(runtimeModule.listEmbeddingProviders().map((adapter) => adapter.id)).toEqual(["openai"]);
    expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(1);
  });
});
