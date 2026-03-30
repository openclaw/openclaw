// Public speech helpers for bundled or third-party plugins.
//
// Keep this surface neutral. Provider plugins should not need to know about the
// bundled `speech-core` plugin id just to consume shared speech types/helpers.

export type { SpeechProviderPlugin } from "../plugins/types.js";
export type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechListVoicesRequest,
  SpeechModelOverridePolicy,
  SpeechProviderConfig,
  SpeechProviderConfiguredContext,
  SpeechProviderResolveConfigContext,
  SpeechProviderResolveTalkConfigContext,
  SpeechProviderResolveTalkOverridesContext,
  SpeechProviderOverrides,
  SpeechSynthesisRequest,
  SpeechTelephonySynthesisRequest,
  SpeechVoiceOption,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
} from "../tts/provider-types.js";

export {
  scheduleCleanup,
  summarizeText,
  normalizeApplyTextNormalization,
  normalizeLanguageCode,
  normalizeSeed,
  requireInRange,
} from "../tts/tts-core.js";
export { parseTtsDirectives } from "../tts/directives.js";
export {
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  listSpeechProviders,
  normalizeSpeechProviderId,
} from "../tts/provider-registry.js";
export { normalizeTtsAutoMode, TTS_AUTO_MODES } from "../tts/tts-auto-mode.js";
