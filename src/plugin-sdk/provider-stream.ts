// Public stream-wrapper helpers for provider plugins.

export {
  createBedrockNoCacheWrapper,
  isAnthropicBedrockModel,
} from "../agents/pi-embedded-runner/bedrock-stream-wrappers.js";
export {
  createGoogleThinkingPayloadWrapper,
  sanitizeGoogleThinkingPayload,
} from "../agents/pi-embedded-runner/google-stream-wrappers.js";
export {
  createKilocodeWrapper,
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
} from "../agents/pi-embedded-runner/proxy-stream-wrappers.js";
export {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
} from "../agents/pi-embedded-runner/moonshot-thinking-stream-wrappers.js";
export {
  createOpenAIAttributionHeadersWrapper,
  createOpenAIDefaultTransportWrapper,
} from "../agents/pi-embedded-runner/openai-stream-wrappers.js";
export { streamWithPayloadPatch } from "../agents/pi-embedded-runner/stream-payload-utils.js";
export {
  createToolStreamWrapper,
  createZaiToolStreamWrapper,
} from "../agents/pi-embedded-runner/zai-stream-wrappers.js";
export {
  getAllCachedOpenRouterModels,
  getOpenRouterModelCapabilities,
  loadOpenRouterModelCapabilities,
} from "../agents/pi-embedded-runner/openrouter-model-capabilities.js";
