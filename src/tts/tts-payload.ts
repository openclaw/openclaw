import {
  getReplyPayloadMetadata,
  markReplyPayloadAsTtsSupplement,
  type ReplyPayload,
} from "../auto-reply/reply-payload.js";
import { getChannelPlugin } from "../channels/plugins/registry.js";
import { selectLiveRuntimeConfig } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.js";
import { logVerbose } from "../globals.js";
import { resolveSendableOutboundReplyParts } from "../infra/outbound/reply-payload-parts.js";
import { hasReplyPayloadContent } from "../interactive/payload.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";
import { parseTtsDirectives, resolveTtsDirectiveFacts } from "./directives.js";
import { canonicalizeSpeechProviderId, getSpeechProvider } from "./provider-registry.js";
import { assertSpeechRuntimeAvailable, isSpeechRuntimeAvailable } from "./runtime-availability.js";
import { isCodeHeavySpeechText, normalizeSpeechText } from "./speech-text.js";
import { prepareTtsPreferences, type PreparedTtsPreferences } from "./tts-preferences.js";
import {
  getResolvedSpeechProviderConfig,
  resolveSpeechProviderTimeoutMs,
  resolveTtsProviderAsync,
} from "./tts-provider-resolution.js";
import type { SpeechVoiceOption, TtsStatusEntry } from "./tts-runtime-types.js";
import {
  resolveTtsConfig,
  resolveTtsSettingsSnapshotAsync,
  type ResolvedTtsConfig,
} from "./tts-settings.js";
import { textToSpeechCore, type TtsAudioPersistence } from "./tts-synthesis.js";
import { fitTtsTextToLimit } from "./tts-text-limit.js";

let lastTtsAttempt: TtsStatusEntry | undefined;

export function getLastTtsAttempt(): TtsStatusEntry | undefined {
  return lastTtsAttempt;
}

export function setLastTtsAttempt(entry: TtsStatusEntry | undefined): void {
  lastTtsAttempt = entry;
}

export async function listSpeechVoices(params: {
  provider: string;
  cfg?: OpenClawConfig;
  config?: ResolvedTtsConfig;
  apiKey?: string;
  baseUrl?: string;
}): Promise<SpeechVoiceOption[]> {
  assertSpeechRuntimeAvailable();
  const cfg = params.cfg ? selectLiveRuntimeConfig(params.cfg) : undefined;
  const provider = canonicalizeSpeechProviderId(params.provider, cfg);
  if (!provider) {
    throw new Error("speech provider id is required");
  }
  const config = params.config ?? (cfg ? resolveTtsConfig(cfg) : undefined);
  if (!config) {
    throw new Error(`speech provider ${provider} requires cfg or resolved config`);
  }
  const resolvedProvider = getSpeechProvider(provider, cfg);
  if (!resolvedProvider) {
    throw new Error(`speech provider ${provider} is not registered`);
  }
  if (!resolvedProvider.listVoices) {
    throw new Error(`speech provider ${provider} does not support voice listing`);
  }
  const timeoutMs = resolveSpeechProviderTimeoutMs({
    config,
    provider: resolvedProvider,
  });
  return await resolvedProvider.listVoices({
    cfg,
    providerConfig: getResolvedSpeechProviderConfig(config, resolvedProvider.id, cfg),
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
    timeoutMs,
  });
}

function hasLegacyFinalMediaDirective(text: string): boolean {
  return /(?:^|\n)\s*MEDIA\s*:/i.test(text);
}

// Channel-owned content checks distinguish visible blocks from transport-only metadata.
function applyExplicitSpeechVisibleFallback(
  payload: ReplyPayload,
  channel?: string,
  explicitText = getReplyPayloadMetadata(payload)?.tts?.text?.trim(),
): ReplyPayload {
  const channelId = explicitText && payload.channelData ? normalizeMessageChannel(channel) : null;
  const hasChannelData = channelId
    ? getChannelPlugin(channelId)?.messaging?.hasStructuredReplyPayload?.({ payload })
    : undefined;
  if (!explicitText || hasReplyPayloadContent(payload, { hasChannelData })) {
    return payload;
  }
  return { ...payload, text: explicitText };
}

