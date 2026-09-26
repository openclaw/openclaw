import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginManifest } from "../plugins/manifest.js";
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

describe("StepFun regional catalog pricing", () => {
  const loaded = loadPluginManifest(
    fileURLToPath(new URL("../../extensions/stepfun", import.meta.url)),
  );
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  const stepfunRegistry = { plugins: [loaded.manifest] };

  it.each([
    { provider: "stepfun", baseUrl: "https://api.stepfun.com/v1" },
    { provider: "stepfun", baseUrl: "https://api.stepfun.ai/v1" },
    { provider: "stepfun-plan", baseUrl: "https://api.stepfun.com/step_plan/v1" },
    { provider: "stepfun-plan", baseUrl: "https://api.stepfun.ai/step_plan/v1" },
  ])(
    "retains catalog capabilities and prices for $provider at $baseUrl",
    ({ provider, baseUrl }) => {
      const { rows } = planEffectiveModelCatalogRows({
        registry: stepfunRegistry,
        config: { models: { providers: { [provider]: { baseUrl, models: [] } } } },
        providerFilter: provider,
      });
      expect(rows.map((row) => row.id)).toEqual(
        expect.arrayContaining(["step-5-preview", "step-3.7-flash", "step-3.5-flash"]),
      );
      expect(rows.find((row) => row.id === "step-5-preview")).toMatchObject({
        contextWindow: 1048576,
        maxTokens: 65536,
        cost:
          provider === "stepfun"
            ? { input: 1, output: 2.7, cacheRead: 0.05, cacheWrite: 0 }
            : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    },
  );

  it.each(["stepfun", "stepfun-plan"])(
    "excludes native prices for a custom %s proxy",
    (provider) => {
      expect(
        planEffectiveModelCatalogRows({
          registry: stepfunRegistry,
          config: {
            models: {
              providers: { [provider]: { baseUrl: "https://proxy.example/v1", models: [] } },
            },
          },
          providerFilter: provider,
        }).rows,
      ).toEqual([]);
    },
  );
});
