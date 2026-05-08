import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  resolvePrimaryStringValue,
} from "../shared/string-coerce.js";
import type { AgentModelConfig } from "./types.agents-shared.js";

type AgentModelListLike = {
  primary?: string;
  fallbacks?: string[];
  timeoutMs?: number;
};

const GOOGLE_CONFIG_MODEL_PROVIDERS = new Set(["google", "google-gemini-cli", "google-vertex"]);
const GOOGLE_CONFIG_MODEL_ALIASES = new Map([
  ["gemini-3-pro", "gemini-3.1-pro-preview"],
  ["gemini-3-pro-preview", "gemini-3.1-pro-preview"],
  ["gemini-3.1-pro", "gemini-3.1-pro-preview"],
  ["gemini-3-flash", "gemini-3-flash-preview"],
  ["gemini-3.1-flash", "gemini-3-flash-preview"],
  ["gemini-3.1-flash-preview", "gemini-3-flash-preview"],
  ["gemini-3.1-flash-lite", "gemini-3.1-flash-lite-preview"],
]);

function modelKeyForConfig(provider: string, model: string): string {
  const providerId = provider.trim();
  const modelId = model.trim();
  if (!providerId) {
    return modelId;
  }
  if (!modelId) {
    return providerId;
  }
  return normalizeLowercaseStringOrEmpty(modelId).startsWith(
    `${normalizeLowercaseStringOrEmpty(providerId)}/`,
  )
    ? modelId
    : `${providerId}/${modelId}`;
}

function normalizeGoogleConfigModelId(model: string): string {
  return GOOGLE_CONFIG_MODEL_ALIASES.get(normalizeLowercaseStringOrEmpty(model)) ?? model;
}

export function resolveAgentModelPrimaryValue(model?: AgentModelConfig): string | undefined {
  return resolvePrimaryStringValue(model);
}

export function resolveAgentModelFallbackValues(model?: AgentModelConfig): string[] {
  if (!model || typeof model !== "object") {
    return [];
  }
  return Array.isArray(model.fallbacks) ? model.fallbacks : [];
}

export function resolveAgentModelTimeoutMsValue(model?: AgentModelConfig): number | undefined {
  if (!model || typeof model !== "object") {
    return undefined;
  }
  return typeof model.timeoutMs === "number" &&
    Number.isFinite(model.timeoutMs) &&
    model.timeoutMs > 0
    ? Math.floor(model.timeoutMs)
    : undefined;
}

export function toAgentModelListLike(model?: AgentModelConfig): AgentModelListLike | undefined {
  if (typeof model === "string") {
    const primary = normalizeOptionalString(model);
    return primary ? { primary } : undefined;
  }
  if (!model || typeof model !== "object") {
    return undefined;
  }
  return model;
}

export function normalizeAgentModelRefForConfig(model: string): string {
  const trimmed = model.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return trimmed;
  }

  const provider = normalizeLowercaseStringOrEmpty(trimmed.slice(0, slash));
  if (!GOOGLE_CONFIG_MODEL_PROVIDERS.has(provider)) {
    return trimmed;
  }

  const normalizedModel = normalizeGoogleConfigModelId(trimmed.slice(slash + 1));
  return modelKeyForConfig(provider, normalizedModel);
}
