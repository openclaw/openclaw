import { describe, expect, it } from "vitest";
import {
  createDefaultModelPresetAppliers,
  createDefaultModelsPresetAppliers,
  createModelCatalogPresetAppliers,
} from "./provider-onboarding-config.js";

describe("provider onboarding preset appliers", () => {
  it("creates provider and primary-model appliers for a default model preset", () => {
    const appliers = createDefaultModelPresetAppliers({
      primaryModelRef: "demo/demo-default",
      resolveParams: () => ({
        providerId: "demo",
        api: "openai-completions" as const,
        baseUrl: "https://demo.test/v1",
        defaultModel: {
          id: "demo-default",
          name: "Demo Default",
        },
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
    expect(withPrimary.agents?.defaults?.model).toEqual({
      primary: "demo/demo-default",
    });
  });

  it("passes variant args through default-models resolvers", () => {
    const appliers = createDefaultModelsPresetAppliers<[string]>({
      primaryModelRef: "demo/a",
      resolveParams: (_cfg, baseUrl) => ({
        providerId: "demo",
        api: "openai-completions" as const,
        baseUrl,
        defaultModels: [
          { id: "a", name: "Model A" },
          { id: "b", name: "Model B" },
        ],
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
  });

  it("creates model-catalog appliers that preserve existing aliases", () => {
    const appliers = createModelCatalogPresetAppliers({
      primaryModelRef: "catalog/default",
      resolveParams: () => ({
        providerId: "catalog",
        api: "openai-completions" as const,
        baseUrl: "https://catalog.test/v1",
        catalogModels: [
          { id: "default", name: "Catalog Default" },
          { id: "backup", name: "Catalog Backup" },
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
    expect(cfg.agents?.defaults?.model).toEqual({
      primary: "catalog/default",
    });
  });
});
