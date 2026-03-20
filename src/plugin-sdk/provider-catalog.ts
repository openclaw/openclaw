// Public provider catalog helpers for provider plugins.

export type { ProviderCatalogContext, ProviderCatalogResult } from "./provider-catalog-shared.js";
export {
  buildPairedProviderApiKeyCatalog,
  buildSingleProviderApiKeyCatalog,
  findCatalogTemplate,
} from "./provider-catalog-shared.js";
export {
  ANTHROPIC_VERTEX_DEFAULT_MODEL_ID,
  buildAnthropicVertexProvider,
} from "./anthropic-vertex.js";
export { buildBytePlusCodingProvider, buildBytePlusProvider } from "./byteplus.js";
export { buildDeepSeekProvider } from "./deepseek.js";
export { buildFeatherlessProvider } from "./featherless.js";
export { buildHuggingfaceProvider } from "./huggingface.js";
export { buildKimiCodingProvider } from "./kimi-coding.js";
export { buildKilocodeProvider, buildKilocodeProviderWithDiscovery } from "./kilocode.js";
export { buildMinimaxPortalProvider, buildMinimaxProvider } from "./minimax.js";
export {
  MODELSTUDIO_BASE_URL,
  MODELSTUDIO_DEFAULT_MODEL_ID,
  buildModelStudioProvider,
} from "./modelstudio.js";
export { buildMoonshotProvider } from "./moonshot.js";
export { buildNvidiaProvider } from "./nvidia.js";
export { buildOpenAICodexProvider } from "./openai.js";
export { buildOpenrouterProvider } from "./openrouter.js";
export { QIANFAN_BASE_URL, QIANFAN_DEFAULT_MODEL_ID, buildQianfanProvider } from "./qianfan.js";
export { buildSyntheticProvider } from "./synthetic.js";
export { buildTogetherProvider } from "./together.js";
export { buildVeniceProvider } from "./venice.js";
export { buildVercelAiGatewayProvider } from "./vercel-ai-gateway.js";
export { buildDoubaoCodingProvider, buildDoubaoProvider } from "./volcengine.js";
export { XIAOMI_DEFAULT_MODEL_ID, buildXiaomiProvider } from "./xiaomi.js";
