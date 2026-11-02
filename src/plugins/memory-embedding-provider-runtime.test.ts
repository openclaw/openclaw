import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { EmbeddingProviderRuntime } from "./embedding-provider-types.js";
import {
  clearEmbeddingProviders,
  registerEmbeddingProvider,
  type EmbeddingProviderAdapter,
} from "./embedding-providers.js";
import {
  getMemoryEmbeddingProvider as getProvider,
  listMemoryEmbeddingProviders as listProviders,
} from "./memory-embedding-provider-runtime.js";
import type { MemoryEmbeddingProviderAdapter } from "./memory-embedding-providers.js";

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
  expect(getProvider("ollama-custom", config)?.id).toBe(ollamaAdapter.id);
  expectCapabilityLookup("ollama-custom", config);
  if (registered) {
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledTimes(1);
  } else {
    expectCapabilityLookup("ollama", config);
  }
});

it("returns generic provider, runtime, and identity objects unchanged", async () => {
  const runtime = {
    id: "generic",
    batchEmbed: async (options) => options.chunks.map(() => [5, 6]),
  } satisfies EmbeddingProviderRuntime;
  const runtimeFactsKey = Symbol.for("openclaw.localEmbeddingRuntimeFacts");
  const provider = {
    id: "generic",
    model: "generic-model",
    embed: async () => [1, 2],
    embedBatch: async (inputs: unknown[]) => inputs.map(() => [3, 4]),
  };
  const runtimeFacts = () => ({ model: "generic-model" });
  Object.defineProperty(provider, runtimeFactsKey, { value: runtimeFacts });
  const create = vi.fn(async () => ({ provider, runtime }));
  registerEmbeddingProvider({
    id: "generic",
    defaultModel: "generic-default",
    transport: "local",
    resolveIndexIdentity: (options) => ({
      model: options.model,
      cacheKeyData: { dimensions: options.dimensions },
    }),
    create,
  });

  const adapter = getProvider("generic");
  expect(adapter).toMatchObject({
    id: "generic",
    defaultModel: "generic-default",
    transport: "local",
  });
  expect(listProviders().map((entry) => entry.id)).toContain("generic");
  const options = { config: {}, model: "generic-model", dimensions: 7 };
  expect(adapter?.resolveIndexIdentity?.(options)).toEqual({
    model: "generic-model",
    cacheKeyData: { dimensions: 7 },
  });

  const result = await adapter?.create(options);
  expect(create).toHaveBeenCalledWith(options);
  expect(result?.runtime).toBe(runtime);
  await expect(
    result?.runtime?.batchEmbed?.({
      agentId: "main",
      chunks: [{ text: "batch document" }],
      wait: true,
      concurrency: 1,
      pollIntervalMs: 1000,
      timeoutMs: 10_000,
      debug: () => {},
    }),
  ).resolves.toEqual([[5, 6]]);
  expect(result?.provider).toBe(provider);
  expect(Reflect.get(provider, runtimeFactsKey)).toBe(runtimeFacts);
});

it("preserves private memory metadata through generic registration", () => {
  const memoryAdapter = {
    id: "migrated-memory",
    supportsMultimodalEmbeddings: ({ model }: { model: string }) => model === "multimodal",
    shouldContinueAutoSelection: () => true,
    create: async () => ({ provider: null }),
  } satisfies MemoryEmbeddingProviderAdapter;
  registerEmbeddingProvider(memoryAdapter);

  const adapter = getProvider("migrated-memory");
  expect(adapter).toBe(memoryAdapter);
  expect(adapter?.supportsMultimodalEmbeddings?.({ model: "multimodal" })).toBe(true);
  expect(adapter?.shouldContinueAutoSelection?.(new Error("setup"))).toBe(true);
});
