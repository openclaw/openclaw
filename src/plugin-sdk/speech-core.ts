// Shared speech-provider implementation helpers for bundled and third-party plugins.

import { parseTtsDirectives as parseTtsDirectivesImpl } from "../tts/directives.js";
import {
  canonicalizeSpeechProviderId as canonicalizeSpeechProviderIdImpl,
  getSpeechProvider as getSpeechProviderImpl,
  listSpeechProviders as listSpeechProvidersImpl,
  normalizeSpeechProviderId as normalizeSpeechProviderIdImpl,
} from "../tts/provider-registry.js";
import {
  normalizeTtsAutoMode as normalizeTtsAutoModeImpl,
  TTS_AUTO_MODES as TTS_AUTO_MODES_IMPL,
} from "../tts/tts-auto-mode.js";
import {
  normalizeApplyTextNormalization as normalizeApplyTextNormalizationImpl,
  normalizeLanguageCode as normalizeLanguageCodeImpl,
  normalizeSeed as normalizeSeedImpl,
  requireInRange as requireInRangeImpl,
  scheduleCleanup as scheduleCleanupImpl,
  summarizeText as summarizeTextImpl,
} from "../tts/tts-core.js";

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

export const scheduleCleanup = scheduleCleanupImpl;
export const summarizeText = summarizeTextImpl;
export const normalizeApplyTextNormalization = normalizeApplyTextNormalizationImpl;
export const normalizeLanguageCode = normalizeLanguageCodeImpl;
export const normalizeSeed = normalizeSeedImpl;
export const requireInRange = requireInRangeImpl;
export const parseTtsDirectives = parseTtsDirectivesImpl;
export const canonicalizeSpeechProviderId = canonicalizeSpeechProviderIdImpl;
export const getSpeechProvider = getSpeechProviderImpl;
export const listSpeechProviders = listSpeechProvidersImpl;
export const normalizeSpeechProviderId = normalizeSpeechProviderIdImpl;
export const normalizeTtsAutoMode = normalizeTtsAutoModeImpl;
export const TTS_AUTO_MODES = TTS_AUTO_MODES_IMPL;
