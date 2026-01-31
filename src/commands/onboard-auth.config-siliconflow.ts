import {
  getSiliconFlowStaticFallbackModels,
  SILICONFLOW_API_BASE_URL,
  SILICONFLOW_DEFAULT_MODEL_REF,
} from "../agents/siliconflow-models.js";
import type { OpenClawConfig } from "../config/config.js";

export { SILICONFLOW_DEFAULT_MODEL_REF } from "../agents/siliconflow-models.js";

/**
 * Apply SiliconFlow (硅基流动) provider configuration without changing the default model.
 * Registers SiliconFlow models and sets up the provider, but preserves existing model selection.
 */
export function applySiliconFlowProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[SILICONFLOW_DEFAULT_MODEL_REF] = {
    ...models[SILICONFLOW_DEFAULT_MODEL_REF],
    alias: models[SILICONFLOW_DEFAULT_MODEL_REF]?.alias ?? "DeepSeek",
  };

  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.siliconflow;
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  
  // Use static fallback models for initial configuration
  // The models will be dynamically fetched at runtime via fetchSiliconFlowModels
  const siliconflowModels = getSiliconFlowStaticFallbackModels();
  const mergedModels = [
    ...existingModels,
    ...siliconflowModels.filter(
      (model) => !existingModels.some((existing) => existing.id === model.id),
    ),
  ];
  
  const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as Record<
    string,
    unknown
  > as { apiKey?: string };
  const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : undefined;
  const normalizedApiKey = resolvedApiKey?.trim();
  
  providers.siliconflow = {
    ...existingProviderRest,
    baseUrl: SILICONFLOW_API_BASE_URL,
    api: "openai-completions",
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : siliconflowModels,
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
 * Apply SiliconFlow provider configuration AND set SiliconFlow as the default model.
 * Use this when SiliconFlow is the primary provider choice during onboarding.
 */
export function applySiliconFlowConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applySiliconFlowProviderConfig(cfg);
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
          primary: SILICONFLOW_DEFAULT_MODEL_REF,
        },
      },
    },
  };
}
