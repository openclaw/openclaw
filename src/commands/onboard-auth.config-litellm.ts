import type { OpenClawConfig } from "../config/config.js";

export const LITELLM_BASE_URL = "http://localhost:4000";
export const LITELLM_DEFAULT_MODEL_ID = "claude-opus-4-6";

/**
 * Apply LiteLLM provider configuration without changing the default model.
 * LiteLLM is a flexible proxy that supports many models, so base URL and model
 * are user-configurable.
 */
export function applyLitellmProviderConfig(
  cfg: OpenClawConfig,
  params: {
    baseUrl: string;
    modelId: string;
    modelName?: string;
    contextWindow?: number;
    maxTokens?: number;
  },
): OpenClawConfig {
  const modelRef = `litellm/${params.modelId}`;
  const models = { ...cfg.agents?.defaults?.models };
  models[modelRef] = {
    ...models[modelRef],
    alias: models[modelRef]?.alias ?? params.modelName ?? params.modelId,
  };

  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.litellm;
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const isClaude = params.modelId.toLowerCase().startsWith("claude-");
  const newModel = {
    id: params.modelId,
    name: params.modelName ?? params.modelId,
    ...(isClaude ? { api: "anthropic-messages" as const } : {}),
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: params.contextWindow ?? 128000,
    maxTokens: params.maxTokens ?? 8192,
    compat: { supportsStore: false },
  };
  const hasModel = existingModels.some((model) => model.id === params.modelId);
  const mergedModels = hasModel ? existingModels : [...existingModels, newModel];
  const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as Record<
    string,
    unknown
  > as { apiKey?: string };
  const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : undefined;
  const normalizedApiKey = resolvedApiKey?.trim();
  providers.litellm = {
    ...existingProviderRest,
    baseUrl: params.baseUrl,
    api: "openai-completions",
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : [newModel],
  };

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
    models: {
      mode: cfg.models?.mode ?? "merge",
      providers,
    },
  };
}

/**
 * Apply LiteLLM provider configuration AND set LiteLLM as the default model.
 * Use this when LiteLLM is the primary provider choice during onboarding.
 */
export function applyLitellmConfig(
  cfg: OpenClawConfig,
  params: {
    baseUrl: string;
    modelId: string;
    modelName?: string;
    contextWindow?: number;
    maxTokens?: number;
  },
): OpenClawConfig {
  const next = applyLitellmProviderConfig(cfg, params);
  const modelRef = `litellm/${params.modelId}`;
  const existingModel = next.agents?.defaults?.model;
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...(existingModel && "fallbacks" in (existingModel as Record<string, unknown>)
            ? {
                fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks,
              }
            : undefined),
          primary: modelRef,
        },
      },
    },
  };
}
