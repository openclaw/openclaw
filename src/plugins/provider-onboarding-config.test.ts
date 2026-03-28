import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import {
  createDefaultModelPresetAppliers,
  createDefaultModelsPresetAppliers,
  createModelCatalogPresetAppliers,
} from "./provider-onboarding-config.js";

function createModel(id: string, name: string): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function expectPrimaryModel(cfg: OpenClawConfig) {
  expect(cfg.agents?.defaults?.model).toEqual({
    primary: "demo/demo-default",
  });
}

function expectCatalogPrimaryModel(cfg: OpenClawConfig) {
  expect(cfg.agents?.defaults?.model).toEqual({
    primary: "catalog/default",
  });
}

describe("provider onboarding preset appliers", () => {
  it.each([
    {
      name: "creates provider and primary-model appliers for a default model preset",
      kind: "default-model",
    },
    {
      name: "passes variant args through default-models resolvers",
      kind: "default-models",
    },
    {
      name: "creates model-catalog appliers that preserve existing aliases",
      kind: "catalog-models",
    },
  ] as const)("$name", ({ kind }) => {
    if (kind === "default-model") {
      const appliers = createDefaultModelPresetAppliers({
        primaryModelRef: "demo/demo-default",
        resolveParams: () => ({
          providerId: "demo",
          api: "openai-completions" as const,
          baseUrl: "https://demo.test/v1",
          defaultModel: createModel("demo-default", "Demo Default"),
          defaultModelId: "demo-default",
          aliases: [{ modelRef: "demo/demo-default", alias: "Demo" }],
        }),
      });

      const providerOnly = appliers.applyProviderConfig({});
      expect(providerOnly.agents?.defaults?.models).toMatchObject({
        "demo/demo-default": {
          alias: "Demo",
        },
      });
      expect(providerOnly.agents?.defaults?.model).toBeUndefined();

      const withPrimary = appliers.applyConfig({});
      expectPrimaryModel(withPrimary);
      return;
    }

    if (kind === "default-models") {
      const appliers = createDefaultModelsPresetAppliers<[string]>({
        primaryModelRef: "demo/a",
        resolveParams: (_cfg, baseUrl) => ({
          providerId: "demo",
          api: "openai-completions" as const,
          baseUrl,
          defaultModels: [createModel("a", "Model A"), createModel("b", "Model B")],
          aliases: [{ modelRef: "demo/a", alias: "Demo A" }],
        }),
      });

      const cfg = appliers.applyConfig({}, "https://alt.test/v1");
      expect(cfg.models?.providers?.demo).toMatchObject({
        baseUrl: "https://alt.test/v1",
        models: [
          { id: "a", name: "Model A" },
          { id: "b", name: "Model B" },
        ],
      });
      expect(cfg.agents?.defaults?.model).toEqual({
        primary: "demo/a",
      });
      return;
    }

    const appliers = createModelCatalogPresetAppliers({
      primaryModelRef: "catalog/default",
      resolveParams: () => ({
        providerId: "catalog",
        api: "openai-completions" as const,
        baseUrl: "https://catalog.test/v1",
        catalogModels: [
          createModel("default", "Catalog Default"),
          createModel("backup", "Catalog Backup"),
        ],
        aliases: ["catalog/default", { modelRef: "catalog/default", alias: "Catalog Default" }],
      }),
    });

    const cfg = appliers.applyConfig({
      agents: {
        defaults: {
          models: {
            "catalog/default": {
              alias: "Existing Alias",
            },
          },
        },
      },
    });

    expect(cfg.agents?.defaults?.models).toMatchObject({
      "catalog/default": {
        alias: "Existing Alias",
      },
    });
    expectCatalogPrimaryModel(cfg);
  });
});
