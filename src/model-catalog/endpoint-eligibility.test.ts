import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isProviderCatalogSourceAllowed } from "../plugins/provider-config-owner.js";
import { planEffectiveModelCatalogRows } from "./index.js";

type Registry = Parameters<typeof planEffectiveModelCatalogRows>[0]["registry"];
function catalog(plugin: Pick<Registry["plugins"][number], "modelCatalog" | "providerEndpoints">) {
  return { plugins: [{ id: "catalog-owner", providers: ["fixture"], ...plugin }] };
}
const registry = catalog({
  providerEndpoints: [
    { endpointClass: "openai-public", hosts: ["native.example"], hostSuffixes: ["region.example"] },
  ],
  modelCatalog: {
    aliases: { alternate: { provider: "fixture", baseUrl: "https://alternate.example/api" } },
    providers: {
      fixture: {
        baseUrl: "https://native.example/v1",
        api: "openai-completions",
        models: [{ id: "native-model", name: "Native model", baseUrl: "https://model.example/v1" }],
      },
    },
  },
});

function providerConfig(baseUrl: string): OpenClawConfig {
  return { models: { providers: { fixture: { baseUrl, models: [] } } } };
}

function plan(
  baseUrl: string,
  overrides: Partial<Parameters<typeof planEffectiveModelCatalogRows>[0]> = {},
) {
  return planEffectiveModelCatalogRows({ registry, config: providerConfig(baseUrl), ...overrides });
}

describe("provider endpoint catalog eligibility", () => {
  it.each([
    "https://native.example/v1",
    "http://native.example:8080/compatible",
    "https://us.region.example/v1",
    "MODEL.example/v1/?ignored=1#fragment",
  ])("keeps native catalog rows at the declared endpoint %s", (baseUrl) => {
    expect(plan(baseUrl).rows.map((row) => row.id)).toEqual(["native-model"]);
  });

  it("excludes native manifest rows for a custom provider endpoint", () => {
    expect(plan("https://proxy.example/v1")).toMatchObject({ rows: [], entries: [] });
  });

  it("keeps the alias's declared endpoint independent of the target override", () => {
    const providers = {
      ...providerConfig("https://proxy.example/v1").models?.providers,
      alternate: { baseUrl: "https://alternate.example/api", models: [] },
    };
    expect(
      plan("https://proxy.example/v1", {
        config: { models: { providers } },
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
    const adapter = catalog({
      modelCatalog: {
        providers: { fixture: { models: [{ id: "adapter-model", name: "Adapter model" }] } },
      },
    });
    expect(
      plan("https://proxy.example/v1", { registry: adapter }).rows.map((row) => row.id),
    ).toEqual(["adapter-model"]);
  });
  it.each([
    ["openai-public", "https://NATIVE.example/v1/"],
    ["openai-public", "native.example/v1?ignored=1#fragment"],
    ["future-endpoint", "https://NATIVE.example/v1/?ignored=1#fragment"],
  ])("normalizes endpoint-only declarations for %s at %s", (endpointClass, baseUrl) => {
    expect(
      isProviderCatalogSourceAllowed({
        provider: "fixture",
        config: providerConfig("https://native.example/v1"),
        plugin: { providerEndpoints: [{ endpointClass, baseUrls: [baseUrl] }] },
      }),
    ).toBe(true);
  });
});
