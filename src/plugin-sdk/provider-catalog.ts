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
} from "../../extensions/anthropic-vertex/provider-catalog.js";
export {
  buildBytePlusCodingProvider,
  buildBytePlusProvider,
} from "../../extensions/byteplus/provider-catalog.js";
export { buildHuggingfaceProvider } from "../../extensions/huggingface/provider-catalog.js";
export { buildKimiCodingProvider } from "../../extensions/kimi-coding/provider-catalog.js";
export {
  buildKilocodeProvider,
  buildKilocodeProviderWithDiscovery,
} from "../../extensions/kilocode/provider-catalog.js";
export {
  buildMinimaxPortalProvider,
  buildMinimaxProvider,
} from "../../extensions/minimax/provider-catalog.js";
export {
  MODELSTUDIO_BASE_URL,
  MODELSTUDIO_DEFAULT_MODEL_ID,
  buildModelStudioProvider,
} from "../../extensions/modelstudio/provider-catalog.js";
export { buildMoonshotProvider } from "../../extensions/moonshot/provider-catalog.js";
export { buildNvidiaProvider } from "../../extensions/nvidia/provider-catalog.js";
export { buildOpenAICodexProvider } from "../../extensions/openai/openai-codex-catalog.js";
export { buildOpenrouterProvider } from "../../extensions/openrouter/provider-catalog.js";
export {
  QIANFAN_BASE_URL,
  QIANFAN_DEFAULT_MODEL_ID,
  buildQianfanProvider,
} from "../../extensions/qianfan/provider-catalog.js";
export { buildQwenPortalProvider } from "../../extensions/qwen-portal-auth/provider-catalog.js";
export { buildSyntheticProvider } from "../../extensions/synthetic/provider-catalog.js";
export { buildTogetherProvider } from "../../extensions/together/provider-catalog.js";
export { buildVeniceProvider } from "../../extensions/venice/provider-catalog.js";
export { buildVercelAiGatewayProvider } from "../../extensions/vercel-ai-gateway/provider-catalog.js";
export {
  buildDoubaoCodingProvider,
  buildDoubaoProvider,
} from "../../extensions/volcengine/provider-catalog.js";
export {
  XIAOMI_DEFAULT_MODEL_ID,
  buildXiaomiProvider,
} from "../../extensions/xiaomi/provider-catalog.js";
