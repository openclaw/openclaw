import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScopedHybridDynamicModelHooks,
  ScopedHybridModelCache,
  type HybridModelDefinition,
} from "./provider-catalog-hybrid-runtime.js";

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: vi.fn(),
}));

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
