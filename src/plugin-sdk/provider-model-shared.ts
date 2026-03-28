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
export type { ProviderPlugin } from "../plugins/types.js";
export type { KilocodeModelCatalogEntry } from "../plugins/provider-model-kilocode.js";

export { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
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
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
} from "../agents/pi-embedded-runner/moonshot-thinking-stream-wrappers.js";
export {
  cloneFirstTemplateModel,
  matchesExactOrPrefix,
} from "../plugins/provider-model-helpers.js";
