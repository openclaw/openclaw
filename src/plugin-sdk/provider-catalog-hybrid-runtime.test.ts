import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import type { LiveModelCatalogFetchGuard } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScopedHybridDynamicModelHooks,
  fetchModelsDevProviderSlice,
  ScopedHybridModelCache,
  type HybridModelDefinition,
} from "./provider-catalog-hybrid-runtime.js";

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: vi.fn(),
}));

function modelsDevDocument() {
  return {
    opencode: {
      models: {
        "claude-opus-5": {
          id: "claude-opus-5",
          reasoning: true,
          modalities: { input: ["text"] },
          limit: { context: 200_000, output: 32_768 },
          cost: { input: 1, output: 2 },
        },
      },
    },
  };
}

function model(id: string): HybridModelDefinition {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "p",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text"] as Array<"image" | "text">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  };
}

describe("ScopedHybridModelCache", () => {
  it("derives profile/direct/unscoped scope keys", () => {
    const cache = new ScopedHybridModelCache();
    expect(cache.scopeKey({ authProfileId: " opencode:a ", authProfileMode: "api-key" })).toBe(
      "profile:opencode:a",
    );
    expect(cache.scopeKey({ authProfileMode: "oauth" })).toBe("direct:oauth");
    expect(cache.scopeKey({})).toBe("unscoped");
  });

  it("keeps one credential's catalog invisible to another profile's lookups", () => {
    const cache = new ScopedHybridModelCache();
    const registry = {};
    cache.put({ modelRegistry: registry, authProfileId: "opencode:a" }, [model("only-in-a")]);
    cache.put({ modelRegistry: registry, authProfileId: "opencode:b" }, [model("only-in-b")]);
    expect(
      cache.get({
        modelRegistry: registry,
        modelId: "Only-In-A",
        authProfileId: "opencode:a",
      })?.id,
    ).toBe("only-in-a");
    expect(
      cache.get({
        modelRegistry: registry,
        modelId: "only-in-a",
        authProfileId: "opencode:b",
      }),
    ).toBeUndefined();
    expect(cache.get({ modelRegistry: registry, modelId: "only-in-b" })).toBeUndefined();
  });

  it("isolates lookups by model registry instance", () => {
    const cache = new ScopedHybridModelCache();
    const registryA = {};
    const registryB = {};
    cache.put({ modelRegistry: registryA }, [model("m")]);
    expect(cache.get({ modelRegistry: registryA, modelId: "m" })?.id).toBe("m");
    expect(cache.get({ modelRegistry: registryB, modelId: "m" })).toBeUndefined();
  });
});

describe("createScopedHybridDynamicModelHooks", () => {
  const mockedResolve = vi.mocked(resolveApiKeyForProvider);

  beforeEach(() => {
    mockedResolve.mockReset();
  });

  it("falls back to the sibling provider credential when the own provider has none", async () => {
    mockedResolve.mockImplementation(async (params: { provider: string }) =>
      params.provider === "own"
        ? { source: "none", mode: "api-key" }
        : { apiKey: "sib", source: "test", mode: "api-key" },
    );
    const hooks = createScopedHybridDynamicModelHooks({
      providerIds: ["own", "sibling"],
      buildLiveProviderConfig: async () => ({
        api: "openai-completions",
        baseUrl: "https://example.test/v1",
        models: [model("m")],
      }),
    });
    const registry = {};
    const prepared = await hooks.prepareDynamicModel({
      modelRegistry: registry,
      modelId: "m",
      authProfileId: "p:a",
    });
    expect(prepared?.id).toBe("m");
    expect(mockedResolve).toHaveBeenCalledTimes(2);
    expect(mockedResolve.mock.calls.map((call) => call[0]?.provider)).toEqual(["own", "sibling"]);
    expect(mockedResolve.mock.calls[1]?.[0]).toMatchObject({
      profileId: "p:a",
      lockedProfile: true,
    });
  });

  it("returns undefined when no provider yields a credential", async () => {
    mockedResolve.mockResolvedValue({ source: "none", mode: "api-key" });
    const buildLiveProviderConfig = vi.fn();
    const hooks = createScopedHybridDynamicModelHooks({
      providerIds: ["own", "sibling"],
      buildLiveProviderConfig,
    });
    await expect(
      hooks.prepareDynamicModel({ modelRegistry: {}, modelId: "m" }),
    ).resolves.toBeUndefined();
    expect(buildLiveProviderConfig).not.toHaveBeenCalled();
  });

  it("degrades builder failures to undefined instead of rejecting", async () => {
    mockedResolve.mockResolvedValue({ apiKey: "k", source: "test", mode: "api-key" });
    const hooks = createScopedHybridDynamicModelHooks({
      providerIds: ["own"],
      buildLiveProviderConfig: async () => {
        throw new Error("discovery offline");
      },
    });
    await expect(
      hooks.prepareDynamicModel({ modelRegistry: {}, modelId: "m" }),
    ).resolves.toBeUndefined();
    expect(hooks.resolveDynamicModel({ modelRegistry: {}, modelId: "m" })).toBeUndefined();
  });
});

describe("fetchModelsDevProviderSlice privacy and cache-admission gates", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("performs no third-party fetch without an authenticated catalog", async () => {
    const fetchGuard = vi.fn<LiveModelCatalogFetchGuard>();
    const slice = await fetchModelsDevProviderSlice({
      providerKey: "opencode",
      fetchGuard,
    });
    expect(slice.size).toBe(0);
    expect(fetchGuard).not.toHaveBeenCalled();
  });

  it("does not sticky-cache garbage 200 documents; a later good fetch replaces them", async () => {
    let stage: "empty" | "envelope" | "good" = "empty";
    const fetchGuard = vi.fn<LiveModelCatalogFetchGuard>(async (req) => ({
      response: new Response(
        JSON.stringify(
          stage === "good"
            ? modelsDevDocument()
            : stage === "envelope"
              ? { error: "quota exceeded", code: 1000 }
              : {},
        ),
      ),
      finalUrl: req.url,
      release: vi.fn(async () => undefined),
    }));
    const params = {
      providerKey: "opencode",
      apiKey: "k",
      discoveryApiKey: "k",
      fetchGuard,
    };
    expect((await fetchModelsDevProviderSlice(params)).size).toBe(0);
    stage = "envelope";
    expect((await fetchModelsDevProviderSlice(params)).size).toBe(0);
    stage = "good";
    const recovered = await fetchModelsDevProviderSlice(params);
    expect(recovered.has("claude-opus-5")).toBe(true);
  });

  it("keeps authenticated metadata fetches credential-free on the wire", async () => {
    const fetchGuard = vi.fn<LiveModelCatalogFetchGuard>(async (req) => ({
      response: new Response(JSON.stringify(modelsDevDocument())),
      finalUrl: req.url,
      release: vi.fn(async () => undefined),
    }));
    const slice = await fetchModelsDevProviderSlice({
      providerKey: "opencode",
      apiKey: "k",
      discoveryApiKey: "k",
      fetchGuard,
    });
    expect(slice.has("claude-opus-5")).toBe(true);
    // The auth fields gate the third-party fetch but must never reach it: the
    // default live-catalog header builder would emit them as a Bearer token.
    expect(fetchGuard).toHaveBeenCalledTimes(1);
    const headers = fetchGuard.mock.calls[0]?.[0].init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("authorization")).toBeNull();
    expect((headers as Headers).get("x-api-key")).toBeNull();
    expect((headers as Headers).get("accept")).toBe("application/json");
  });
});
