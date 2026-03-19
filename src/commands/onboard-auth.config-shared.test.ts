import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import {
  applyProviderConfigWithDefaultModelPreset,
  applyProviderConfigWithModelCatalogPreset,
  applyProviderConfigWithDefaultModel,
  applyProviderConfigWithDefaultModels,
  applyProviderConfigWithModelCatalog,
  withAgentModelAliases,
} from "../plugins/provider-onboarding-config.js";

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

  it("appends missing catalog models even when the default model already exists", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          qianfan: {
            api: "openai-completions",
            baseUrl: "https://qianfan.example.com/v1",
            models: [makeModel("deepseek-v3.2"), makeModel("legacy-only")],
          },
        },
      },
    };

    const next = applyProviderConfigWithDefaultModels(cfg, {
      agentModels,
      providerId: "qianfan",
      api: "openai-completions",
      baseUrl: "https://qianfan.example.com/v1",
      defaultModels: [makeModel("deepseek-v3.2"), makeModel("ernie-5.0-thinking-preview")],
      defaultModelId: "deepseek-v3.2",
    });

    expect(next.models?.providers?.qianfan?.models?.map((m) => m.id)).toEqual([
      "deepseek-v3.2",
      "legacy-only",
      "ernie-5.0-thinking-preview",
    ]);
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

  it("preserves bedrock discovery when onboarding rewrites providers", () => {
    const cfg: OpenClawConfig = {
      models: {
        mode: "replace",
        bedrockDiscovery: {
          enabled: true,
          region: "us-west-2",
        },
      },
    };

    const next = applyProviderConfigWithDefaultModel(cfg, {
      agentModels,
      providerId: "custom",
      api: "openai-completions",
      baseUrl: "https://example.com/v1",
      defaultModel: makeModel("model-z"),
    });

    expect(next.models?.mode).toBe("replace");
    expect(next.models?.bedrockDiscovery).toEqual({
      enabled: true,
      region: "us-west-2",
    });
  });

  it("matches aliased provider ids and rewrites them to the canonical key", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "z-ai": {
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
      providerId: "zai",
      api: "openai-completions",
      baseUrl: "https://new.example.com/v1",
      defaultModels: [makeModel("model-b")],
      defaultModelId: "model-b",
    });

    expect(Object.keys(next.models?.providers ?? {})).toEqual(["zai"]);
    expect(next.models?.providers?.zai?.apiKey).toBe("test-key");
    expect(next.models?.providers?.zai?.models?.map((m) => m.id)).toEqual(["model-a", "model-b"]);
  });

  it("keeps secret-ref api keys when rewriting provider config", () => {
    const secretRef = {
      source: "env" as const,
      provider: "default",
      id: "CUSTOM_API_KEY",
    };
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://old.example.com/v1",
            apiKey: secretRef,
            models: [makeModel("model-a")],
          },
        },
      },
    };

    const next = applyProviderConfigWithDefaultModel(cfg, {
      agentModels,
      providerId: "custom",
      api: "openai-completions",
      baseUrl: "https://new.example.com/v1",
      defaultModel: makeModel("model-b"),
    });

    expect(next.models?.providers?.custom?.apiKey).toEqual(secretRef);
  });

  it("preserves explicit aliases when adding provider alias presets", () => {
    expect(
      withAgentModelAliases(
        {
          "custom/model-a": { alias: "Pinned" },
        },
        [{ modelRef: "custom/model-a", alias: "Preset" }, "custom/model-b"],
      ),
    ).toEqual({
      "custom/model-a": { alias: "Pinned" },
      "custom/model-b": {},
    });
  });

  it("applies default-model presets with alias and primary model", () => {
    const next = applyProviderConfigWithDefaultModelPreset(
      {
        agents: {
          defaults: {
            models: {
              "custom/model-z": { alias: "Pinned" },
            },
          },
        },
      },
      {
        providerId: "custom",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        defaultModel: makeModel("model-z"),
        aliases: [{ modelRef: "custom/model-z", alias: "Preset" }],
        primaryModelRef: "custom/model-z",
      },
    );

    expect(next.agents?.defaults?.models?.["custom/model-z"]).toEqual({ alias: "Pinned" });
    expect(next.agents?.defaults?.model).toEqual({ primary: "custom/model-z" });
  });

  it("applies catalog presets with alias and merged catalog models", () => {
    const next = applyProviderConfigWithModelCatalogPreset(
      {
        models: {
          providers: {
            custom: {
              api: "openai-completions",
              baseUrl: "https://example.com/v1",
              models: [makeModel("model-a")],
            },
          },
        },
      },
      {
        providerId: "custom",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        catalogModels: [makeModel("model-a"), makeModel("model-b")],
        aliases: [{ modelRef: "custom/model-b", alias: "Catalog Alias" }],
        primaryModelRef: "custom/model-b",
      },
    );

    expect(next.models?.providers?.custom?.models?.map((model) => model.id)).toEqual([
      "model-a",
      "model-b",
    ]);
    expect(next.agents?.defaults?.models?.["custom/model-b"]).toEqual({
      alias: "Catalog Alias",
    });
    expect(next.agents?.defaults?.model).toEqual({ primary: "custom/model-b" });
  });
});
