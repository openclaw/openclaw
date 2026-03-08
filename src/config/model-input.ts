import type { ChatType } from "../channels/chat-type.js";
import type { AgentModelConfig, AgentModelByChatType } from "./types.agents-shared.js";

export type { AgentModelConfig, AgentModelByChatType };

type AgentModelListLike = {
  primary?: string;
  fallbacks?: string[];
  byChatType?: AgentModelByChatType;
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

/**
 * Get the model override for a specific chat type (direct/group/channel).
 * Returns undefined if no override is configured for that chat type.
 * Trims whitespace from the override value for consistency with primary model resolution.
 */
export function resolveAgentModelByChatType(
  model?: AgentModelConfig,
  chatType?: ChatType,
): string | undefined {
  // Consistent behavior: only return an override if chatType is provided AND configured
  if (!chatType || !model || typeof model !== "object") {
    return undefined;
  }
  const override = model.byChatType?.[chatType];
  // Trim whitespace from the override value, like we do for primary
  if (override) {
    const trimmed = override.trim();
    return trimmed || undefined;
  }
  return undefined;
}

/**
 * Resolves the effective model for a given chat type.
 * Priority:
 * 1. byChatType[chatType] if configured
 * 2. primary model fallback
 */
export function resolveEffectiveModelForChatType(
  model?: AgentModelConfig,
  chatType?: ChatType,
): string | undefined {
  // Check chat-type specific override first
  const chatTypeModel = resolveAgentModelByChatType(model, chatType);
  if (chatTypeModel) {
    return chatTypeModel;
  }
  // Fall back to primary model
  return resolveAgentModelPrimaryValue(model);
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
