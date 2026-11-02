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
import { createTestModelDefinition } from "./test-runtime-config-helpers.js";

function makeModel(id: string): ModelDefinitionConfig {
  return createTestModelDefinition(id, { contextWindow: 4096, maxTokens: 1024 });
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

const newBaseUrl = "https://new.example.com/v1";
const agentModels: Record<string, AgentModelEntryConfig> = { "custom/model-a": {} };
const preset = {
  agentModels,
  providerId: "custom",
  api: "openai-completions" as const,
  baseUrl: newBaseUrl,
  defaultModels: [makeModel("model-b")],
  defaultModelId: "model-b",
};
const withProviders = (providers: Record<string, ModelProviderConfig>): OpenClawConfig => ({
  models: { providers },
});
const modelIds = (cfg: OpenClawConfig, provider: string) =>
  cfg.models?.providers?.[provider]?.models.map((model) => model.id);

function patchProviders(
  providers: Record<string, ModelProviderConfig>,
  overrides: Partial<ModelProviderConfig> = {},
  mode?: "merge",
) {
  return applyOnboardAuthAgentModelsAndProviders(
    { models: { ...(mode ? { mode } : {}), providers } },
    {
      agentModels,
      providers: { custom: makeProvider(["model-b"], { baseUrl: newBaseUrl, ...overrides }) },
    },
  );
}

function duplicateProviders() {
  return {
    Custom: makeProvider(["stale-a"], { timeoutSeconds: 300 }),
    custom: makeProvider(["canonical-a"], { timeoutSeconds: 900 }),
    CUSTOM: makeProvider(["older-a"], { timeoutSeconds: 600 }),
  };
}

describe("onboard auth provider config merges", () => {
  it.each([{ Custom: makeProvider(["model-a"], { timeoutSeconds: 900 }) }, duplicateProviders()])(
    "preserves canonical settings and removes variant provider keys: %j",
    (providers) => {
      const next = patchProviders(
        {
          ...providers,
          other: makeProvider(["other-a"], { timeoutSeconds: 300 }),
        },
        {},
        "merge",
      );
      expect(Object.keys(next.models?.providers ?? {}).toSorted()).toEqual(["custom", "other"]);
      expect(next.models?.providers?.custom).toMatchObject({
        timeoutSeconds: 900,
        baseUrl: newBaseUrl,
      });
      expect(modelIds(next, "custom")).toEqual(["model-b"]);
      expect(next.models?.providers?.other?.timeoutSeconds).toBe(300);
    },
  );

  it("collapses duplicate provider keys when applying a provider preset", () => {
    const next = applyProviderConfigWithDefaultModels(withProviders(duplicateProviders()), preset);

    expect(Object.keys(next.models?.providers ?? {})).toEqual(["custom"]);
    expect(next.models?.providers?.custom?.timeoutSeconds).toBe(900);
    expect(modelIds(next, "custom")).toEqual(["canonical-a", "model-b"]);
  });

  it("lets onboarding provider patches clear omitted auth fields", () => {
    const next = patchProviders(
      {
        custom: makeProvider(["model-a"], {
          api: "anthropic-messages",
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
        }),
      },
      { api: "anthropic-messages" },
    );

    for (const key of ["apiKey", "auth", "authHeader", "headers"] as const) {
      expect(next.models?.providers?.custom?.[key]).toBeUndefined();
    }
    expect(next.models?.providers?.custom).toMatchObject({ timeoutSeconds: 900 });
    expect(next.models?.providers?.custom?.request).toEqual({ allowPrivateNetwork: true });
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
      ...preset,
      agentModels: {
        "google/gemini-3.1-pro-preview": {
          params: { serviceTier: "standard" },
        },
      },
    });

    expect(next.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": {
        alias: "Gemini",
        params: { thinkingLevel: "high", serviceTier: "standard" },
      },
    });
  });

  it("normalizes retired Google provider catalog ids when applying only an agent default", () => {
    const next = applyAgentDefaultModelPrimary(
      withProviders({
        google: makeProvider(["google/gemini-3-pro-preview"], {
          api: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        }),
        kilocode: makeProvider(["google/gemini-3-pro-preview"], {
          baseUrl: "https://kilocode.example.com/v1",
        }),
      }),
      "google/gemini-3.1-pro-preview",
    );

    for (const provider of ["google", "kilocode"]) {
      expect(modelIds(next, provider)).toEqual(["google/gemini-3.1-pro-preview"]);
    }
    expect(next.agents?.defaults?.model).toEqual({ primary: "google/gemini-3.1-pro-preview" });
  });
});
