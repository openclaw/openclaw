import { describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import {
  buildOpenAICompatibleLiveProviderCatalog,
  buildOpenAICompatibleProviderFamilyCatalog,
} from "./provider-catalog-live-runtime.js";
import type { ProviderCatalogContext } from "./provider-catalog-shared.js";

describe("provider catalog live-runtime scope", () => {
  it("scopes shared family credentials and construction to selected entries", async () => {
    const buildPrimary = vi.fn(() => ({
      baseUrl: "not-a-url",
      api: "openai-completions" as const,
      models: [],
    }));
    const buildPlan = vi.fn(() => ({
      baseUrl: "not-a-url",
      api: "openai-completions" as const,
      models: [],
    }));
    const family = buildOpenAICompatibleProviderFamilyCatalog({
      credentialProviderId: "family",
      entries: [
        {
          id: "family",
          label: "Family",
          baseUrl: "not-a-url",
          models: [],
          buildProvider: buildPrimary,
        },
        {
          id: "family-plan",
          label: "Family Plan",
          baseUrl: "not-a-url",
          models: [],
          buildProvider: buildPlan,
        },
      ],
      staticCatalog: async () => ({ providers: {} }),
      augmentModelCatalog: vi.fn(),
    });

    const resolveProviderApiKey = vi.fn(() => ({ apiKey: "family-key" }));
    const context: ProviderCatalogContext = {
      providerIds: ["family-plan"],
      config: {},
      env: {},
      resolveProviderApiKey,
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    };
    const result = await family.catalog.run(context);

    expect(result && "providers" in result ? Object.keys(result.providers) : []).toEqual([
      "family-plan",
    ]);
    expect(buildPrimary).not.toHaveBeenCalled();
    expect(buildPlan).toHaveBeenCalledOnce();
    expect(result?.outcomes).toEqual([]);

    resolveProviderApiKey.mockClear();
    await expect(family.catalog.run({ ...context, providerIds: ["other"] })).resolves.toBeNull();
    expect(resolveProviderApiKey).not.toHaveBeenCalled();
  });

  it.each(["skipped", "advisory-ready", "advisory-empty", "advisory-unavailable"] as const)(
    "keeps %s rows outside authoritative discovery outcomes",
    async (kind) => {
      const provider: ModelProviderConfig = {
        baseUrl: "https://custom.example/v1",
        api: "openai-completions",
        models: [
          {
            id: "known",
            name: "Known",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32768,
            maxTokens: 4096,
          },
        ],
      };
      const fetchGuard = vi.fn(async () => ({
        response: Response.json(
          { data: kind === "advisory-ready" ? [{ id: "known" }] : [] },
          { status: kind === "advisory-unavailable" ? 503 : 200 },
        ),
        finalUrl: `${provider.baseUrl}/models`,
        release: async () => {},
      }));
      const result = await buildOpenAICompatibleLiveProviderCatalog({
        providerId: `catalog-${kind}`,
        providerConfig: provider,
        fetchGuard,
        modelDiscovery:
          kind === "skipped"
            ? {
                endpointUrl: {
                  url: "https://catalog.example/models",
                  requireBaseUrl: "https://canonical.example/v1",
                },
              }
            : undefined,
      });
      expect(result).toEqual({ provider, outcomes: [] });
      expect(fetchGuard).toHaveBeenCalledTimes(kind === "skipped" ? 0 : 1);
    },
  );
});
