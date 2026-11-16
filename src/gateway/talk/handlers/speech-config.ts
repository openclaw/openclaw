import { filterStringRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveActiveTalkProviderConfig } from "../../../config/talk.js";
import type { TalkProviderConfig } from "../../../config/types.gateway.js";
import type { OpenClawConfig, TtsConfig, TtsProviderConfigMap } from "../../../config/types.js";
import { assertSecretOwnerAvailable } from "../../../secrets/runtime-degraded-state.js";
import { canonicalizeSpeechProviderId, getSpeechProvider } from "../../../tts/provider-registry.js";
import {
  withSpeakerSelectionCompat,
  withSpeakerSelectionFallbackCompat,
} from "../../../tts/speaker.js";
import { providerMatchesId } from "../../../tts/voice-models.js";

export type TalkSpeakReason =
  | "talk_unconfigured"
  | "talk_provider_unsupported"
  | "synthesis_failed"
  | "invalid_audio_result";

export function resolveTalkVoiceId(
  providerConfig: TalkProviderConfig,
  requested: string | undefined,
): string | undefined {
  if (!requested) {
    return undefined;
  }
  const aliases = filterStringRecord(providerConfig.voiceAliases);
  if (!aliases) {
    return requested;
  }
  const normalizedRequested = normalizeLowercaseStringOrEmpty(requested);
  for (const [alias, voiceId] of Object.entries(aliases)) {
    if (normalizeLowercaseStringOrEmpty(alias) === normalizedRequested) {
      return voiceId;
    }
  }
  return requested;
}

export function withTalkBaseTtsSpeakerSelectionCompat(
  baseTts: TtsConfig,
  talkProvider?: { provider: { id: string; aliases?: readonly string[] }; apiKey?: unknown },
): TtsConfig {
  const next: TtsConfig = { ...baseTts, ...withSpeakerSelectionCompat(baseTts) };
  if (baseTts.providers) {
    const providers: TtsProviderConfigMap = {};
    for (const [providerId, providerConfig] of Object.entries(baseTts.providers)) {
      const normalized = { ...providerConfig, ...withSpeakerSelectionCompat(providerConfig) };
      // Talk-owned overrides must shield provider normalization from a cold global TTS ref.
      if (
        typeof talkProvider?.apiKey === "string" &&
        providerMatchesId(talkProvider.provider, providerId) &&
        typeof normalized.apiKey === "object"
      ) {
        normalized.apiKey = talkProvider.apiKey;
      }
      providers[providerId] = normalized;
    }
    next.providers = providers;
  }
  return next;
}

export function buildTalkTtsConfig(
  config: OpenClawConfig,
):
  | { cfg: OpenClawConfig; provider: string; providerConfig: TalkProviderConfig }
  | { error: string; reason: TalkSpeakReason } {
  const resolved = resolveActiveTalkProviderConfig(config.talk);
  const provider = canonicalizeSpeechProviderId(resolved?.provider, config);
  if (!resolved || !provider) {
    return {
      error: "talk.speak unavailable: talk provider not configured",
      reason: "talk_unconfigured",
    };
  }
  assertSecretOwnerAvailable("capability", "talk:speech");

  const speechProvider = getSpeechProvider(provider, config);
  if (!speechProvider) {
    return {
      error: `talk.speak unavailable: speech provider "${provider}" does not support Talk mode`,
      reason: "talk_provider_unsupported",
    };
  }

  const providerConfig = withSpeakerSelectionFallbackCompat(resolved.config);
  const baseTts = withTalkBaseTtsSpeakerSelectionCompat(config.tts ?? {}, {
    provider: speechProvider,
    apiKey: providerConfig.apiKey,
  });
  const resolvedProviderConfig =
    speechProvider.resolveTalkConfig?.({
      cfg: config,
      baseTtsConfig: baseTts,
      talkProviderConfig: providerConfig,
      timeoutMs: baseTts.timeoutMs ?? 30_000,
    }) ?? providerConfig;
  const talkTts: TtsConfig = {
    ...baseTts,
    auto: "always",
    provider,
    providers: {
      ...baseTts.providers,
      [provider]: resolvedProviderConfig,
    },
  };

  return {
    provider,
    providerConfig,
    cfg: {
      ...config,
      tts: talkTts,
    },
  };
}
