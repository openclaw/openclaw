import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isProviderCatalogSourceAllowed } from "../plugins/provider-config-owner.js";
import { planEffectiveModelCatalogRows } from "./index.js";

const registry = {
  plugins: [
    {
      id: "catalog-owner",
      providers: ["fixture"],
      providerEndpoints: [
        {
          endpointClass: "openai-public",
          hosts: ["native.example"],
          hostSuffixes: ["region.example"],
        },
      ],
      modelCatalog: {
        aliases: { alternate: { provider: "fixture", baseUrl: "https://alternate.example/api" } },
        providers: {
          fixture: {
            baseUrl: "https://native.example/v1",
            api: "openai-completions",
            models: [
              { id: "native-model", name: "Native model", baseUrl: "https://model.example/v1" },
            ],
          },
        },
      },
    },
  ],
} satisfies Parameters<typeof planEffectiveModelCatalogRows>[0]["registry"];

function providerConfig(baseUrl: string): OpenClawConfig {
  return { models: { providers: { fixture: { baseUrl, models: [] } } } };
}

describe("provider endpoint catalog eligibility", () => {
  it.each([
    "https://native.example/v1",
    "http://native.example:8080/compatible",
    "https://us.region.example/v1",
    "MODEL.example/v1/?ignored=1#fragment",
  ])("keeps native catalog rows at the declared endpoint %s", (baseUrl) => {
    expect(
      planEffectiveModelCatalogRows({ registry, config: providerConfig(baseUrl) }).rows.map(
        (row) => row.id,
      ),
    ).toEqual(["native-model"]);
  });

  it("excludes native manifest rows for a custom provider endpoint", () => {
    expect(
      planEffectiveModelCatalogRows({
        registry,
        config: providerConfig("https://proxy.example/v1"),
      }),
    ).toMatchObject({ rows: [], entries: [] });
  });

  it("keeps the alias's declared endpoint independent of the target override", () => {
    const config = providerConfig("https://proxy.example/v1");
    const aliasedConfig: OpenClawConfig = {
      models: {
        providers: {
          ...config.models?.providers,
          alternate: { baseUrl: "https://alternate.example/api", models: [] },
        },
      },
    };
    expect(
      planEffectiveModelCatalogRows({
        registry,
        config: aliasedConfig,
        providerFilter: "alternate",
      }).rows.map((row) => row.ref),
    ).toEqual(["alternate/native-model"]);
  });

  it("allows model-level overrides without a provider-level veto", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          fixture: {
            baseUrl: "",
            models: [
              {
                id: "authored",
                name: "Authored",
                baseUrl: "https://proxy.example/v1",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    };
    expect(planEffectiveModelCatalogRows({ registry, config }).rows.map((row) => row.id)).toEqual([
      "native-model",
    ]);
  });

  it("keeps adapters with no native endpoint declaration eligible", () => {
    const adapter = {
      plugins: [
        {
          id: "adapter",
          providers: ["fixture"],
          modelCatalog: {
            providers: { fixture: { models: [{ id: "adapter-model", name: "Adapter model" }] } },
          },
        },
      ],
    };
    expect(
      planEffectiveModelCatalogRows({
        registry: adapter,
        config: providerConfig("https://proxy.example/v1"),
      }).rows.map((row) => row.id),
    ).toEqual(["adapter-model"]);
  });
  it.each(["https://NATIVE.example/v1/", "native.example/v1?ignored=1#fragment"])(
    "normalizes endpoint-only declarations %s",
    (baseUrl) => {
      expect(
        isProviderCatalogSourceAllowed({
          provider: "fixture",
          config: providerConfig("https://native.example/v1"),
          plugin: {
            providerEndpoints: [{ endpointClass: "openai-public", baseUrls: [baseUrl] }],
          },
        }),
      ).toBe(true);
    },
  );
});
