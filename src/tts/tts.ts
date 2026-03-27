import * as speechRuntime from "../plugin-sdk/speech-runtime.js";

export const buildTtsSystemPromptHint = speechRuntime.buildTtsSystemPromptHint;
export const getLastTtsAttempt = speechRuntime.getLastTtsAttempt;
export const getResolvedSpeechProviderConfig = speechRuntime.getResolvedSpeechProviderConfig;
export const getTtsMaxLength = speechRuntime.getTtsMaxLength;
export const getTtsProvider = speechRuntime.getTtsProvider;
export const isSummarizationEnabled = speechRuntime.isSummarizationEnabled;
export const isTtsEnabled = speechRuntime.isTtsEnabled;
export const isTtsProviderConfigured = speechRuntime.isTtsProviderConfigured;
export const listSpeechVoices = speechRuntime.listSpeechVoices;
export const maybeApplyTtsToPayload = speechRuntime.maybeApplyTtsToPayload;
export const resolveTtsAutoMode = speechRuntime.resolveTtsAutoMode;
export const resolveTtsConfig = speechRuntime.resolveTtsConfig;
export const resolveTtsPrefsPath = speechRuntime.resolveTtsPrefsPath;
export const resolveTtsProviderOrder = speechRuntime.resolveTtsProviderOrder;
export const setLastTtsAttempt = speechRuntime.setLastTtsAttempt;
export const setSummarizationEnabled = speechRuntime.setSummarizationEnabled;
export const setTtsAutoMode = speechRuntime.setTtsAutoMode;
export const setTtsEnabled = speechRuntime.setTtsEnabled;
export const setTtsMaxLength = speechRuntime.setTtsMaxLength;
export const setTtsProvider = speechRuntime.setTtsProvider;
export const synthesizeSpeech = speechRuntime.synthesizeSpeech;
export const textToSpeech = speechRuntime.textToSpeech;
export const textToSpeechTelephony = speechRuntime.textToSpeechTelephony;
export const _test = speechRuntime._test;

export type {
  ResolvedTtsConfig,
  ResolvedTtsModelOverrides,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
  TtsResult,
  TtsSynthesisResult,
  TtsTelephonyResult,
} from "../plugin-sdk/speech-runtime.js";