export async function maybeApplyTtsToPayloadCore(
  params: {
    payload: ReplyPayload;
    cfg: OpenClawConfig;
    preparedTtsPreferences?: PreparedTtsPreferences;
    channel?: string;
    kind?: "tool" | "block" | "final";
    inboundAudio?: boolean;
    ttsAuto?: string;
    agentId?: string;
    accountId?: string;
  },
  persistTtsAudio: TtsAudioPersistence,
): Promise<ReplyPayload> {
  if (!isSpeechRuntimeAvailable()) {
    return applyExplicitSpeechVisibleFallback(params.payload, params.channel);
  }
  if (params.payload.isCompactionNotice) {
    return params.payload;
  }
  const cfg = selectLiveRuntimeConfig(params.cfg);
  const {
    autoMode,
    config,
    prefsPath,
    maxLength: preferredMaxLength,
    summarize,
  } = await resolveTtsSettingsSnapshotAsync({
    cfg,
    preparedTtsPreferences: params.preparedTtsPreferences ?? (await prepareTtsPreferences()),
    sessionAuto: params.ttsAuto,
    agentId: params.agentId,
    channelId: params.channel,
    accountId: params.accountId,
  });
  const ttsMetadata = getReplyPayloadMetadata(params.payload);
  const explicitTts = ttsMetadata?.ttsExplicit === true;
  if (!explicitTts && (autoMode === "off" || ttsMetadata?.commandReply)) {
    return params.payload;
  }
  const activeProvider = await resolveTtsProviderAsync(config, prefsPath);

  const reply = resolveSendableOutboundReplyParts(params.payload);
  const text = reply.text;
  const directiveOptions = {
    cfg,
    providerConfigs: config.providerConfigs,
    preferredProviderId: activeProvider,
  };
  const directives =
    ttsMetadata?.tts || ttsMetadata?.ttsDirectivesParsed
      ? {
          cleanedText: text,
          ...resolveTtsDirectiveFacts(ttsMetadata.tts, config.modelOverrides, directiveOptions),
        }
      : parseTtsDirectives(text, config.modelOverrides, directiveOptions);
  if (directives.warnings.length > 0) {
    logVerbose(`TTS: ignored ${directives.warnings.length} directive override(s)`);
  }

  const visibleText = directives.cleanedText.trim();
  const explicitTtsText = directives.ttsText?.trim() || "";
  const ttsText = explicitTtsText || visibleText;

  const nextPayload =
    visibleText === text.trim()
      ? params.payload
      : {
          ...params.payload,
          text: visibleText.length > 0 ? visibleText : undefined,
        };

  if (!explicitTts && autoMode === "tagged" && !directives.hasDirective) {
    return nextPayload;
  }
  if (!explicitTts && autoMode === "inbound" && params.inboundAudio !== true) {
    return nextPayload;
  }

  const mode = config.mode;
  if (mode === "final" && params.kind && params.kind !== "final") {
    return nextPayload;
  }

  if (!ttsText) {
    return nextPayload;
  }
  if (reply.hasMedia || hasLegacyFinalMediaDirective(text)) {
    return nextPayload;
  }
  if (!explicitTtsText && ttsText.length < 10) {
    return nextPayload;
  }

  if (!explicitTtsText && isCodeHeavySpeechText(ttsText)) {
    // The visible reply already carries code-heavy detail. Skip noisy voice-note audio instead of
    // telling channel users to look at a screen they may not have.
    return nextPayload;
  }

  const { text: textForAudio, summarized: wasSummarized } = await fitTtsTextToLimit({
    text: ttsText,
    maxLength: preferredMaxLength,
    summarize,
    cfg,
    config,
    agentId: params.agentId,
  });

  const normalizedTextForAudio = normalizeSpeechText(textForAudio);
  if (!normalizedTextForAudio) {
    return nextPayload;
  }
  if (!explicitTtsText && normalizedTextForAudio.length < 10) {
    return nextPayload;
  }

  const ttsStart = Date.now();
  const result = await textToSpeechCore(
    {
      text: textForAudio,
      cfg,
      prefsPath,
      channel: params.channel,
      overrides: directives.overrides,
      agentId: params.agentId,
      accountId: params.accountId,
    },
    persistTtsAudio,
  );

  const succeeded = result.success && Boolean(result.audioPath);
  lastTtsAttempt = {
    timestamp: Date.now(),
    success: succeeded,
    textLength: text.length,
    summarized: wasSummarized,
    persona: result.persona,
    attemptedProviders: result.attemptedProviders,
    attempts: result.attempts,
    ...(succeeded
      ? {
          provider: result.provider,
          fallbackFrom: result.fallbackFrom,
          latencyMs: result.latencyMs,
        }
      : { error: result.error }),
  };

  if (result.success && result.audioPath) {
    const payloadWithAudio: ReplyPayload = {
      ...nextPayload,
      mediaUrl: result.audioPath,
      audioAsVoice: result.audioAsVoice || params.payload.audioAsVoice,
      spokenText: textForAudio,
      trustedLocalMedia: true,
    };
    return nextPayload.text?.trim()
      ? markReplyPayloadAsTtsSupplement(payloadWithAudio)
      : payloadWithAudio;
  }

  const latency = Date.now() - ttsStart;
  logVerbose(`TTS: conversion failed after ${latency}ms.`);
  return applyExplicitSpeechVisibleFallback(nextPayload, params.channel, explicitTtsText);
}
