// Public model/catalog helpers for provider plugins.

import type { BedrockDiscoveryConfig, ModelDefinitionConfig } from "../config/types.models.js";

export type { ModelApi, ModelProviderConfig } from "../config/types.models.js";
export type { BedrockDiscoveryConfig, ModelDefinitionConfig } from "../config/types.models.js";
export type { ProviderPlugin } from "../plugins/types.js";
export type { KilocodeModelCatalogEntry } from "../plugins/provider-model-kilocode.js";

export { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
export {
  hasNativeWebSearchTool,
  HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING,
  normalizeModelCompat,
  resolveToolCallArgumentsEncoding,
  usesXaiToolSchemaProfile,
  XAI_TOOL_SCHEMA_PROFILE,
} from "../agents/model-compat.js";
export { normalizeProviderId } from "../agents/provider-id.js";
export { applyXaiModelCompat, normalizeXaiModelId } from "./xai.js";
export {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
} from "../agents/pi-embedded-runner/moonshot-thinking-stream-wrappers.js";
export {
  cloneFirstTemplateModel,
  matchesExactOrPrefix,
} from "../plugins/provider-model-helpers.js";
export {
  MINIMAX_DEFAULT_MODEL_ID,
  MINIMAX_DEFAULT_MODEL_REF,
  MINIMAX_TEXT_MODEL_CATALOG,
  MINIMAX_TEXT_MODEL_ORDER,
  MINIMAX_TEXT_MODEL_REFS,
  isMiniMaxModernModelId,
} from "./minimax.js";

// Deprecated compat aliases. Prefer provider-specific subpaths.
export { applyGoogleGeminiModelDefault, GOOGLE_GEMINI_DEFAULT_MODEL } from "./google.js";
export {
  applyOpenAIConfig,
  OPENAI_CODEX_DEFAULT_MODEL,
  OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
  OPENAI_DEFAULT_EMBEDDING_MODEL,
  OPENAI_DEFAULT_IMAGE_MODEL,
  OPENAI_DEFAULT_MODEL,
  OPENAI_DEFAULT_TTS_MODEL,
  OPENAI_DEFAULT_TTS_VOICE,
} from "./openai.js";
export { OPENCODE_GO_DEFAULT_MODEL_REF, applyOpencodeGoModelDefault } from "./opencode-go.js";
export {
  OPENCODE_ZEN_DEFAULT_MODEL,
  OPENCODE_ZEN_DEFAULT_MODEL_REF,
  applyOpencodeZenModelDefault,
} from "./opencode.js";

export {
  buildCloudflareAiGatewayModelDefinition,
  CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  resolveCloudflareAiGatewayBaseUrl,
} from "./cloudflare-ai-gateway.js";
export { resolveAnthropicVertexRegion } from "./anthropic-vertex.js";
export {
  discoverHuggingfaceModels,
  HUGGINGFACE_BASE_URL,
  HUGGINGFACE_MODEL_CATALOG,
  buildHuggingfaceModelDefinition,
} from "./huggingface.js";
export { discoverKilocodeModels } from "./kilocode.js";
export {
  buildChutesModelDefinition,
  CHUTES_BASE_URL,
  CHUTES_DEFAULT_MODEL_ID,
  CHUTES_DEFAULT_MODEL_REF,
  CHUTES_MODEL_CATALOG,
  discoverChutesModels,
} from "./chutes.js";
export {
  buildOllamaModelDefinition,
  enrichOllamaModelsWithContext,
  fetchOllamaModels,
  queryOllamaContextWindow,
  resolveOllamaApiBase,
  type OllamaModelWithContext,
  type OllamaTagModel,
  type OllamaTagsResponse,
} from "./ollama-surface.js";
export {
  buildSyntheticModelDefinition,
  SYNTHETIC_BASE_URL,
  SYNTHETIC_DEFAULT_MODEL_REF,
  SYNTHETIC_MODEL_CATALOG,
} from "./synthetic.js";
export {
  buildDeepSeekModelDefinition,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL_CATALOG,
} from "./deepseek.js";
export {
  buildTogetherModelDefinition,
  TOGETHER_BASE_URL,
  TOGETHER_MODEL_CATALOG,
} from "./together.js";
export {
  discoverVeniceModels,
  VENICE_BASE_URL,
  VENICE_DEFAULT_MODEL_REF,
  VENICE_MODEL_CATALOG,
  buildVeniceModelDefinition,
} from "./venice.js";
export {
  BYTEPLUS_BASE_URL,
  BYTEPLUS_CODING_BASE_URL,
  BYTEPLUS_CODING_MODEL_CATALOG,
  BYTEPLUS_MODEL_CATALOG,
  buildBytePlusModelDefinition,
} from "./byteplus.js";
export {
  DOUBAO_BASE_URL,
  DOUBAO_CODING_BASE_URL,
  DOUBAO_CODING_MODEL_CATALOG,
  DOUBAO_MODEL_CATALOG,
  buildDoubaoModelDefinition,
} from "./volcengine.js";
export {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_CONTEXT_WINDOW,
  OLLAMA_DEFAULT_COST,
  OLLAMA_DEFAULT_MAX_TOKENS,
} from "./ollama-surface.js";
export { VLLM_DEFAULT_BASE_URL } from "./vllm.js";
export { SGLANG_DEFAULT_BASE_URL } from "./sglang.js";
export {
  buildKilocodeModelDefinition,
  KILOCODE_BASE_URL,
  KILOCODE_DEFAULT_CONTEXT_WINDOW,
  KILOCODE_DEFAULT_COST,
  KILOCODE_DEFAULT_MODEL_REF,
  KILOCODE_DEFAULT_MAX_TOKENS,
  KILOCODE_DEFAULT_MODEL_ID,
  KILOCODE_DEFAULT_MODEL_NAME,
  KILOCODE_MODEL_CATALOG,
} from "./kilocode.js";
export { discoverVercelAiGatewayModels, VERCEL_AI_GATEWAY_BASE_URL } from "./vercel-ai-gateway.js";
export {
  buildModelStudioDefaultModelDefinition,
  buildModelStudioModelDefinition,
  MODELSTUDIO_CN_BASE_URL,
  MODELSTUDIO_DEFAULT_COST,
  MODELSTUDIO_DEFAULT_MODEL_ID,
  MODELSTUDIO_DEFAULT_MODEL_REF,
  MODELSTUDIO_GLOBAL_BASE_URL,
} from "./modelstudio.js";
