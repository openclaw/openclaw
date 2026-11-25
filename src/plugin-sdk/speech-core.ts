export type { SpeechProviderPlugin } from "../plugins/types.js";
export type { ResolvedTtsConfig, ResolvedTtsModelOverrides } from "../tts/tts-types.js";
export type {
  SpeechDirectiveTokenParseContext,
  SpeechListVoicesRequest,
  SpeechModelOverridePolicy,
  SpeechProviderConfiguredContext,
  SpeechProviderPrepareSynthesisContext,
  SpeechProviderResolveConfigContext,
  SpeechProviderResolveTalkConfigContext,
  SpeechProviderResolveTalkOverridesContext,
  SpeechSynthesisRequest,
  SpeechSynthesisStreamRequest,
  SpeechTelephonySynthesisRequest,
} from "../tts/provider-types.js";
export type {
  SpeechDirectiveTokenParseResult,
  SpeechProviderConfig,
  SpeechProviderPreparedSynthesis,
  SpeechProviderOverrides,
  SpeechSynthesisTarget,
  SpeechVoiceOption,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
  SpeechSynthesisStreamResult,
} from "../tts/tts-runtime-types.js";

export {
  scheduleCleanup,
  summarizeText,
  normalizeApplyTextNormalization,
  normalizeLanguageCode,
  normalizeSeed,
  requireInRange,
  resolveSpeechProviderApiKey,
} from "../tts/tts-core.js";
export { parseTtsDirectives } from "../tts/directives.js";
export { parseSpeechDirectiveNumberOverride } from "../tts/directive-number.js";
export {
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  listLoadedSpeechProviders,
  listSpeechProviders,
  normalizeSpeechProviderId,
} from "../tts/provider-registry.js";
export { resolveEffectiveTtsConfig } from "../tts/tts-config.js";
export type { TtsConfigResolutionContext } from "../tts/tts-config.js";
export { normalizeTtsAutoMode, TTS_AUTO_MODES } from "../tts/tts-auto-mode.js";
// Public compatibility: preserve the established `asObject` export name.
export { asOptionalRecord as asObject } from "@openclaw/normalization-core/record-coerce";
export {
  asBoolean,
  asFiniteNumber,
  assertOkOrThrowProviderError,
  createProviderHttpError,
  extractProviderErrorDetail,
  extractProviderRequestId,
  formatProviderErrorPayload,
  formatProviderHttpErrorMessage,
  readResponseTextLimited,
  trimToUndefined,
  truncateErrorDetail,
} from "../agents/provider-http-errors.js";
