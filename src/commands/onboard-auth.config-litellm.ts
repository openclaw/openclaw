import type { OpenClawConfig } from "../config/config.js";
import { LITELLM_DEFAULT_MODEL_REF } from "./onboard-auth.credentials.js";

export const LITELLM_BASE_URL = "http://localhost:4000";
export const LITELLM_DEFAULT_MODEL_ID = "claude-opus-4-6";
const LITELLM_DEFAULT_CONTEXT_WINDOW = 128_000;
const LITELLM_DEFAULT_MAX_TOKENS = 8_192;
const LITELLM_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function buildLitellmModelDefinition(): {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
} {
  return {
    id: LITELLM_DEFAULT_MODEL_ID,
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: LITELLM_DEFAULT_COST,
    contextWindow: LITELLM_DEFAULT_CONTEXT_WINDOW,
    maxTokens: LITELLM_DEFAULT_MAX_TOKENS,
  };
}

export function applyLitellmProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[LITELLM_DEFAULT_MODEL_REF] = {
    ...models[LITELLM_DEFAULT_MODEL_REF],
    alias: models[LITELLM_DEFAULT_MODEL_REF]?.alias ?? "LiteLLM",
  };

  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.litellm;
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const defaultModel = buildLitellmModelDefinition();
  const hasDefaultModel = existingModels.some((model) => model.id === LITELLM_DEFAULT_MODEL_ID);
  const mergedModels = hasDefaultModel ? existingModels : [...existingModels, defaultModel];
  const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as Record<
    string,
    unknown
  > as { apiKey?: string };
  const resolvedBaseUrl =
    typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "";
  const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : undefined;
  const normalizedApiKey = resolvedApiKey?.trim();
  providers.litellm = {
    ...existingProviderRest,
    baseUrl: resolvedBaseUrl || LITELLM_BASE_URL,
    api: "openai-completions",
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : [defaultModel],
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

export function applyLitellmConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyLitellmProviderConfig(cfg);
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
          primary: LITELLM_DEFAULT_MODEL_REF,
        },
      },
    },
  };
}
