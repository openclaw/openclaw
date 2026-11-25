// Private provider construction helpers; keep registry and execution imports out of this leaf.
export type { SpeechProviderPlugin } from "../plugins/types.js";
export {
  normalizeApplyTextNormalization,
  normalizeLanguageCode,
  normalizeSeed,
  requireInRange,
  resolveSpeechProviderApiKey,
} from "../tts/tts-provider-helpers.js";
export { parseSpeechDirectiveNumberOverride } from "../tts/directive-number.js";
export { createSpeechDirectiveParser } from "../tts/directive-parser.js";
export {
  createOpenAiCompatibleSpeechProvider,
  type OpenAiCompatibleSpeechProviderBaseUrlPolicy,
  type OpenAiCompatibleSpeechProviderConfig,
  type OpenAiCompatibleSpeechProviderExtraJsonBodyField,
  type OpenAiCompatibleSpeechProviderOptions,
} from "../tts/openai-compatible-speech-provider.js";

export { MAX_AUDIO_BYTES } from "@openclaw/media-core/constants";

export { retryAsync } from "../infra/retry.js";
export { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

export {
  buildOpenAiSpeechRequestBody,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
} from "../tts/openai-speech-payload.js";
export {
  buildGradiumSpeechRequestBody,
  DEFAULT_GRADIUM_VOICE_ID,
} from "../tts/gradium-speech-payload.js";
