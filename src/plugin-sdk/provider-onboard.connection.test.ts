import { describe, expect, it } from "vitest";
import {
  createDefaultModelsConnectionPresetAppliers,
  createDefaultModelsPresetAppliers,
  createModelCatalogPresetAppliers,
  createProviderConnectionPresetAppliers,
  type ModelDefinitionConfig,
  type OpenClawConfig,
} from "./provider-onboard.js";

function model(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
}

function preset(models: () => ModelDefinitionConfig[]) {
  return {
    primaryModelRef: "fixture/default",
    resolveParams: () => ({
      providerId: "fixture",
      api: "openai-completions" as const,
      baseUrl: "https://fixture.invalid/v1",
      catalogModels: models,
      defaultModels: models,
      defaultModelId: "default",
      aliases: [{ modelRef: "fixture/default", alias: "Default" }],
    }),
  };
}

describe.each([
  ["catalog", createProviderConnectionPresetAppliers<[]>],
  ["default models", createDefaultModelsConnectionPresetAppliers<[]>],
] as const)("connection-only %s setup", (_name, create) => {
  it("keeps authored native-named and unique rows, defaults, fallbacks and aliases", () => {
    const authoredDefault = { ...model("default"), name: "Authored", contextWindow: 32768 };
    const authoredUnique = model("private-choice");
    const config: OpenClawConfig = {
      models: {
        mode: "merge",
        providers: {
          fixture: {
            baseUrl: "https://fixture.invalid/v1",
            models: [authoredDefault, authoredUnique],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "other/chosen", fallbacks: ["other/backup", "fixture/private-choice"] },
          models: { "fixture/default": { alias: "Authored alias", params: { temperature: 0.3 } } },
        },
      },
    };

    const result = create(preset(() => [model("default"), model("extra")])).applyConfig(config);

    expect(result.models?.providers?.fixture?.models).toEqual([authoredDefault, authoredUnique]);
    expect(result.agents?.defaults?.model).toEqual(config.agents?.defaults?.model);
    expect(result.agents?.defaults?.models).toEqual(config.agents?.defaults?.models);
    expect(config.models?.providers?.fixture?.models).toEqual([authoredDefault, authoredUnique]);
  });
});

it("keeps provider-only setup from changing the primary", () => {
  const result = createDefaultModelsConnectionPresetAppliers(
    preset(() => [model("default")]),
  ).applyProviderConfig({});

  expect(result.models?.providers?.fixture?.models).toEqual([]);
  expect(result.agents?.defaults?.model).toBeUndefined();
});

it("preserves a resolver's intentional no-op", () => {
  const config: OpenClawConfig = { agents: { defaults: { model: { fallbacks: [] } } } };
  const result = createDefaultModelsConnectionPresetAppliers({
    primaryModelRef: "fixture/default",
    resolveParams: () => null,
  }).applyConfig(config);

  expect(result).toBe(config);
});

it("keeps catalog and default-model membership rules distinct in replace mode", () => {
  const authored = { ...model("default"), name: "Authored" };
  const config: OpenClawConfig = {
    models: {
      mode: "replace",
      providers: { fixture: { baseUrl: "https://fixture.invalid/v1", models: [authored] } },
    },
  };
  const params = preset(() => [model("default"), model("extra")]);

  const catalog = createProviderConnectionPresetAppliers(params).applyConfig(config);
  const defaults = createDefaultModelsConnectionPresetAppliers(params).applyConfig(config);

  expect(catalog.models?.providers?.fixture?.models).toEqual([authored, model("extra")]);
  expect(defaults.models?.providers?.fixture?.models).toEqual([authored]);
});

it("still adds required defaults in replace mode when the authored rows omit the default", () => {
  const authored = model("private-choice");
  const result = createDefaultModelsConnectionPresetAppliers(
    preset(() => [model("default"), model("extra")]),
  ).applyConfig({
    models: {
      mode: "replace",
      providers: { fixture: { baseUrl: "https://fixture.invalid/v1", models: [authored] } },
    },
  });

  expect(result.models?.providers?.fixture?.models).toEqual([
    authored,
    model("default"),
    model("extra"),
  ]);
});

it.each([createModelCatalogPresetAppliers<[]>, createDefaultModelsPresetAppliers<[]>])(
  "preserves the existing public catalog-seeding helper behavior",
  (create) => {
    const result = create(preset(() => [model("default")])).applyConfig({});

    expect(result.models?.providers?.fixture?.models).toEqual([model("default")]);
  },
);
