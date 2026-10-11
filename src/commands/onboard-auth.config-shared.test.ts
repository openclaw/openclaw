// Onboard auth shared-config tests cover provider config merges for auth setup.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import {
  applyAgentDefaultModelPrimary,
  applyOnboardAuthAgentModelsAndProviders,
  applyProviderConfigWithDefaultModels,
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
});
