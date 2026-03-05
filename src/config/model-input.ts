import type { ChatType } from "../channels/chat-type.js";
import type { AgentModelConfig, AgentModelByChatType } from "./types.agents-shared.js";

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

export function resolveAgentModelByChatType(
  model?: AgentModelConfig,
  chatType?: ChatType,
): string | undefined {
  // If no chat type specified, fall back to primary model
  if (!chatType) {
    return resolveAgentModelPrimaryValue(model);
  }
  if (!model || typeof model !== "object") {
    return undefined;
  }
  const byChatType = model.byChatType;
  if (!byChatType) {
    return undefined;
  }
  return byChatType[chatType];
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
