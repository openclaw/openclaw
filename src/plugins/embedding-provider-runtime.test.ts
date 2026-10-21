import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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

// mock-isolation: fixture capability providers avoid loading or invoking installed plugins.
vi.mock("./capability-provider-runtime.js", () => mocks);

let runtimeModule: typeof import("./embedding-provider-runtime.js");

function createCapabilityAdapter(id: string): EmbeddingProviderAdapter {
  return { id, create: async () => ({ provider: null }) };
}

function expectCapabilityLookup(providerId: string, cfg?: OpenClawConfig) {
  expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledWith({
    key: "embeddingProviders",
    providerId,
    cfg,
  });
}

function providerIds() {
  return runtimeModule.listEmbeddingProviders().map((adapter) => adapter.id);
}

const cfg: OpenClawConfig = {
  models: {
    providers: {
      "tenant-embeddings": {
        api: "openai-responses",
        baseUrl: "http://127.0.0.1:11434/v1",
        models: [],
      },
    },
  },
};

beforeEach(async () => {
  clearEmbeddingProviders();
  mocks.resolvePluginCapabilityProviders.mockReset().mockReturnValue([]);
  mocks.resolvePluginCapabilityProvider.mockReset().mockReturnValue(undefined);
  runtimeModule = await import("./embedding-provider-runtime.js");
});

afterEach(clearEmbeddingProviders);

describe("embedding provider runtime resolution", () => {
  it("falls back to declared capability adapters when the registry is cold", () => {
    mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("ollama")]);
    mocks.resolvePluginCapabilityProvider.mockReturnValue(createCapabilityAdapter("ollama"));

    expect(providerIds()).toEqual(["openai-compatible", "ollama"]);
    expect(runtimeModule.getEmbeddingProvider("ollama")?.id).toBe("ollama");
    expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(1);
    expectCapabilityLookup("ollama");
  });

  it("maps configured OpenAI-compatible provider ids to the core adapter when no exact provider exists", () => {
    expect(runtimeModule.getEmbeddingProvider("tenant-embeddings", cfg)?.id).toBe(
      "openai-compatible",
    );
    expectCapabilityLookup("tenant-embeddings", cfg);
  });

  it("prefers an exact plugin adapter over a configured OpenAI-compatible alias", () => {
    const adapter = createCapabilityAdapter("tenant-embeddings");
    mocks.resolvePluginCapabilityProvider.mockImplementation(({ providerId }) =>
      providerId === "tenant-embeddings" ? adapter : undefined,
    );

    expect(runtimeModule.getEmbeddingProvider("tenant-embeddings", cfg)).toBe(adapter);
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledOnce();
  });

  it("prefers registered adapters over declared capability fallback adapters with the same id", () => {
    const registered = createCapabilityAdapter("openai");
    registerEmbeddingProvider({ ...registered });
    mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("openai")]);

    expect(runtimeModule.getEmbeddingProvider("openai")).toStrictEqual(registered);
    expect(providerIds()).toEqual(["openai-compatible", "openai"]);
    expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(1);
  });
});
