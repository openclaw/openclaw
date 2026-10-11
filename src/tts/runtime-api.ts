// Runtime speech API barrel for TTS preferences, synthesis, streaming, and test
// helpers used by speech-capable plugins.
import type { TtsProvider } from "../config/types.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { parseTtsDirectives } from "./directives.js";
import { summarizeText } from "./tts-core.js";
import {
  getResolvedSpeechProviderConfig,
  resolveTtsProvider,
  resolveTtsProviderAsync,
} from "./tts-provider-resolution.js";
import { resolveModelOverridePolicy, type ResolvedTtsConfig } from "./tts-settings.js";
import { formatTtsProviderError, sanitizeTtsErrorForLog } from "./tts-synthesis-support.js";
import {
  resolveTtsSynthesisTarget,
  shouldDeliverTtsAsVoice,
  supportsNativeVoiceNoteTts,
  supportsTranscodedVoiceNoteTts,
} from "./tts-synthesis.js";

export { setSpeechRuntimeAvailabilityGuard } from "./runtime-availability.js";
export {
  buildTtsSystemPromptHint,
  getTtsMaxLength,
  getTtsPersona,
  isSummarizationEnabled,
  isTtsEnabled,
  listTtsPersonas,
  resolveTtsAutoMode,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  resolveTtsPrefsPathAsync,
  setTtsMachinePrefsPathResolver,
  type ResolvedTtsConfig,
  type ResolvedTtsModelOverrides,
} from "./tts-settings.js";
export {
  setSummarizationEnabled,
  setTtsAutoMode,
  setTtsEnabled,
  setTtsMaxLength,
  setTtsPersona,
  setTtsProvider,
} from "./tts-settings-writes.js";
export { getLastTtsAttempt, listSpeechVoices, setLastTtsAttempt } from "./tts-payload.js";
export {
  getResolvedSpeechProviderConfig,
  isTtsProviderConfigured,
  isTtsProviderConfiguredAsync,
  resolveTtsProviderOrder,
} from "./tts-provider-resolution.js";
export {
  prepareTtsRequest,
  resolveExplicitTtsOverrides,
  resolveExplicitTtsOverridesAsync,
} from "./tts-request.js";
export { streamSpeech, textToSpeechStream } from "./tts-streaming.js";
export { synthesizeSpeech } from "./tts-synthesis.js";
export { textToSpeechTelephony } from "./tts-telephony.js";
export type { TtsDirectiveOverrides, TtsDirectiveParseResult } from "./provider-types.js";
export type {
  TtsStreamResult,
  TtsSynthesisResult,
  TtsSynthesisStreamResult,
  TtsTelephonyResult,
} from "./tts-runtime-types.js";

/** @deprecated Use getTtsProviderAsync. Removed at the next Plugin SDK major. */
export function getTtsProvider(config: ResolvedTtsConfig, prefsPath: string): TtsProvider {
  warnPluginSdkDeprecation({
    family: "tts",
    method: "getTtsProvider",
    replacement: "getTtsProviderAsync",
  });
  return resolveTtsProvider(config, prefsPath);
}

export async function getTtsProviderAsync(
  config: ResolvedTtsConfig,
  prefsPath: string,
): Promise<TtsProvider> {
  return await resolveTtsProviderAsync(config, prefsPath);
}

export const testApi = {
  parseTtsDirectives,
  resolveModelOverridePolicy,
  supportsNativeVoiceNoteTts,
  supportsTranscodedVoiceNoteTts,
  resolveTtsSynthesisTarget,
  shouldDeliverTtsAsVoice,
  summarizeText,
  getResolvedSpeechProviderConfig,
  formatTtsProviderError,
  sanitizeTtsErrorForLog,
};
