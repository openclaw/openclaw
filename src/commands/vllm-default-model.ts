import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { findNormalizedProviderKey, parseModelRef } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";

function hasConfiguredProvider(cfg: OpenClawConfig, provider: string): boolean {
  return Boolean(findNormalizedProviderKey(cfg.models?.providers, provider));
}

export function applyVllmDefaultModel(cfg: OpenClawConfig, modelRef: string): OpenClawConfig {
  const existingModel = cfg.agents?.defaults?.model;
  const fallbacks =
    existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks?.filter((fallback) =>
          isAvailableModelRef(cfg, fallback),
        )
      : undefined;

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        model: {
          ...(fallbacks ? { fallbacks } : undefined),
          primary: modelRef,
        },
      },
    },
  };
}

export function isManagedVllmProvider(provider: string): boolean {
  return provider === "vllm" || provider.startsWith("vllm-");
}

export function isStaleManagedVllmModelRef(
  cfg: OpenClawConfig,
  modelRef: string | undefined,
): boolean {
  if (!modelRef) {
    return false;
  }
  const parsed = parseModelRef(modelRef, DEFAULT_PROVIDER);
  return Boolean(
    parsed &&
    isManagedVllmProvider(parsed.provider) &&
    !hasConfiguredProvider(cfg, parsed.provider),
  );
}

function isAvailableModelRef(cfg: OpenClawConfig, modelRef: string): boolean {
  const parsed = parseModelRef(modelRef, DEFAULT_PROVIDER);
  if (!parsed) {
    return false;
  }
  return !isManagedVllmProvider(parsed.provider) || hasConfiguredProvider(cfg, parsed.provider);
}

export function clearStaleVllmModelConfig(
  cfg: OpenClawConfig,
  modelConfig: AgentModelConfig | undefined,
): AgentModelConfig | undefined {
  if (!modelConfig) {
    return undefined;
  }

  const primaryRaw =
    typeof modelConfig === "string"
      ? modelConfig
      : typeof modelConfig === "object" && "primary" in modelConfig
        ? modelConfig.primary
        : undefined;
  const filteredFallbacks =
    typeof modelConfig === "object" && "fallbacks" in modelConfig
      ? Array.isArray(modelConfig.fallbacks)
        ? modelConfig.fallbacks.filter((modelRef) => isAvailableModelRef(cfg, modelRef))
        : []
      : undefined;
  const parsed = primaryRaw ? parseModelRef(primaryRaw, DEFAULT_PROVIDER) : null;

  if (
    !parsed ||
    !isManagedVllmProvider(parsed.provider) ||
    hasConfiguredProvider(cfg, parsed.provider)
  ) {
    if (filteredFallbacks === undefined || typeof modelConfig !== "object") {
      return modelConfig;
    }

    const existingFallbacks = Array.isArray(modelConfig.fallbacks) ? modelConfig.fallbacks : [];
    if (filteredFallbacks.length === existingFallbacks.length) {
      return modelConfig;
    }

    return {
      ...(filteredFallbacks.length > 0 ? { fallbacks: filteredFallbacks } : {}),
      primary: modelConfig.primary ?? primaryRaw ?? "",
    };
  }

  if (filteredFallbacks !== undefined) {
    const [nextPrimary, ...remainingFallbacks] = filteredFallbacks;
    if (nextPrimary) {
      return {
        ...(remainingFallbacks.length > 0 ? { fallbacks: remainingFallbacks } : {}),
        primary: nextPrimary,
      };
    }
  }

  return undefined;
}

export function clearStaleVllmDefaultModel(cfg: OpenClawConfig): OpenClawConfig {
  const defaultModel = cfg.agents?.defaults?.model;
  if (!defaultModel) {
    return cfg;
  }

  const nextModel = clearStaleVllmModelConfig(cfg, defaultModel);
  if (nextModel === defaultModel) {
    return cfg;
  }

  const defaults = { ...cfg.agents?.defaults };
  if (nextModel) {
    defaults.model = nextModel;
  } else {
    delete defaults.model;
  }

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults,
    },
  };
}
