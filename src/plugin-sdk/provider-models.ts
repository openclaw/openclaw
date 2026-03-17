// Public model/catalog helpers for provider plugins.

export type {
  ModelApi,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "../config/types.models.js";
export type { ProviderPlugin } from "../plugins/types.js";

export { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
export { normalizeModelCompat } from "../agents/model-compat.js";
export { normalizeProviderId } from "../agents/provider-id.js";

export {
  applyGoogleGeminiModelDefault,
  GOOGLE_GEMINI_DEFAULT_MODEL,
} from "../commands/google-gemini-model-default.js";
export { applyOpenAIConfig, OPENAI_DEFAULT_MODEL } from "../commands/openai-model-default.js";
export { OPENCODE_GO_DEFAULT_MODEL_REF } from "../commands/opencode-go-model-default.js";
export { OPENCODE_ZEN_DEFAULT_MODEL } from "../commands/opencode-zen-model-default.js";
export { OPENCODE_ZEN_DEFAULT_MODEL_REF } from "../agents/opencode-zen-models.js";

export * from "../commands/onboard-auth.models.js";

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
