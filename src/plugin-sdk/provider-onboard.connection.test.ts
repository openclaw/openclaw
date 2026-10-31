import { expect, it } from "vitest";
import { buildCatalogModel } from "./provider-catalog.test-support.js";
import {
  createDefaultModelsConnectionPresetAppliers as defaultConnectionPreset,
  createDefaultModelsPresetAppliers as defaultPreset,
  createModelCatalogPresetAppliers as catalogPreset,
  createProviderConnectionPresetAppliers as connectionPreset,
  type ModelDefinitionConfig as Model,
  type OpenClawConfig,
} from "./provider-onboard.js";

function model(id: string): Model {
  return buildCatalogModel(id, {
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  });
}

function preset(...ids: string[]) {
  const models = () => ids.map(model);
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

function configured(models: Model[], mode: "merge" | "replace" = "replace"): OpenClawConfig {
  return {
    models: { mode, providers: { fixture: { baseUrl: "https://fixture.invalid/v1", models } } },
  };
}

it.each([
  ["catalog", connectionPreset<[]>],
  ["default models", defaultConnectionPreset<[]>],
] as const)("connection-only %s preserves authored configuration", (_name, create) => {
  const authoredDefault = { ...model("default"), name: "Authored", contextWindow: 32768 };
  const authoredUnique = model("private-choice");
  const config: OpenClawConfig = {
    ...configured([authoredDefault, authoredUnique], "merge"),
    agents: {
      defaults: {
        model: { primary: "other/chosen", fallbacks: ["other/backup", "fixture/private-choice"] },
        models: { "fixture/default": { alias: "Authored alias", params: { temperature: 0.3 } } },
      },
    },
  };

  const result = create(preset("default", "extra")).applyConfig(config);

  expect(result.models?.providers?.fixture?.models).toEqual([authoredDefault, authoredUnique]);
  expect(result.agents?.defaults).toEqual(config.agents?.defaults);
  expect(config.models?.providers?.fixture?.models).toEqual([authoredDefault, authoredUnique]);
});

it("keeps provider-only setup from changing the primary", () => {
  const result = defaultConnectionPreset(preset("default")).applyProviderConfig({});

  expect(result.models?.providers?.fixture?.models).toEqual([]);
  expect(result.agents?.defaults?.model).toBeUndefined();
});

it("preserves a resolver's intentional no-op", () => {
  const config: OpenClawConfig = { agents: { defaults: { model: { fallbacks: [] } } } };
  const result = defaultConnectionPreset({
    primaryModelRef: "fixture/default",
    resolveParams: () => null,
  }).applyConfig(config);

  expect(result).toBe(config);
});

it.each([
  [connectionPreset<[]>, "default", ["extra"]],
  [defaultConnectionPreset<[]>, "default", []],
  [defaultConnectionPreset<[]>, "private-choice", ["default", "extra"]],
] as const)("replace-mode %s merges authored %s", (create, id, extra) => {
  const authored = { ...model(id), name: "Authored" };
  const result = create(preset("default", "extra")).applyConfig(configured([authored]));
  expect(result.models?.providers?.fixture?.models).toEqual([authored, ...extra.map(model)]);
});

it.each([catalogPreset<[]>, defaultPreset<[]>])("public preset %s seeds catalog", (create) => {
  const result = create(preset("default")).applyConfig({});

  expect(result.models?.providers?.fixture?.models).toEqual([model("default")]);
});
