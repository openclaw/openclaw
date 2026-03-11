import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { parseModelRef } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";

export function applyVllmDefaultModel(cfg: OpenClawConfig, modelRef: string): OpenClawConfig {
  const existingModel = cfg.agents?.defaults?.model;
  const fallbacks =
    existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks
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
    parsed && isManagedVllmProvider(parsed.provider) && !cfg.models?.providers?.[parsed.provider],
  );
}

function isAvailableModelRef(cfg: OpenClawConfig, modelRef: string): boolean {
  const parsed = parseModelRef(modelRef, DEFAULT_PROVIDER);
  if (!parsed) {
    return false;
  }
  return (
    !isManagedVllmProvider(parsed.provider) || Boolean(cfg.models?.providers?.[parsed.provider])
  );
}

export function clearStaleVllmDefaultModel(cfg: OpenClawConfig): OpenClawConfig {
  const defaultModel = cfg.agents?.defaults?.model;
  if (!defaultModel) {
    return cfg;
  }

  const primaryRaw =
    typeof defaultModel === "string"
      ? defaultModel
      : typeof defaultModel === "object" && "primary" in defaultModel
        ? defaultModel.primary
        : undefined;
  const filteredFallbacks =
    typeof defaultModel === "object" && "fallbacks" in defaultModel
      ? Array.isArray(defaultModel.fallbacks)
        ? defaultModel.fallbacks.filter((modelRef) => isAvailableModelRef(cfg, modelRef))
        : []
      : undefined;
  const parsed = primaryRaw ? parseModelRef(primaryRaw, DEFAULT_PROVIDER) : null;
  if (
    !parsed ||
    !isManagedVllmProvider(parsed.provider) ||
    cfg.models?.providers?.[parsed.provider]
  ) {
    if (filteredFallbacks === undefined) {
      return cfg;
    }

    const existingFallbacks = Array.isArray(defaultModel.fallbacks) ? defaultModel.fallbacks : [];
    if (filteredFallbacks.length === existingFallbacks.length) {
      return cfg;
    }

    const defaults = { ...cfg.agents?.defaults };
    defaults.model = {
      ...(filteredFallbacks.length > 0 ? { fallbacks: filteredFallbacks } : {}),
      primary:
        typeof defaultModel === "object" && "primary" in defaultModel
          ? defaultModel.primary
          : (primaryRaw ?? ""),
    };

    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults,
      },
    };
  }

  const defaults = { ...cfg.agents?.defaults };
  if (filteredFallbacks !== undefined) {
    const [nextPrimary, ...remainingFallbacks] = filteredFallbacks;
    if (nextPrimary) {
      defaults.model = {
        ...(remainingFallbacks.length > 0 ? { fallbacks: remainingFallbacks } : {}),
        primary: nextPrimary,
      };
    } else {
      delete defaults.model;
    }
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
