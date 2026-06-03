import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLiveModelProviderConfig,
  fetchLiveProviderModelIds,
  type LiveModelCatalogFetchGuard,
} from "./provider-catalog-live-runtime.js";
import { clearLiveCatalogCacheForTests } from "./provider-catalog-shared.js";
import type { ModelDefinitionConfig } from "./provider-model-shared.js";

function buildModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

function buildFetchGuard(body: unknown): {
  fetchGuard: LiveModelCatalogFetchGuard;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn(async () => undefined);
  const fetchGuard = vi.fn(async () => ({
    response: new Response(JSON.stringify(body)),
    finalUrl: "https://provider.example.test/v1/models",
    release,
  })) as unknown as LiveModelCatalogFetchGuard;
  return { fetchGuard, release };
}

describe("provider-catalog-live-runtime", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("fetches and dedupes OpenAI-style live model ids with resolved discovery auth", async () => {
    const { fetchGuard, release } = buildFetchGuard({
      data: [
        { id: "model-a", object: "model" },
        { id: "model-b", object: "model" },
        { id: "embedding-a", object: "embedding" },
        { id: "model-a", object: "model" },
      ],
    });

    await expect(
      fetchLiveProviderModelIds({
        providerId: "provider",
        endpoint: "https://provider.example.test/v1/models",
        apiKey: "PROVIDER_API_KEY",
        discoveryApiKey: "resolved-provider-key",
        fetchGuard,
        timeoutMs: 1234,
      }),
    ).resolves.toEqual(["model-a", "model-b"]);

    expect(fetchGuard).toHaveBeenCalledTimes(1);
    expect(fetchGuard.mock.calls[0]?.[0]).toMatchObject({
      url: "https://provider.example.test/v1/models",
      auditContext: "provider-model-discovery",
      timeoutMs: 1234,
    });
    expect(fetchGuard.mock.calls[0]?.[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer resolved-provider-key",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("supports top-level array bodies and custom row readers", async () => {
    const { fetchGuard } = buildFetchGuard([
      { slug: "custom-a" },
      { slug: "custom-b" },
      { slug: "custom-a" },
    ]);

    await expect(
      fetchLiveProviderModelIds({
        providerId: "custom",
        endpoint: "https://provider.example.test/v1/models",
        fetchGuard,
        readModelId: (row) =>
          row && typeof row === "object" && "slug" in row && typeof row.slug === "string"
            ? row.slug
            : undefined,
      }),
    ).resolves.toEqual(["custom-a", "custom-b"]);
  });

  it("caches live provider configs and falls back to static rows on failure", async () => {
    const { fetchGuard } = buildFetchGuard([
      { id: "model-b", object: "model" },
      { id: "unknown-model", object: "model" },
    ]);
    const providerConfig = {
      api: "openai-completions" as const,
      baseUrl: "https://provider.example.test/v1",
    };
    const models = [buildModel("model-a"), buildModel("model-b")];

    const first = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      apiKey: "PROVIDER_API_KEY",
      discoveryApiKey: "resolved-provider-key",
      fetchGuard,
      models,
      ttlMs: 60_000,
    });
    const second = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      apiKey: "PROVIDER_API_KEY",
      discoveryApiKey: "resolved-provider-key",
      fetchGuard,
      models,
      ttlMs: 60_000,
    });

    expect(fetchGuard).toHaveBeenCalledTimes(1);
    expect(first.apiKey).toBe("PROVIDER_API_KEY");
    expect(first.models.map((model) => model.id)).toEqual(["model-b"]);
    expect(second.models.map((model) => model.id)).toEqual(["model-b"]);

    clearLiveCatalogCacheForTests();
    vi.mocked(fetchGuard).mockRejectedValueOnce(new Error("network unavailable"));
    const fallback = await buildLiveModelProviderConfig({
      providerId: "provider",
      endpoint: "https://provider.example.test/v1/models",
      providerConfig,
      apiKey: "PROVIDER_API_KEY",
      discoveryApiKey: "resolved-provider-key",
      fetchGuard,
      models,
    });

    expect(fallback.apiKey).toBe("PROVIDER_API_KEY");
    expect(fallback.models.map((model) => model.id)).toEqual(["model-a", "model-b"]);
  });
});
