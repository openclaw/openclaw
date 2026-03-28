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

function expectProviderModels(
  cfg: OpenClawConfig,
  providerId: string,
  expected: Record<string, unknown>,
) {
  const providers = cfg.models?.providers as Record<string, unknown> | undefined;
  expect(providers?.[providerId]).toMatchObject(expected);
}

function expectDefaultPrimaryModel(cfg: OpenClawConfig, modelRef: string) {
  expect(cfg.agents?.defaults?.model).toEqual({
    primary: modelRef,
  });
}

function createDemoProviderParams(params?: {
  providerId?: string;
  baseUrl?: string;
  aliases?: Array<string | { modelRef: string; alias: string }>;
  models?: ModelDefinitionConfig[];
}) {
  const providerId = params?.providerId ?? "demo";
  const baseUrl = params?.baseUrl ?? "https://demo.test/v1";
  const models = params?.models ?? [createModel("demo-default", "Demo Default")];
  return {
    providerId,
    api: "openai-completions" as const,
    baseUrl,
    aliases: params?.aliases ?? [
      { modelRef: `${providerId}/${models[0]?.id ?? "demo-default"}`, alias: "Demo" },
    ],
    models,
  };
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
      const params = createDemoProviderParams();
      const appliers = createDefaultModelPresetAppliers({
        primaryModelRef: "demo/demo-default",
        resolveParams: () => ({
          providerId: params.providerId,
          api: params.api,
          baseUrl: params.baseUrl,
          defaultModel: params.models[0],
          defaultModelId: params.models[0]?.id ?? "demo-default",
          aliases: params.aliases.filter(
            (alias): alias is { modelRef: string; alias: string } => typeof alias !== "string",
          ),
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
      const params = createDemoProviderParams({
        models: [createModel("a", "Model A"), createModel("b", "Model B")],
        aliases: [{ modelRef: "demo/a", alias: "Demo A" }],
      });
      const appliers = createDefaultModelsPresetAppliers<[string]>({
        primaryModelRef: "demo/a",
        resolveParams: (_cfg, baseUrl) => ({
          providerId: params.providerId,
          api: params.api,
          baseUrl,
          defaultModels: params.models,
          aliases: params.aliases.filter(
            (alias): alias is { modelRef: string; alias: string } => typeof alias !== "string",
          ),
        }),
      });

      const cfg = appliers.applyConfig({}, "https://alt.test/v1");
      expectProviderModels(cfg, "demo", {
        baseUrl: "https://alt.test/v1",
        models: [
          { id: "a", name: "Model A" },
          { id: "b", name: "Model B" },
        ],
      });
      expectDefaultPrimaryModel(cfg, "demo/a");
      return;
    }

    const params = createDemoProviderParams({
      providerId: "catalog",
      baseUrl: "https://catalog.test/v1",
      models: [createModel("default", "Catalog Default"), createModel("backup", "Catalog Backup")],
      aliases: ["catalog/default", { modelRef: "catalog/default", alias: "Catalog Default" }],
    });
    const appliers = createModelCatalogPresetAppliers({
      primaryModelRef: "catalog/default",
      resolveParams: () => ({
        providerId: params.providerId,
        api: params.api,
        baseUrl: params.baseUrl,
        catalogModels: params.models,
        aliases: params.aliases,
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
