// Public model/catalog helpers for provider plugins.

import type { ModelDefinitionConfig } from "../config/types.models.js";
import {
  KILOCODE_DEFAULT_CONTEXT_WINDOW,
  KILOCODE_DEFAULT_COST,
  KILOCODE_DEFAULT_MAX_TOKENS,
  KILOCODE_DEFAULT_MODEL_ID,
  KILOCODE_DEFAULT_MODEL_NAME,
} from "../providers/kilocode-shared.js";

export type { ModelApi, ModelProviderConfig } from "../config/types.models.js";
export type { ModelDefinitionConfig } from "../config/types.models.js";
export type { ProviderPlugin } from "../plugins/types.js";

export { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
export {
  applyXaiModelCompat,
  hasNativeWebSearchTool,
  HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING,
  normalizeModelCompat,
  resolveToolCallArgumentsEncoding,
  usesXaiToolSchemaProfile,
  XAI_TOOL_SCHEMA_PROFILE,
} from "../agents/model-compat.js";
export { normalizeProviderId } from "../agents/provider-id.js";
export { cloneFirstTemplateModel } from "../plugins/provider-model-helpers.js";

export {
  applyGoogleGeminiModelDefault,
  GOOGLE_GEMINI_DEFAULT_MODEL,
} from "../plugins/provider-model-defaults.js";
export { applyOpenAIConfig, OPENAI_DEFAULT_MODEL } from "../plugins/provider-model-defaults.js";
export { OPENCODE_GO_DEFAULT_MODEL_REF } from "../plugins/provider-model-defaults.js";
export { OPENCODE_ZEN_DEFAULT_MODEL } from "../plugins/provider-model-defaults.js";
export { OPENCODE_ZEN_DEFAULT_MODEL_REF } from "../agents/opencode-zen-models.js";

export {
  buildCloudflareAiGatewayModelDefinition,
  CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  resolveCloudflareAiGatewayBaseUrl,
} from "../agents/cloudflare-ai-gateway.js";
export {
  discoverHuggingfaceModels,
  HUGGINGFACE_BASE_URL,
  HUGGINGFACE_MODEL_CATALOG,
  buildHuggingfaceModelDefinition,
} from "../agents/huggingface-models.js";
export { discoverKilocodeModels } from "../agents/kilocode-models.js";
export {
  buildChutesModelDefinition,
  CHUTES_BASE_URL,
  CHUTES_DEFAULT_MODEL_ID,
  CHUTES_DEFAULT_MODEL_REF,
  CHUTES_MODEL_CATALOG,
  discoverChutesModels,
} from "../agents/chutes-models.js";
export { resolveOllamaApiBase } from "../agents/ollama-models.js";
export {
  buildSyntheticModelDefinition,
  SYNTHETIC_BASE_URL,
  SYNTHETIC_DEFAULT_MODEL_REF,
  SYNTHETIC_MODEL_CATALOG,
} from "../agents/synthetic-models.js";
export {
  buildTogetherModelDefinition,
  TOGETHER_BASE_URL,
  TOGETHER_MODEL_CATALOG,
} from "../agents/together-models.js";
export {
  discoverVeniceModels,
  VENICE_BASE_URL,
  VENICE_DEFAULT_MODEL_REF,
  VENICE_MODEL_CATALOG,
  buildVeniceModelDefinition,
} from "../agents/venice-models.js";
export {
  BYTEPLUS_BASE_URL,
  BYTEPLUS_CODING_BASE_URL,
  BYTEPLUS_CODING_MODEL_CATALOG,
  BYTEPLUS_MODEL_CATALOG,
  buildBytePlusModelDefinition,
} from "../agents/byteplus-models.js";
export {
  DOUBAO_BASE_URL,
  DOUBAO_CODING_BASE_URL,
  DOUBAO_CODING_MODEL_CATALOG,
  DOUBAO_MODEL_CATALOG,
  buildDoubaoModelDefinition,
} from "../agents/doubao-models.js";
export { OLLAMA_DEFAULT_BASE_URL } from "../agents/ollama-defaults.js";
export { VLLM_DEFAULT_BASE_URL } from "../agents/vllm-defaults.js";
export { SGLANG_DEFAULT_BASE_URL } from "../agents/sglang-defaults.js";
export {
  KILOCODE_BASE_URL,
  KILOCODE_DEFAULT_CONTEXT_WINDOW,
  KILOCODE_DEFAULT_COST,
  KILOCODE_DEFAULT_MODEL_REF,
  KILOCODE_DEFAULT_MAX_TOKENS,
  KILOCODE_DEFAULT_MODEL_ID,
  KILOCODE_DEFAULT_MODEL_NAME,
  KILOCODE_MODEL_CATALOG,
} from "../providers/kilocode-shared.js";
export {
  discoverVercelAiGatewayModels,
  VERCEL_AI_GATEWAY_BASE_URL,
} from "../agents/vercel-ai-gateway.js";

export function buildKilocodeModelDefinition(): ModelDefinitionConfig {
  return {
    id: KILOCODE_DEFAULT_MODEL_ID,
    name: KILOCODE_DEFAULT_MODEL_NAME,
    reasoning: true,
    input: ["text", "image"],
    cost: KILOCODE_DEFAULT_COST,
    contextWindow: KILOCODE_DEFAULT_CONTEXT_WINDOW,
    maxTokens: KILOCODE_DEFAULT_MAX_TOKENS,
  };
}
