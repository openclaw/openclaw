// Shared model/catalog helpers for provider plugins.
//
// Keep provider-owned exports out of this subpath so plugin loaders can import it
// without recursing through provider-specific facades.

import type { BedrockDiscoveryConfig, ModelDefinitionConfig } from "../config/types.models.js";

export type { ModelApi, ModelProviderConfig } from "../config/types.models.js";
export type {
  BedrockDiscoveryConfig,
  ModelCompatConfig,
  ModelDefinitionConfig,
} from "../config/types.models.js";
export type {
  ProviderEndpointClass,
  ProviderEndpointResolution,
} from "../agents/provider-attribution.js";
export type { ProviderPlugin } from "../plugins/types.js";
export type { KilocodeModelCatalogEntry } from "../plugins/provider-model-kilocode.js";

export { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
export { resolveProviderEndpoint } from "../agents/provider-attribution.js";
export {
  applyModelCompatPatch,
  hasToolSchemaProfile,
  hasNativeWebSearchTool,
  normalizeModelCompat,
  resolveUnsupportedToolSchemaKeywords,
  resolveToolCallArgumentsEncoding,
} from "../plugins/provider-model-compat.js";
export { normalizeProviderId } from "../agents/provider-id.js";
export {
  buildOpenAICompatibleReplayPolicy,
  buildStrictAnthropicReplayPolicy,
} from "../plugins/provider-replay-helpers.js";
export {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
} from "../agents/pi-embedded-runner/moonshot-thinking-stream-wrappers.js";
export {
  cloneFirstTemplateModel,
  matchesExactOrPrefix,
} from "../plugins/provider-model-helpers.js";

export function getModelProviderHint(modelId: string): string | null {
  const trimmed = modelId.trim().toLowerCase();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0) {
    return null;
  }
  return trimmed.slice(0, slashIndex) || null;
}

export function isProxyReasoningUnsupportedModelHint(modelId: string): boolean {
  return getModelProviderHint(modelId) === "x-ai";
}

const ANTIGRAVITY_BARE_PRO_IDS = new Set(["gemini-3-pro", "gemini-3.1-pro", "gemini-3-1-pro"]);

export function normalizeGooglePreviewModelId(id: string): string {
  if (id === "gemini-3-pro") {
    return "gemini-3-pro-preview";
  }
  if (id === "gemini-3-flash") {
    return "gemini-3-flash-preview";
  }
  if (id === "gemini-3.1-pro") {
    return "gemini-3.1-pro-preview";
  }
  if (id === "gemini-3.1-flash-lite") {
    return "gemini-3.1-flash-lite-preview";
  }
  if (id === "gemini-3.1-flash" || id === "gemini-3.1-flash-preview") {
    return "gemini-3-flash-preview";
  }
  return id;
}

export function normalizeAntigravityPreviewModelId(id: string): string {
  if (ANTIGRAVITY_BARE_PRO_IDS.has(id)) {
    return `${id}-low`;
  }
  return id;
}

export function normalizeNativeXaiModelId(id: string): string {
  if (id === "grok-4-fast-reasoning") {
    return "grok-4-fast";
  }
  if (id === "grok-4-1-fast-reasoning") {
    return "grok-4-1-fast";
  }
  if (id === "grok-4.20-experimental-beta-0304-reasoning") {
    return "grok-4.20-beta-latest-reasoning";
  }
  if (id === "grok-4.20-experimental-beta-0304-non-reasoning") {
    return "grok-4.20-beta-latest-non-reasoning";
  }
  if (id === "grok-4.20-reasoning") {
    return "grok-4.20-beta-latest-reasoning";
  }
  if (id === "grok-4.20-non-reasoning") {
    return "grok-4.20-beta-latest-non-reasoning";
  }
  return id;
}
