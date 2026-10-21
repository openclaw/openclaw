// Register the catalog-cost contract in the auth-choice suite's existing setup fixture.
import { expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../../../config/types.models.js";
import * as fetchGuard from "../../../infra/net/fetch-guard.js";
import type { applyNonInteractiveAuthChoice } from "./auth-choice.js";

type ApplyChoice = (
  params: Partial<Parameters<typeof applyNonInteractiveAuthChoice>[0]>,
) => ReturnType<typeof applyNonInteractiveAuthChoice>;

export function registerCustomCatalogImportTests(applyChoice: ApplyChoice) {
  it("imports a large catalog without repeatedly traversing existing rows", async () => {
    let existingIdReads = 0;
    const existingModels: ModelDefinitionConfig[] = Array.from({ length: 64 }, (_, index) => ({
      get id() {
        existingIdReads += 1;
        return `existing-${index}`;
      },
      name: `Authored ${index}`,
      contextWindow: 65_536,
      maxTokens: 2048,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
    const discoveredIds = Array.from({ length: 64 }, (_, index) => `discovered-${index}`);
    vi.spyOn(fetchGuard, "fetchWithSsrFGuard").mockResolvedValue({
      response: Response.json({ data: discoveredIds.map((id) => ({ id })) }),
      finalUrl: "https://models.custom.local/v1/models",
      release: async () => {},
    });
    const result = await applyChoice({
      nextConfig: {
        models: {
          providers: {
            local: {
              baseUrl: "https://models.custom.local/v1",
              models: existingModels,
            },
          },
        },
        agents: { defaults: { model: { primary: "other/chat", fallbacks: ["other/fallback"] } } },
      },
      opts: { customBaseUrl: "https://models.custom.local/v1", customProviderId: "local" },
    });
    const catalog = result?.models?.providers?.local?.models ?? [];
    expect(catalog.map((model) => model.id)).toEqual([
      ...Array.from({ length: 64 }, (_, index) => `existing-${index}`),
      ...discoveredIds.toReversed(),
    ]);
    expect(catalog[0]).toMatchObject({ name: "Authored 0", contextWindow: 65_536 });
    expect(Object.keys(result?.agents?.defaults?.models ?? {})).toHaveLength(64);
    expect(result?.agents?.defaults?.model).toEqual({
      primary: "local/discovered-0",
      fallbacks: ["other/fallback"],
    });
    expect(existingIdReads).toBeLessThanOrEqual(8 * (64 + 64));
  });
}
