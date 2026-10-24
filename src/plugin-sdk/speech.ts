//
// Keep this surface provider-facing: types, validation, directive parsing, and
// registry helpers. Runtime synthesis lives on `api.runtime.tts` or narrower
// core/runtime seams, not here.

export type { SpeechProviderPlugin } from "../plugins/types.js";
export type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechListVoicesRequest,
  SpeechModelOverridePolicy,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechSynthesisRequest,
  SpeechSynthesisTarget,
  SpeechTelephonySynthesisRequest,
  SpeechVoiceOption,
  TtsDirectiveOverrides,
} from "../tts/provider-types.js";

export { parseTtsDirectives } from "../tts/directives.js";
export { getSpeechProvider } from "../tts/provider-registry.js";
// Public compatibility: preserve the established `asObject` export name.
export { asOptionalRecord as asObject } from "@openclaw/normalization-core/record-coerce";
export { asBoolean, asFiniteNumber, trimToUndefined } from "../agents/provider-http-errors.js";
/** @deprecated Retained for plugins built against OpenClaw 2026.10.4 and earlier; tracked by `plugin-sdk-private-runtime-shipped-exports`. */
export { readResponseTextLimited } from "../agents/provider-http-errors.js";
/** @deprecated Retained for plugins built against OpenClaw 2026.10.4 and earlier; tracked by `plugin-sdk-private-runtime-shipped-exports`. */
export { truncateErrorDetail } from "../agents/provider-http-errors.js";
export {
  normalizeApplyTextNormalization,
  normalizeLanguageCode,
  normalizeSeed,
  requireInRange,
} from "../tts/tts-provider-helpers.js";
export { createOpenAiCompatibleSpeechProvider } from "../tts/openai-compatible-speech-provider.js";
