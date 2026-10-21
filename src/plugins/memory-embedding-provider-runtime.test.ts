import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearEmbeddingProviders,
  registerEmbeddingProvider,
  type EmbeddingProviderAdapter,
} from "./embedding-providers.js";
import {
  getMemoryEmbeddingProvider as getProvider,
  listMemoryEmbeddingProviders as listProviders,
} from "./memory-embedding-provider-runtime.js";

const mocks = vi.hoisted(() => ({
  resolvePluginCapabilityProviders: vi.fn<
    typeof import("./capability-provider-runtime.js").resolvePluginCapabilityProviders
  >(() => []),
  resolvePluginCapabilityProvider: vi.fn<
    typeof import("./capability-provider-runtime.js").resolvePluginCapabilityProvider
  >(() => undefined),
}));

// mock-isolation: Control capability lookup without loading the active plugin registry.
vi.mock("./capability-provider-runtime.js", () => mocks);

function createCapabilityAdapter(id: string): EmbeddingProviderAdapter {
  return { id, create: async () => ({ provider: null }) };
}

function configuredOllama(id: string, baseUrl: string): OpenClawConfig {
  return { models: { providers: { [id]: { api: "ollama", baseUrl, models: [] } } } };
}

function expectCapabilityLookup(providerId: string, cfg?: OpenClawConfig) {
  expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledWith({
    key: "embeddingProviders",
    providerId,
    cfg,
  });
}

beforeEach(() => {
  clearEmbeddingProviders();
  mocks.resolvePluginCapabilityProviders.mockReset().mockReturnValue([]);
  mocks.resolvePluginCapabilityProvider.mockReset().mockReturnValue(undefined);
});

afterEach(clearEmbeddingProviders);

it("falls back to declared capability adapters when the registry is cold", () => {
  mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("ollama")]);
  mocks.resolvePluginCapabilityProvider.mockReturnValue(createCapabilityAdapter("ollama"));

  expect(listProviders().map(({ id }) => id)).toEqual(["openai-compatible", "ollama"]);
  expect(getProvider("ollama")?.id).toBe("ollama");
  expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(1);
  expectCapabilityLookup("ollama");
});

it.each([false, true])("resolves a configured API with registered adapter=%s", (registered) => {
  const ollamaAdapter = createCapabilityAdapter("ollama");
  const config = configuredOllama("ollama-custom", "http://ollama-host:11435");
  if (registered) {
    registerEmbeddingProvider(ollamaAdapter);
  } else {
    mocks.resolvePluginCapabilityProvider.mockImplementation(({ providerId }) =>
      providerId === "ollama" ? ollamaAdapter : undefined,
    );
  }
  expect(getProvider("ollama-custom", config)).toBe(ollamaAdapter);
  expectCapabilityLookup("ollama-custom", config);
  if (registered) {
    expect(listProviders()).toContain(ollamaAdapter);
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledTimes(1);
  } else {
    expectCapabilityLookup("ollama", config);
  }
});
