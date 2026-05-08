export type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechListVoicesRequest,
  SpeechModelOverridePolicy,
  SpeechProviderConfig,
  SpeechProviderConfiguredContext,
  SpeechProviderPlugin,
  SpeechProviderResolveConfigContext,
  SpeechProviderResolveTalkConfigContext,
  SpeechProviderResolveTalkOverridesContext,
  SpeechProviderOverrides,
  SpeechSynthesisRequest,
  SpeechTelephonySynthesisRequest,
  SpeechVoiceOption,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
} from "../../plugin-sdk/speech-core.js";

export {
  normalizeApplyTextNormalization,
  normalizeLanguageCode,
  normalizeSeed,
  requireInRange,
  scheduleCleanup,
} from "../../plugin-sdk/speech-core.js";
export {
  asBoolean,
  asFiniteNumber,
  asObject,
  readResponseTextLimited,
  trimToUndefined,
  truncateErrorDetail,
} from "../../tts/provider-error-utils.js";

export async function summarizeText(): Promise<never> {
  throw new Error("summarizeText is unavailable in the Vitest capability contract shim");
}
