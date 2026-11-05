import { asOptionalRecord, filterStringRecord } from "@openclaw/normalization-core/record-coerce";
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
  baseTts: Record<string, unknown>,
  talkProvider?: { provider: { id: string; aliases?: readonly string[] }; apiKey?: unknown },
): Record<string, unknown> {
  const next = withSpeakerSelectionCompat(baseTts);
  const providers = asOptionalRecord(baseTts.providers);
  if (providers) {
    next.providers = Object.fromEntries(
      Object.entries(providers).map(([providerId, providerConfig]) => {
        const normalized = withSpeakerSelectionCompat(asOptionalRecord(providerConfig) ?? {});
        // Talk-owned overrides must shield provider normalization from a cold global TTS ref.
        if (
          typeof talkProvider?.apiKey === "string" &&
          providerMatchesId(talkProvider.provider, providerId) &&
          typeof normalized.apiKey === "object"
        ) {
          normalized.apiKey = talkProvider.apiKey;
        }
        return [providerId, normalized];
      }),
    );
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
  const baseTts = withTalkBaseTtsSpeakerSelectionCompat(asOptionalRecord(config.tts) ?? {}, {
    provider: speechProvider,
    apiKey: providerConfig.apiKey,
  }) as TtsConfig;
  const resolvedProviderConfig =
    speechProvider.resolveTalkConfig?.({
      cfg: config,
      baseTtsConfig: baseTts as Record<string, unknown>,
      talkProviderConfig: providerConfig,
      timeoutMs: baseTts.timeoutMs ?? 30_000,
    }) ?? providerConfig;
  const talkTts: TtsConfig = {
    ...baseTts,
    auto: "always",
    provider,
    providers: {
      ...((asOptionalRecord(baseTts.providers) ?? {}) as TtsProviderConfigMap),
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
