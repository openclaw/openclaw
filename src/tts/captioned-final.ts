import { copyReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { resolveChannelTtsVoiceDelivery } from "../channels/plugins/tts-capabilities.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TtsAutoMode } from "../config/types.tts.js";
import { createTtsDirectiveTextStreamCleaner } from "./directives.js";
import { resolveConfiguredTtsMode } from "./tts-config.js";
import type { PreparedTtsPreferences } from "./tts-preferences.js";
import { resolveTtsSettingsSnapshot } from "./tts-settings.js";

export function shouldDeferFinalTtsText(params: {
  cfg: OpenClawConfig;
  preparedTtsPreferences?: PreparedTtsPreferences;
  ttsAuto?: TtsAutoMode;
  agentId?: string;
  channelId?: string;
  accountId?: string;
  inboundAudio: boolean;
}): boolean {
  if (!resolveChannelTtsVoiceDelivery(params.channelId)?.captionedFinalText) {
    return false;
  }
  if (
    resolveConfiguredTtsMode(params.cfg, {
      agentId: params.agentId,
      channelId: params.channelId,
      accountId: params.accountId,
    }) !== "final"
  ) {
    return false;
  }
  const settings = resolveTtsSettingsSnapshot({
    cfg: params.cfg,
    preparedTtsPreferences: params.preparedTtsPreferences,
    sessionAuto: params.ttsAuto,
    agentId: params.agentId,
    channelId: params.channelId,
    accountId: params.accountId,
  });
  return (
    settings.autoMode !== "off" &&
    settings.autoMode !== "tagged" &&
    (settings.autoMode !== "inbound" || params.inboundAudio)
  );
}

export function mergeDeferredFinalText(streamedText: string, finalText?: string): string {
  const streamed = streamedText.trim();
  const final = finalText?.trim() ?? "";
  if (!streamed || streamed.replace(/\n{2,}/g, "\n") === final.replace(/\n{2,}/g, "\n")) {
    return final;
  }
  if (!final || streamed.startsWith(final)) {
    return streamed;
  }
  if (final.startsWith(streamed)) {
    return final;
  }
  return `${streamed}\n${final}`;
}

export function cleanDeferredFinalText(text: string | undefined): string {
  if (!text) {
    return "";
  }
  const cleaner = createTtsDirectiveTextStreamCleaner();
  return `${cleaner.push(text)}${cleaner.flush()}`;
}

export function buildCaptionedFinalTextFallback(payload: ReplyPayload): ReplyPayload {
  return copyReplyPayloadMetadata(payload, {
    text: payload.text,
    delivery: payload.delivery,
    replyToId: payload.replyToId,
    replyToTag: payload.replyToTag,
    replyToCurrent: payload.replyToCurrent,
  });
}
