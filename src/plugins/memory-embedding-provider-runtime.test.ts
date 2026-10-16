// Covers memory embedding provider runtime hooks from plugins.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { EmbeddingBatchOptions } from "./embedding-provider-runtime-types.js";
import type { EmbeddingProviderRuntime } from "./embedding-provider-types.js";
import {
  clearEmbeddingProviders,
  registerEmbeddingProvider,
  type EmbeddingProviderAdapter,
} from "./embedding-providers.js";
import type { MemoryEmbeddingProviderAdapter } from "./memory-embedding-providers.js";

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

let runtimeModule: typeof import("./memory-embedding-provider-runtime.js");

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

beforeEach(async () => {
  clearEmbeddingProviders();
  mocks.resolvePluginCapabilityProviders.mockReset();
  mocks.resolvePluginCapabilityProviders.mockReturnValue([]);
  mocks.resolvePluginCapabilityProvider.mockReset();
  mocks.resolvePluginCapabilityProvider.mockReturnValue(undefined);
  runtimeModule = await import("./memory-embedding-provider-runtime.js");
});

afterEach(() => {
  clearEmbeddingProviders();
});

describe("memory embedding provider runtime resolution", () => {
  it("falls back to declared capability adapters when the registry is cold", () => {
    mocks.resolvePluginCapabilityProviders.mockReturnValue([createCapabilityAdapter("ollama")]);
    mocks.resolvePluginCapabilityProvider.mockReturnValue(createCapabilityAdapter("ollama"));

    expect(runtimeModule.listMemoryEmbeddingProviders().map((adapter) => adapter.id)).toEqual([
      "openai-compatible",
      "ollama",
    ]);
    expect(runtimeModule.getMemoryEmbeddingProvider("ollama")?.id).toBe("ollama");
    expect(mocks.resolvePluginCapabilityProviders).toHaveBeenCalledTimes(1);
    expectCapabilityLookup("ollama");
  });

  it("uses a configured provider api as the memory adapter owner", () => {
    const ollamaAdapter = createCapabilityAdapter("ollama");
    const config = configuredOllama("ollama-5080", "http://10.0.0.8:11435");
    mocks.resolvePluginCapabilityProvider.mockImplementation(({ providerId }) =>
      providerId === "ollama" ? ollamaAdapter : undefined,
    );

    expect(runtimeModule.getMemoryEmbeddingProvider("ollama-5080", config)?.id).toBe(
      ollamaAdapter.id,
    );
    expectCapabilityLookup("ollama-5080", config);
    expectCapabilityLookup("ollama", config);
  });

  it("uses registered adapters through a configured provider api", () => {
    const ollamaAdapter = createCapabilityAdapter("ollama");
    registerEmbeddingProvider(ollamaAdapter);
    const config = configuredOllama("ollama-gpu1", "http://ollama-host:11435");

    expect(runtimeModule.getMemoryEmbeddingProvider("ollama-gpu1", config)?.id).toBe(
      ollamaAdapter.id,
    );
    expect(mocks.resolvePluginCapabilityProvider).toHaveBeenCalledTimes(1);
    expectCapabilityLookup("ollama-gpu1", config);
  });

  it("returns generic provider, runtime, and identity objects unchanged", async () => {
    const close = vi.fn();
    const embed = vi.fn(async () => [1, 2]);
    const embedBatch = vi.fn(async (inputs: unknown[]) => inputs.map(() => [3, 4]));
    const batchEmbed = vi.fn(async (options: EmbeddingBatchOptions) =>
      options.chunks.map(() => [5, 6]),
    );
    const runtime = {
      id: "generic",
      inlineQueryTimeoutMs: 1234,
      sourceWideBatchEmbed: true,
      batchEmbed,
    } satisfies EmbeddingProviderRuntime;
    const runtimeFactsKey = Symbol.for("openclaw.localEmbeddingRuntimeFacts");
    const provider = {
      id: "generic",
      model: "generic-model",
      maxInputTokens: 2048,
      embed,
      embedBatch,
      close,
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

    const adapter = runtimeModule.getMemoryEmbeddingProvider("generic");
    expect(adapter).toMatchObject({
      id: "generic",
      defaultModel: "generic-default",
      transport: "local",
    });
    expect(runtimeModule.listMemoryEmbeddingProviders().map((entry) => entry.id)).toContain(
      "generic",
    );
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
      autoSelectPriority: 20,
      allowExplicitWhenConfiguredAuto: true,
      supportsMultimodalEmbeddings: ({ model }: { model: string }) => model === "multimodal",
      shouldContinueAutoSelection: () => true,
      create: async () => ({ provider: null }),
    } satisfies MemoryEmbeddingProviderAdapter;
    registerEmbeddingProvider(memoryAdapter);

    const adapter = runtimeModule.getMemoryEmbeddingProvider("migrated-memory");
    expect(adapter).toBe(memoryAdapter);
    expect(adapter?.supportsMultimodalEmbeddings?.({ model: "multimodal" })).toBe(true);
    expect(adapter?.shouldContinueAutoSelection?.(new Error("setup"))).toBe(true);
  });
});
