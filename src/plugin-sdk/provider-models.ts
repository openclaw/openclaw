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
export { normalizeModelCompat } from "../agents/model-compat.js";
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
  buildMinimaxApiModelDefinition,
  DEFAULT_MINIMAX_BASE_URL,
  MINIMAX_API_BASE_URL,
  MINIMAX_CN_API_BASE_URL,
  MINIMAX_HOSTED_COST,
  MINIMAX_HOSTED_MODEL_ID,
  MINIMAX_HOSTED_MODEL_REF,
  MINIMAX_LM_STUDIO_COST,
} from "../../extensions/minimax/model-definitions.js";
export {
  buildMistralModelDefinition,
  MISTRAL_BASE_URL,
  MISTRAL_DEFAULT_MODEL_ID,
  MISTRAL_DEFAULT_MODEL_REF,
} from "../../extensions/mistral/model-definitions.js";
export {
  buildModelStudioDefaultModelDefinition,
  buildModelStudioModelDefinition,
  MODELSTUDIO_CN_BASE_URL,
  MODELSTUDIO_DEFAULT_MODEL_ID,
  MODELSTUDIO_DEFAULT_MODEL_REF,
  MODELSTUDIO_GLOBAL_BASE_URL,
} from "../../extensions/modelstudio/model-definitions.js";
export { MOONSHOT_BASE_URL } from "../../extensions/moonshot/provider-catalog.js";
export { MOONSHOT_CN_BASE_URL } from "../../extensions/moonshot/onboard.js";
export {
  buildXaiModelDefinition,
  XAI_BASE_URL,
  XAI_DEFAULT_MODEL_ID,
  XAI_DEFAULT_MODEL_REF,
} from "../../extensions/xai/model-definitions.js";
export {
  buildZaiModelDefinition,
  resolveZaiBaseUrl,
  ZAI_CODING_CN_BASE_URL,
  ZAI_CODING_GLOBAL_BASE_URL,
  ZAI_CN_BASE_URL,
  ZAI_DEFAULT_MODEL_ID,
  ZAI_DEFAULT_MODEL_REF,
  ZAI_GLOBAL_BASE_URL,
} from "../../extensions/zai/model-definitions.js";

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
