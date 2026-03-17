export { SYNTHETIC_DEFAULT_MODEL_ID } from "../agents/synthetic-models.js";
export { VENICE_DEFAULT_MODEL_ID } from "../agents/venice-models.js";
export {
  applyAuthProfileConfig,
  applyCloudflareAiGatewayConfig,
  applyCloudflareAiGatewayProviderConfig,
  applyHuggingfaceConfig,
  applyHuggingfaceProviderConfig,
  applyKilocodeConfig,
  applyKilocodeProviderConfig,
  applyQianfanConfig,
  applyQianfanProviderConfig,
  applyKimiCodeConfig,
  applyKimiCodeProviderConfig,
  applyLitellmConfig,
  applyLitellmProviderConfig,
  applyMistralConfig,
  applyMistralProviderConfig,
  applyMoonshotConfig,
  applyMoonshotConfigCn,
  applyMoonshotProviderConfig,
  applyMoonshotProviderConfigCn,
  applyOpenrouterConfig,
  applyOpenrouterProviderConfig,
  applySyntheticConfig,
  applySyntheticProviderConfig,
  applyTogetherConfig,
  applyTogetherProviderConfig,
  applyVeniceConfig,
  applyVeniceProviderConfig,
  applyVercelAiGatewayConfig,
  applyVercelAiGatewayProviderConfig,
  applyXaiConfig,
  applyXaiProviderConfig,
  applyXiaomiConfig,
  applyXiaomiProviderConfig,
  applyZaiConfig,
  applyZaiProviderConfig,
  applyModelStudioConfig,
  applyModelStudioConfigCn,
  applyModelStudioProviderConfig,
  applyModelStudioProviderConfigCn,
  KILOCODE_BASE_URL,
} from "./onboard-auth.config-core.js";
export {
  applyMinimaxApiConfig,
  applyMinimaxApiConfigCn,
  applyMinimaxApiProviderConfig,
  applyMinimaxApiProviderConfigCn,
} from "./onboard-auth.config-minimax.js";

export {
  applyOpencodeZenConfig,
  applyOpencodeZenProviderConfig,
} from "./onboard-auth.config-opencode.js";
export {
  applyOpencodeGoConfig,
  applyOpencodeGoProviderConfig,
} from "./onboard-auth.config-opencode-go.js";
export {
  LITELLM_DEFAULT_MODEL_REF,
  OPENROUTER_DEFAULT_MODEL_REF,
  setOpenaiApiKey,
  setAnthropicApiKey,
  setCloudflareAiGatewayConfig,
  setByteplusApiKey,
  setQianfanApiKey,
  setGeminiApiKey,
  setKilocodeApiKey,
  setLitellmApiKey,
  setKimiCodingApiKey,
  setMinimaxApiKey,
  setMistralApiKey,
  setMoonshotApiKey,
  setOpencodeGoApiKey,
  setOpencodeZenApiKey,
  setOpenrouterApiKey,
  setSyntheticApiKey,
  setTogetherApiKey,
  setHuggingfaceApiKey,
  setVeniceApiKey,
  setVercelAiGatewayApiKey,
  setXiaomiApiKey,
  setVolcengineApiKey,
  setZaiApiKey,
  setXaiApiKey,
  setModelStudioApiKey,
  writeOAuthCredentials,
  XIAOMI_DEFAULT_MODEL_REF,
} from "./onboard-auth.credentials.js";
export { CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF } from "../../extensions/cloudflare-ai-gateway/onboard.js";
export { HUGGINGFACE_DEFAULT_MODEL_REF } from "../../extensions/huggingface/onboard.js";
export { KILOCODE_DEFAULT_MODEL_REF } from "../../extensions/kilocode/onboard.js";
export { MISTRAL_DEFAULT_MODEL_REF } from "../../extensions/mistral/onboard.js";
export { MODELSTUDIO_DEFAULT_MODEL_REF } from "../../extensions/modelstudio/onboard.js";
export { SYNTHETIC_DEFAULT_MODEL_REF } from "../../extensions/synthetic/onboard.js";
export { TOGETHER_DEFAULT_MODEL_REF } from "../../extensions/together/onboard.js";
export { VENICE_DEFAULT_MODEL_REF } from "../../extensions/venice/onboard.js";
export { VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF } from "../../extensions/vercel-ai-gateway/onboard.js";
export { XAI_DEFAULT_MODEL_REF } from "../../extensions/xai/onboard.js";
export { ZAI_DEFAULT_MODEL_REF } from "../../extensions/zai/onboard.js";
export {
  buildMinimaxApiModelDefinition,
  buildMinimaxModelDefinition,
  DEFAULT_MINIMAX_BASE_URL,
  MINIMAX_API_BASE_URL,
  MINIMAX_CN_API_BASE_URL,
  MINIMAX_HOSTED_MODEL_ID,
  MINIMAX_HOSTED_MODEL_REF,
} from "../../extensions/minimax/model-definitions.js";
export { KIMI_DEFAULT_MODEL_ID as KIMI_CODING_MODEL_ID } from "../../extensions/kimi-coding/provider-catalog.js";
export { KIMI_CODING_MODEL_REF } from "../../extensions/kimi-coding/onboard.js";
export {
  buildMistralModelDefinition,
  MISTRAL_BASE_URL,
  MISTRAL_DEFAULT_MODEL_ID,
} from "../../extensions/mistral/model-definitions.js";
export {
  MOONSHOT_BASE_URL,
  MOONSHOT_DEFAULT_MODEL_ID,
} from "../../extensions/moonshot/provider-catalog.js";
export {
  MOONSHOT_CN_BASE_URL,
  MOONSHOT_DEFAULT_MODEL_REF,
} from "../../extensions/moonshot/onboard.js";
export {
  QIANFAN_BASE_URL,
  QIANFAN_DEFAULT_MODEL_ID,
} from "../../extensions/qianfan/provider-catalog.js";
export { QIANFAN_DEFAULT_MODEL_REF } from "../../extensions/qianfan/onboard.js";
export {
  buildXaiModelDefinition,
  XAI_BASE_URL,
  XAI_DEFAULT_MODEL_ID,
} from "../../extensions/xai/model-definitions.js";
export {
  buildZaiModelDefinition,
  resolveZaiBaseUrl,
  ZAI_CN_BASE_URL,
  ZAI_CODING_CN_BASE_URL,
  ZAI_CODING_GLOBAL_BASE_URL,
  ZAI_DEFAULT_MODEL_ID,
  ZAI_GLOBAL_BASE_URL,
} from "../../extensions/zai/model-definitions.js";
export {
  buildKilocodeModelDefinition,
  buildMoonshotModelDefinition,
  KILOCODE_DEFAULT_MODEL_ID,
} from "./onboard-auth.models.js";
