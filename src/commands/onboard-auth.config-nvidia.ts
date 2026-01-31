import {
  buildNvidiaProvider,
  getNvidiaStaticFallbackModels,
  NVIDIA_API_BASE_URL,
} from "../agents/nvidia-models.js";
import type { OpenClawConfig } from "../config/config.js";

export const NVIDIA_DEFAULT_MODEL_REF = "nvidia/llama-3.3-70b-instruct";

/**
 * Apply NVIDIA NIM provider configuration without changing the default model.
 * Registers NVIDIA NIM models and sets up the provider, but preserves existing model selection.
 */
export function applyNvidiaProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[NVIDIA_DEFAULT_MODEL_REF] = {
    ...models[NVIDIA_DEFAULT_MODEL_REF],
    alias: models[NVIDIA_DEFAULT_MODEL_REF]?.alias ?? "Llama",
  };

  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.nvidia;
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];

  // Use static fallback models for initial configuration
  const nvidiaModels = getNvidiaStaticFallbackModels();
  const mergedModels = [
    ...existingModels,
    ...nvidiaModels.filter(
      (model) => !existingModels.some((existing) => existing.id === model.id),
    ),
  ];

  const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as Record<
    string,
    unknown
  > as { apiKey?: string };
  const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : undefined;
  const normalizedApiKey = resolvedApiKey?.trim();

  providers.nvidia = {
    ...existingProviderRest,
    baseUrl: NVIDIA_API_BASE_URL,
    api: "openai-completions",
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : nvidiaModels,
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
 * Apply NVIDIA NIM provider configuration AND set NVIDIA as the default model.
 * Use this when NVIDIA NIM is the primary provider choice during onboarding.
 */
export function applyNvidiaConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyNvidiaProviderConfig(cfg);
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
          primary: NVIDIA_DEFAULT_MODEL_REF,
        },
      },
    },
  };
}
