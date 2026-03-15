import type { AgentModelConfig } from "./types.agents-shared.js";

type AgentModelListLike = {
  primary?: string;
  fallbacks?: string[];
};

export function resolveAgentModelPrimaryValue(model?: AgentModelConfig): string | undefined {
  if (typeof model === "string") {
    const trimmed = model.trim();
    return trimmed || undefined;
  }
  if (!model || typeof model !== "object") {
    return undefined;
  }
  const primary = model.primary?.trim();
  return primary || undefined;
}

export function resolveAgentModelFallbackValues(model?: AgentModelConfig): string[] {
  if (!model || typeof model !== "object") {
    return [];
  }
  return Array.isArray(model.fallbacks) ? model.fallbacks : [];
}

export function toAgentModelListLike(model?: AgentModelConfig): AgentModelListLike | undefined {
  if (typeof model === "string") {
    const primary = model.trim();
    return primary ? { primary } : undefined;
  }
  if (!model || typeof model !== "object") {
    return undefined;
  }
  return model;
}

const DEFAULT_FALLBACK_ATTEMPT_TIMEOUT_SECONDS = 120;

export function resolveAgentModelFallbackAttemptTimeoutMs(
  agentModel?: AgentModelConfig,
  defaultsModel?: AgentModelConfig,
): number | undefined {
  // Prefer agent-scoped config, fall back to global defaults.
  const model =
    agentModel &&
    typeof agentModel === "object" &&
    Object.hasOwn(agentModel, "fallbackAttemptTimeoutSeconds")
      ? agentModel
      : defaultsModel;
  if (!model || typeof model !== "object") {
    return DEFAULT_FALLBACK_ATTEMPT_TIMEOUT_SECONDS * 1000;
  }
  const seconds = model.fallbackAttemptTimeoutSeconds;
  if (seconds === 0) {
    return undefined;
  }
  return (
    (seconds != null && seconds > 0 ? seconds : DEFAULT_FALLBACK_ATTEMPT_TIMEOUT_SECONDS) * 1000
  );
}
