import type { AgentDefaultModelConfig, AgentModelListConfig } from "./types.agent-defaults.js";
import type { AgentModelConfig } from "./types.agents-shared.js";

type AgentModelInput = AgentModelConfig | AgentDefaultModelConfig;

export function resolveAgentModelPrimaryValue(model?: AgentModelInput): string | undefined {
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

export function resolveAgentModelFallbackValues(model?: AgentModelInput): string[] {
  if (!model || typeof model !== "object") {
    return [];
  }
  return Array.isArray(model.fallbacks) ? model.fallbacks : [];
}

export function hasAgentModelFallbacksField(model?: AgentModelInput): boolean {
  return Boolean(model && typeof model === "object" && Object.hasOwn(model, "fallbacks"));
}

export function resolveAgentModelFallbacksFromModelsValue(
  model?: AgentDefaultModelConfig,
): boolean {
  if (!model || typeof model !== "object") {
    return false;
  }
  return model.fallbacksFromModels === true;
}

export function toAgentModelListLike(model?: AgentModelInput): AgentModelListConfig | undefined {
  if (typeof model === "string") {
    const primary = model.trim();
    return primary ? { primary } : undefined;
  }
  if (!model || typeof model !== "object") {
    return undefined;
  }
  return model;
}
