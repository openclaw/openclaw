// Onboard auth shared-config tests cover provider config merges for auth setup.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import {
  applyAgentDefaultModelPrimary,
  applyOnboardAuthAgentModelsAndProviders,
  applyProviderConfigWithDefaultModelPreset,
  applyProviderConfigWithModelCatalogPreset,
  applyProviderConfigWithDefaultModel,
  applyProviderConfigWithDefaultModels,
  applyProviderConfigWithModelCatalog,
  withAgentModelAliases,
} from "../plugin-sdk/provider-onboard.js";

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

function makeProvider(
  modelIds: string[],
  overrides: Partial<ModelProviderConfig> = {},
): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: "https://old.example.com/v1",
    models: modelIds.map(makeModel),
    ...overrides,
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
          custom: makeProvider(["model-a"], { apiKey: "  test-key  " }),
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

  it("preserves provider-level settings when applying onboarding provider patches", () => {
    const next = applyOnboardAuthAgentModelsAndProviders(
      {
        models: {
          mode: "merge",
          providers: {
            custom: makeProvider(["model-a"], { timeoutSeconds: 900 }),
            other: makeProvider(["other-a"], {
              api: "openai-responses",
              baseUrl: "https://other.example.com/v1",
              timeoutSeconds: 300,
            }),
          },
        },
      },
      {
        agentModels,
        providers: {
          custom: makeProvider(["model-b"], { baseUrl: "https://new.example.com/v1" }),
        },
      },
    );

    expect(next.models?.providers?.custom?.timeoutSeconds).toBe(900);
    expect(next.models?.providers?.custom?.baseUrl).toBe("https://new.example.com/v1");
    expect(next.models?.providers?.custom?.models?.map((m) => m.id)).toEqual(["model-b"]);
    expect(next.models?.providers?.other?.timeoutSeconds).toBe(300);
  });

  it("omits empty provider request settings", () => {
    const next = applyOnboardAuthAgentModelsAndProviders(
      {
        models: {
          providers: {
            custom: makeProvider(["model-a"]),
          },
        },
      },
      {
        agentModels,
        providers: {
          custom: makeProvider(["model-b"], { baseUrl: "https://new.example.com/v1" }),
        },
      },
    );

    expect(next.models?.providers?.custom).not.toHaveProperty("request");
  });

  it("preserves settings without resurrecting a non-canonical provider key", () => {
    const next = applyOnboardAuthAgentModelsAndProviders(
      {
        models: {
          providers: {
            Custom: makeProvider(["model-a"], { timeoutSeconds: 900 }),
          },
        },
      },
      {
        agentModels,
        providers: {
          custom: makeProvider(["model-b"], { baseUrl: "https://new.example.com/v1" }),
        },
      },
    );

    expect(Object.keys(next.models?.providers ?? {})).toEqual(["custom"]);
    expect(next.models?.providers?.custom?.timeoutSeconds).toBe(900);
  });

  it("prefers canonical settings and removes every non-canonical provider key", () => {
    const next = applyOnboardAuthAgentModelsAndProviders(
      {
        models: {
          providers: {
            Custom: makeProvider(["stale-a"], {
              baseUrl: "https://stale.example.com/v1",
              timeoutSeconds: 300,
            }),
            custom: makeProvider(["canonical-a"], {
              baseUrl: "https://canonical.example.com/v1",
              timeoutSeconds: 900,
            }),
            CUSTOM: makeProvider(["older-a"], {
              baseUrl: "https://older.example.com/v1",
              timeoutSeconds: 600,
            }),
          },
        },
      },
      {
        agentModels,
        providers: {
          custom: makeProvider(["model-b"], { baseUrl: "https://new.example.com/v1" }),
        },
      },
    );

    expect(Object.keys(next.models?.providers ?? {})).toEqual(["custom"]);
    expect(next.models?.providers?.custom?.timeoutSeconds).toBe(900);
    expect(next.models?.providers?.custom?.baseUrl).toBe("https://new.example.com/v1");
  });

  it("collapses duplicate provider keys when applying a provider preset", () => {
    const next = applyProviderConfigWithDefaultModels(
      {
        models: {
          providers: {
            Custom: makeProvider(["stale-a"], {
              baseUrl: "https://stale.example.com/v1",
              timeoutSeconds: 300,
            }),
            custom: makeProvider(["canonical-a"], {
              baseUrl: "https://canonical.example.com/v1",
              timeoutSeconds: 900,
            }),
            CUSTOM: makeProvider(["older-a"], {
              baseUrl: "https://older.example.com/v1",
              timeoutSeconds: 600,
            }),
          },
        },
      },
      {
        agentModels,
        providerId: "custom",
        api: "openai-completions",
        baseUrl: "https://new.example.com/v1",
        defaultModels: [makeModel("model-b")],
        defaultModelId: "model-b",
      },
    );

    expect(Object.keys(next.models?.providers ?? {})).toEqual(["custom"]);
    expect(next.models?.providers?.custom?.timeoutSeconds).toBe(900);
    expect(next.models?.providers?.custom?.models?.map((model) => model.id)).toEqual([
      "canonical-a",
      "model-b",
    ]);
  });

  it("lets onboarding provider patches clear omitted auth fields", () => {
    const next = applyOnboardAuthAgentModelsAndProviders(
      {
        models: {
          providers: {
            custom: {
              api: "anthropic-messages",
              baseUrl: "https://old.example.com/v1",
              apiKey: "stale-key",
              auth: "api-key",
              authHeader: true,
              headers: { authorization: "stale-header" },
              request: {
                allowPrivateNetwork: true,
                auth: { mode: "authorization-bearer", token: "stale-token" },
                headers: { "x-stale-auth": "stale-request-header" },
              },
              timeoutSeconds: 900,
              models: [makeModel("model-a")],
            },
          },
        },
      },
      {
        agentModels,
        providers: {
          custom: makeProvider(["model-b"], {
            api: "anthropic-messages",
            baseUrl: "https://new.example.com/v1",
          }),
        },
      },
    );

    expect(next.models?.providers?.custom?.apiKey).toBeUndefined();
    expect(next.models?.providers?.custom?.auth).toBeUndefined();
    expect(next.models?.providers?.custom?.authHeader).toBeUndefined();
    expect(next.models?.providers?.custom?.headers).toBeUndefined();
    expect(next.models?.providers?.custom?.request).toEqual({ allowPrivateNetwork: true });
    expect(next.models?.providers?.custom?.timeoutSeconds).toBe(900);
  });

  it("normalizes retired Google agent model keys when adding provider models", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "google/gemini-3-pro-preview": {
              alias: "Gemini",
              params: { thinkingLevel: "high" },
            },
          },
        },
      },
    };

    const next = applyProviderConfigWithDefaultModels(cfg, {
      agentModels: {
        "google/gemini-3.1-pro-preview": {
          params: { serviceTier: "standard" },
        },
      },
      providerId: "custom",
      api: "openai-completions",
      baseUrl: "https://new.example.com/v1",
      defaultModels: [makeModel("model-b")],
      defaultModelId: "model-b",
    });

    expect(next.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": {
        alias: "Gemini",
        params: { thinkingLevel: "high", serviceTier: "standard" },
      },
    });
    expect(next.agents?.defaults?.models).not.toHaveProperty("google/gemini-3-pro-preview");
  });

  it("normalizes retired Google model ids before emitting provider catalog config", () => {
    const next = applyProviderConfigWithModelCatalog(
      {
        models: {
          providers: {
            kilocode: makeProvider(["google/gemini-3-pro-preview"], {
              baseUrl: "https://example.com/v1",
            }),
          },
        },
      },
      {
        agentModels,
        providerId: "kilocode",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        catalogModels: [makeModel("google/gemini-3.1-pro-preview")],
      },
    );

    expect(next.models?.providers?.kilocode?.models?.map((m) => m.id)).toEqual([
      "google/gemini-3.1-pro-preview",
    ]);
  });

  it("normalizes retired Google provider catalog ids when applying only an agent default", () => {
    const next = applyAgentDefaultModelPrimary(
      {
        models: {
          providers: {
            google: makeProvider(["google/gemini-3-pro-preview"], {
              api: "google-generative-ai",
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            }),
            kilocode: makeProvider(["google/gemini-3-pro-preview"], {
              baseUrl: "https://kilocode.example.com/v1",
            }),
          },
        },
      },
      "google/gemini-3.1-pro-preview",
    );

    expect(next.models?.providers?.google?.models?.map((m) => m.id)).toEqual([
      "google/gemini-3.1-pro-preview",
    ]);
    expect(next.models?.providers?.kilocode?.models?.map((m) => m.id)).toEqual([
      "google/gemini-3.1-pro-preview",
    ]);
    expect(next.agents?.defaults?.model).toEqual({ primary: "google/gemini-3.1-pro-preview" });
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

  it("normalizes retired Google alias presets before emitting config", () => {
    expect(
      withAgentModelAliases(
        {
          "google/gemini-3-pro-preview": { alias: "Pinned" },
        },
        [{ modelRef: "google/gemini-3-pro-preview", alias: "Preset" }],
      ),
    ).toEqual({
      "google/gemini-3.1-pro-preview": { alias: "Pinned" },
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

  it("does not let default-model presets replace an existing default model", () => {
    const next = applyProviderConfigWithDefaultModelPreset(
      {
        agents: {
          defaults: {
            models: {
              "claude-max-proxy/claude-opus-4-7": {},
              "claude-max-proxy/claude-sonnet-4-6": {},
            },
            model: {
              primary: "claude-max-proxy/claude-opus-4-7",
              fallbacks: ["claude-max-proxy/claude-sonnet-4-6"],
            },
          },
        },
      },
      {
        providerId: "moonshot",
        api: "openai-completions",
        baseUrl: "https://api.moonshot.cn/v1",
        defaultModel: makeModel("kimi-k2.6"),
        aliases: [{ modelRef: "moonshot/kimi-k2.6", alias: "Kimi" }],
        primaryModelRef: "moonshot/kimi-k2.6",
      },
    );

    expect(next.agents?.defaults?.model).toEqual({
      primary: "claude-max-proxy/claude-opus-4-7",
      fallbacks: ["claude-max-proxy/claude-sonnet-4-6"],
    });
    expect(next.agents?.defaults?.models).toEqual({
      "claude-max-proxy/claude-opus-4-7": {},
      "claude-max-proxy/claude-sonnet-4-6": {},
      "moonshot/kimi-k2.6": { alias: "Kimi" },
    });
    expect(next.models?.providers?.moonshot?.models?.map((model) => model.id)).toEqual([
      "kimi-k2.6",
    ]);
  });

  it("applies catalog presets with alias and merged catalog models", () => {
    const next = applyProviderConfigWithModelCatalogPreset(
      {
        models: {
          providers: {
            custom: makeProvider(["model-a"], { baseUrl: "https://example.com/v1" }),
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

  it("does not let catalog presets replace an existing default model", () => {
    const next = applyProviderConfigWithModelCatalogPreset(
      {
        agents: {
          defaults: {
            models: {
              "custom-existing/model-a": {},
            },
            model: {
              primary: "custom-existing/model-a",
            },
          },
        },
      },
      {
        providerId: "custom",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        catalogModels: [makeModel("model-b")],
        aliases: [{ modelRef: "custom/model-b", alias: "Catalog Alias" }],
        primaryModelRef: "custom/model-b",
      },
    );

    expect(next.agents?.defaults?.model).toEqual({ primary: "custom-existing/model-a" });
    expect(next.agents?.defaults?.models).toEqual({
      "custom-existing/model-a": {},
      "custom/model-b": { alias: "Catalog Alias" },
    });
    expect(next.models?.providers?.custom?.models?.map((model) => model.id)).toEqual(["model-b"]);
  });
});
