import { findNormalizedProviderKey } from "@openclaw/model-catalog-core/provider-id";
import { parseBoolean } from "@openclaw/normalization-core/boolean-coercion";
import { asFiniteNumberInRange } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeFastMode,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeThinkLevel } from "../auto-reply/thinking.shared.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import type {
  ResolvedTalkConfig,
  TalkConfig,
  TalkConfigResponse,
  TalkProviderConfig,
  TalkRealtimeConfig,
} from "./types.gateway.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { parseSecretRef } from "./types.secrets.js";

function normalizeInteger(value: unknown, min: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min ? value : undefined;
}

function omitUndefinedTalkFields<T extends object>(fields: T): T | undefined {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      Reflect.deleteProperty(fields, key);
    }
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function normalizeTalkProviderConfig(value: unknown): TalkProviderConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const provider: TalkProviderConfig = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalized =
      key === "apiKey" ? (normalizeOptionalString(raw) ?? parseSecretRef(raw) ?? undefined) : raw;
    if (normalized !== undefined) {
      provider[key] = normalized;
    }
  }

  return provider;
}

function normalizeTalkProviders(value: unknown): Record<string, TalkProviderConfig> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const providers: Record<string, TalkProviderConfig> = {};
  for (const [rawProviderId, providerConfig] of Object.entries(value)) {
    const providerId = normalizeOptionalString(rawProviderId);
    if (!providerId) {
      continue;
    }
    const normalizedProvider = normalizeTalkProviderConfig(providerConfig);
    if (!normalizedProvider) {
      continue;
    }
    providers[providerId] = {
      ...providers[providerId],
      ...normalizedProvider,
    };
  }
  return Object.keys(providers).length > 0 ? providers : undefined;
}

export function normalizeTalkRealtimeConfig(value: unknown): TalkRealtimeConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const source = value;
  return omitUndefinedTalkFields<TalkRealtimeConfig>({
    provider: normalizeOptionalString(source.provider),
    providers: normalizeTalkProviders(source.providers),
    model: normalizeOptionalString(source.model),
    speakerVoice: normalizeOptionalString(source.speakerVoice),
    speakerVoiceId: normalizeOptionalString(source.speakerVoiceId),
    instructions: normalizeOptionalString(source.instructions),
    mode:
      source.mode === "realtime" || source.mode === "stt-tts" || source.mode === "transcription"
        ? source.mode
        : undefined,
    transport:
      source.transport === "webrtc" ||
      source.transport === "provider-websocket" ||
      source.transport === "gateway-relay" ||
      source.transport === "managed-room"
        ? source.transport
        : undefined,
    vadThreshold: asFiniteNumberInRange(source.vadThreshold, { min: 0, max: 1 }),
    silenceDurationMs: normalizeInteger(source.silenceDurationMs, 1),
    prefixPaddingMs: normalizeInteger(source.prefixPaddingMs, 0),
    reasoningEffort: normalizeOptionalString(source.reasoningEffort),
    brain:
      source.brain === "agent-consult" || source.brain === "direct-tools" || source.brain === "none"
        ? source.brain
        : undefined,
    consultRouting:
      source.consultRouting === "provider-direct" || source.consultRouting === "force-agent-consult"
        ? source.consultRouting
        : undefined,
  });
}

function activeProviderFromTalk(talk: TalkConfig): string | undefined {
  const providerIds = Object.keys(talk.providers ?? {});
  const provider = normalizeOptionalString(
    talk.provider ?? (providerIds.length === 1 ? providerIds[0] : undefined),
  );
  if (!provider || isBlockedObjectKey(provider.toLowerCase())) {
    return undefined;
  }
  return talk.providers ? findNormalizedProviderKey(talk.providers, provider) : provider;
}

/** Resolve the explicitly selected or sole authored Talk speech provider. */
export function resolveConfiguredTalkSpeechProviderId(
  config: Pick<OpenClawConfig, "talk">,
): string | undefined {
  return config.talk ? activeProviderFromTalk(config.talk) : undefined;
}

/** Resolve the explicitly selected or sole authored Talk realtime provider. */
export function resolveConfiguredTalkRealtimeProviderId(
  config: Pick<OpenClawConfig, "talk">,
): string | undefined {
  return config.talk?.realtime ? activeProviderFromTalk(config.talk.realtime) : undefined;
}

/**
 * Normalize persisted Talk config into the canonical provider/providers shape.
 * Legacy flat provider fields are ignored here so core config stays provider-agnostic.
 */
export function normalizeTalkSection(value: TalkConfig | undefined): TalkConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return omitUndefinedTalkFields<TalkConfig>({
    agentId: normalizeOptionalString(value.agentId),
    speechLocale: normalizeOptionalString(value.speechLocale),
    interruptOnSpeech:
      typeof value.interruptOnSpeech === "boolean" ? value.interruptOnSpeech : undefined,
    consultThinkingLevel: normalizeThinkLevel(normalizeOptionalString(value.consultThinkingLevel)),
    consultFastMode: parseBoolean(normalizeFastMode(value.consultFastMode)),
    silenceTimeoutMs: normalizeInteger(value.silenceTimeoutMs, 1),
    providers: normalizeTalkProviders(value.providers),
    realtime: normalizeTalkRealtimeConfig(value.realtime),
    provider: normalizeOptionalString(value.provider),
  });
}

/** Return a config copy with `talk` normalized when a valid Talk section is present. */
export function normalizeTalkConfig(config: OpenClawConfig): OpenClawConfig {
  if (!config.talk) {
    return config;
  }
  const normalizedTalk = normalizeTalkSection(config.talk);
  if (!normalizedTalk) {
    return config;
  }
  return {
    ...config,
    talk: normalizedTalk,
  };
}

/**
 * Resolve the single active Talk speech provider and its provider-owned config.
 * Ambiguous multi-provider config stays unresolved until `talk.provider` names one.
 */
export function resolveActiveTalkProviderConfig(
  talk: TalkConfig | undefined,
): ResolvedTalkConfig | undefined {
  const selectedProvider = resolveConfiguredTalkSpeechProviderId({ talk });
  if (!selectedProvider || !talk) {
    return undefined;
  }
  const normalizedTalk = normalizeTalkSection(talk);
  const provider =
    findNormalizedProviderKey(normalizedTalk?.providers, selectedProvider) ?? selectedProvider;
  return {
    provider,
    config: normalizedTalk?.providers?.[provider] ?? {},
  };
}

/**
 * Build the gateway `talk.config` payload from canonical Talk config.
 * The response includes canonical provider data plus the resolved provider when selection is unambiguous.
 */
export function buildTalkConfigResponse(
  normalized: TalkConfig | undefined,
): TalkConfigResponse | undefined {
  if (!normalized) {
    return undefined;
  }

  const provider = activeProviderFromTalk(normalized);
  const payload: TalkConfigResponse = {
    agentId: normalized.agentId,
    interruptOnSpeech: normalized.interruptOnSpeech,
    silenceTimeoutMs: normalized.silenceTimeoutMs,
    consultThinkingLevel: normalized.consultThinkingLevel,
    consultFastMode: normalized.consultFastMode,
    speechLocale: normalized.speechLocale,
    providers: Object.keys(normalized.providers ?? {}).length ? normalized.providers : undefined,
    realtime: Object.keys(normalized.realtime ?? {}).length ? normalized.realtime : undefined,
    ...(provider
      ? { provider, resolved: { provider, config: normalized.providers?.[provider] ?? {} } }
      : {}),
  };

  return omitUndefinedTalkFields(payload);
}
