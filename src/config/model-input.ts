import { modelKey, normalizeStaticProviderModelId } from "../agents/model-ref-shared.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import { normalizeOptionalString, resolvePrimaryStringValue } from "../shared/string-coerce.js";
import type { AgentModelConfig } from "./types.agents-shared.js";

type AgentModelListLike = {
  primary?: string;
  fallbacks?: string[];
  timeoutMs?: number;
};

const GOOGLE_CONFIG_MODEL_PROVIDERS = new Set(["google", "google-gemini-cli", "google-vertex"]);

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

  const provider = normalizeProviderId(trimmed.slice(0, slash));
  if (!GOOGLE_CONFIG_MODEL_PROVIDERS.has(provider)) {
    return trimmed;
  }

  const normalizedModel = normalizeStaticProviderModelId(provider, trimmed.slice(slash + 1));
  return modelKey(provider, normalizedModel);
}
