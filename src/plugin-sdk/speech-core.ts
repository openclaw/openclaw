// Shared speech-provider implementation helpers for bundled and third-party plugins.

export type { SpeechProviderPlugin } from "../plugins/types.js";
export type { SpeechVoiceOption } from "../tts/provider-types.js";

export {
  normalizeApplyTextNormalization,
  normalizeLanguageCode,
  normalizeSeed,
  parseTtsDirectives,
  requireInRange,
} from "../tts/tts-core.js";
