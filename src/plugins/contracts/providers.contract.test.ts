// Provider contract tests cover shared provider plugin behavior across bundled providers.
import { registerProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it } from "vitest";
import { describeProviderContracts } from "../../plugin-sdk/test-helpers/provider-contract.js";
import { describeWebSearchProviderContracts } from "../../plugin-sdk/test-helpers/web-search-provider-contract.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";

for (const providerId of [
  "anthropic",
  "fal",
  "google",
  "minimax",
  "moonshot",
  "openai",
  "openrouter",
  "xai",
] as const) {
  describeProviderContracts(providerId);
}

for (const providerId of [
  "brave",
  "duckduckgo",
  "exa",
  "firecrawl",
  "google",
  "minimax",
  "moonshot",
  "parallel",
  "perplexity",
  "tavily",
  "xai",
] as const) {
  describeWebSearchProviderContracts(providerId);
}

const actualProviderEntries = [
  {
    id: "novita",
    name: "NovitaAI Provider",
  },
  {
    id: "qianfan",
    name: "Qianfan Provider",
  },
] as const;

it.each(actualProviderEntries)(
  "$id registers its actual provider and text catalog",
  async ({ id, name }) => {
    const { default: plugin } = await loadBundledPluginFacade<{
      default: Parameters<typeof registerProviderPlugin>[0]["plugin"];
    }>({ pluginId: id, artifactBasename: "index.js" });
    expect(plugin).toMatchObject({ id, name });
    const { providers, modelCatalogProviders } = await registerProviderPlugin({ plugin, id, name });
    expect(providers.find((provider) => provider.id === id)).toMatchObject({
      id,
      auth: expect.arrayContaining([
        expect.objectContaining({ id: "api-key", run: expect.any(Function) }),
      ]),
      catalog: expect.objectContaining({ order: "simple", run: expect.any(Function) }),
      staticCatalog: expect.objectContaining({ order: "simple", run: expect.any(Function) }),
    });
    expect(modelCatalogProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: id,
          kinds: ["text"],
          staticCatalog: expect.any(Function),
          liveCatalog: expect.any(Function),
        }),
      ]),
    );
  },
);
