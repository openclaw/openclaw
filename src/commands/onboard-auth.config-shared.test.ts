import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import {
  applyProviderConfigWithDefaultModel,
  applyProviderConfigWithDefaultModels,
  applyProviderConfigWithModelCatalog,
} from "./onboard-auth.config-shared.js";

function makeModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    contextWindow: 4096,
    maxTokens: 1024,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
  };
}

describe("onboard auth provider config merges", () => {
  const agentModels: Record<string, AgentModelEntryConfig> = {
    "custom/model-a": {},
  };

  it("appends missing default models to existing provider models", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://old.example.com/v1",
            apiKey: "  test-key  ",
            models: [makeModel("model-a")],
          },
        },
      },
    };

    const next = applyProviderConfigWithDefaultModels(cfg, {
      agentModels,
      providerId: "custom",
      api: "openai-completions",
      baseUrl: "https://new.example.com/v1",
      defaultModels: [makeModel("model-b")],
      defaultModelId: "model-b",
    });

    expect(next.models?.providers?.custom?.models?.map((m) => m.id)).toEqual([
      "model-a",
      "model-b",
    ]);
    expect(next.models?.providers?.custom?.apiKey).toBe("test-key");
    expect(next.agents?.defaults?.models).toEqual(agentModels);
  });

  it("merges model catalogs without duplicating existing model ids", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://example.com/v1",
            models: [makeModel("model-a")],
          },
        },
      },
    };

    const next = applyProviderConfigWithModelCatalog(cfg, {
      agentModels,
      providerId: "custom",
      api: "openai-completions",
      baseUrl: "https://example.com/v1",
      catalogModels: [makeModel("model-a"), makeModel("model-c")],
    });

    expect(next.models?.providers?.custom?.models?.map((m) => m.id)).toEqual([
      "model-a",
      "model-c",
    ]);
  });

  it("supports single default model convenience wrapper", () => {
    const next = applyProviderConfigWithDefaultModel(
      {},
      {
        agentModels,
        providerId: "custom",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        defaultModel: makeModel("model-z"),
      },
    );

    expect(next.models?.providers?.custom?.models?.map((m) => m.id)).toEqual(["model-z"]);
  });
});
