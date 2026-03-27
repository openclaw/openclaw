// Public provider catalog helpers for provider plugins.

export type { ProviderCatalogContext, ProviderCatalogResult } from "../plugins/types.js";

export {
  buildPairedProviderApiKeyCatalog,
  buildSingleProviderApiKeyCatalog,
  findCatalogTemplate,
} from "../plugins/provider-catalog.js";
export {
  ANTHROPIC_VERTEX_DEFAULT_MODEL_ID,
  buildAnthropicVertexProvider,
} from "../../extensions/anthropic-vertex/api.js";
export {
  buildBytePlusCodingProvider,
  buildBytePlusProvider,
} from "../../extensions/byteplus/api.js";
export { buildDeepSeekProvider } from "../../extensions/deepseek/api.js";
export { buildHuggingfaceProvider } from "../../extensions/huggingface/api.js";
export { buildKimiCodingProvider } from "../../extensions/kimi-coding/api.js";
export {
  buildKilocodeProvider,
  buildKilocodeProviderWithDiscovery,
} from "../../extensions/kilocode/api.js";
export {
  buildMinimaxPortalProvider,
  buildMinimaxProvider,
} from "../../extensions/minimax/api.js";
export {
  MODELSTUDIO_BASE_URL,
  MODELSTUDIO_DEFAULT_MODEL_ID,
  buildModelStudioProvider,
} from "../../extensions/modelstudio/api.js";
export { buildMoonshotProvider } from "../../extensions/moonshot/api.js";
export { buildNvidiaProvider } from "../../extensions/nvidia/api.js";
export { buildOpenAICodexProvider } from "../../extensions/openai/api.js";
export { buildOpenrouterProvider } from "../../extensions/openrouter/api.js";
export {
  QIANFAN_BASE_URL,
  QIANFAN_DEFAULT_MODEL_ID,
  buildQianfanProvider,
} from "../../extensions/qianfan/api.js";
export { buildSyntheticProvider } from "../../extensions/synthetic/api.js";
export { buildTogetherProvider } from "../../extensions/together/api.js";
export { buildVeniceProvider } from "../../extensions/venice/api.js";
export { buildVercelAiGatewayProvider } from "../../extensions/vercel-ai-gateway/api.js";
export {
  buildDoubaoCodingProvider,
  buildDoubaoProvider,
} from "../../extensions/volcengine/api.js";
export {
  XIAOMI_DEFAULT_MODEL_ID,
  buildXiaomiProvider,
} from "../../extensions/xiaomi/api.js";
