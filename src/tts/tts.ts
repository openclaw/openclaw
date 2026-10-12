/** Public TTS runtime barrel exposed to core callers and plugin SDK facades. */
import { assertSecretOwnerAvailable } from "../secrets/runtime-degraded-state.js";
import {
  setSpeechRuntimeAvailabilityGuard,
  setTtsMachinePrefsPathResolver,
} from "./runtime-api.js";
import { persistTtsAudioToMediaStore } from "./tts-audio-store.js";
import { maybeApplyTtsToPayloadCore } from "./tts-payload.js";
import { getPreparedTtsPreferences } from "./tts-preferences.js";
import { textToSpeechCore } from "./tts-synthesis.js";

setSpeechRuntimeAvailabilityGuard(() => {
  assertSecretOwnerAvailable("capability", "tts");
});

setTtsMachinePrefsPathResolver(() => getPreparedTtsPreferences()?.machinePrefsPath);

export function textToSpeech(params: Parameters<typeof textToSpeechCore>[0]) {
  return textToSpeechCore(params, persistTtsAudioToMediaStore);
}

export function maybeApplyTtsToPayload(params: Parameters<typeof maybeApplyTtsToPayloadCore>[0]) {
  return maybeApplyTtsToPayloadCore(params, persistTtsAudioToMediaStore);
}

export {
  getLastTtsAttempt,
  getResolvedSpeechProviderConfig,
  getTtsMaxLength,
  getTtsPersona,
  getTtsProvider,
  getTtsProviderAsync,
  isSummarizationEnabled,
  isTtsEnabled,
  isTtsProviderConfiguredAsync,
  listSpeechVoices,
  listTtsPersonas,
  resolveExplicitTtsOverridesAsync,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  resolveTtsPrefsPathAsync,
  resolveTtsProviderOrder,
  setLastTtsAttempt,
  setSummarizationEnabled,
  setTtsEnabled,
  setTtsMaxLength,
  setTtsPersona,
  setTtsProvider,
  synthesizeSpeech,
  type ResolvedTtsConfig,
  type TtsDirectiveOverrides,
} from "./runtime-api.js";
