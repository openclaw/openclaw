import { describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import { normalizePluginDiscoveryResult, runProviderCatalog } from "./provider-discovery.js";
import type { ProviderCatalogOutcome, ProviderCatalogResult, ProviderPlugin } from "./types.js";

const config: ModelProviderConfig = { baseUrl: "https://catalog.example/v1", models: [] };

async function discover(result: ProviderCatalogResult, providerIds?: readonly string[]) {
  const outcomes: ProviderCatalogOutcome[] = [];
  const provider: ProviderPlugin = {
    id: "Catalog",
    label: "Catalog",
    aliases: ["catalog-alias"],
    auth: [],
    catalog: { run: async () => result },
  };
  const accepted = await runProviderCatalog({
    provider,
    providerIds,
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    reportCatalogOutcome: (outcome) => outcomes.push(outcome),
  });
  return { accepted, outcomes, provider };
}

describe("legacy catalog discovery outcomes", () => {
  it.each([
    { providerIds: undefined, expected: ["catalog", "catalog-alias"] },
    { providerIds: ["CATALOG"], expected: ["catalog"] },
    { providerIds: [], expected: [] },
  ])(
    "records successful empty inventories within scope $providerIds",
    async ({ providerIds, expected }) => {
      const { outcomes } = await discover({ provider: config }, providerIds);
      expect(outcomes).toEqual(expected.map((provider) => ({ provider, status: "ready" })));
    },
  );

  it("records only returned family identities", async () => {
    const { outcomes } = await discover({ providers: { "CATALOG-PLAN": config } });
    expect(outcomes).toEqual([{ provider: "catalog-plan", status: "ready" }]);
  });

  it.each([null, undefined, { providers: {} }])(
    "does not invent discovery for %j",
    async (result) => {
      const { outcomes } = await discover(result);
      expect(outcomes).toEqual([]);
    },
  );

  it.each([
    { name: "empty", outcomes: [] },
    { name: "unavailable", outcomes: [{ provider: "catalog", status: "unavailable" }] },
    {
      name: "profile-owned",
      outcomes: [{ provider: "catalog", profileId: "selected", status: "ready" }],
    },
  ] satisfies Array<{ name: string; outcomes: ProviderCatalogOutcome[] }>)(
    "preserves an explicit $name outcome statement",
    async ({ outcomes }) => {
      const result = await discover({ provider: config, outcomes });
      expect(result.outcomes).toEqual(outcomes);
    },
  );

  it("does not turn an unreadable outcome statement into success", async () => {
    const { outcomes } = await discover({
      provider: config,
      get outcomes(): readonly ProviderCatalogOutcome[] {
        throw new Error("outcomes unavailable");
      },
    });
    expect(outcomes).toEqual([]);
  });

  it("does not accept outcome properties from a non-record catalog result", async () => {
    const statement: ProviderCatalogOutcome[] = [{ provider: "catalog", status: "ready" }];
    const { outcomes } = await discover(
      Object.assign([], { provider: config, outcomes: statement }),
    );
    expect(outcomes).toEqual([]);
  });

  it("carries the same accepted provider projection into downstream normalization", async () => {
    let reads = 0;
    const result = await discover({
      get provider() {
        reads += 1;
        if (reads > 1) {
          throw new Error("catalog handle was consumed");
        }
        return config;
      },
    });
    expect(
      normalizePluginDiscoveryResult({ provider: result.provider, result: result.accepted }),
    ).toEqual({
      catalog: config,
      "catalog-alias": config,
    });
    expect(reads).toBe(1);
    expect(result.outcomes).toEqual([
      { provider: "catalog", status: "ready" },
      { provider: "catalog-alias", status: "ready" },
    ]);
  });
});
