import {
  resolveSendableOutboundReplyParts,
  setReplyPayloadMetadata,
} from "openclaw/plugin-sdk/reply-payload";
import type { MessagingToolSend } from "../../agents/pi-embedded-messaging.types.js";
import type { ReplyToMode } from "../../config/types.js";
import type { EmotionMode } from "../../emotion-mode.js";
import { isEmotionModeEnabled } from "../../emotion-mode.js";
import { logVerbose } from "../../globals.js";
import { sanitizeEmotionTagsForMode } from "../../shared/text/emotion-tags.js";
import { stripInlineDirectiveTagsForDelivery } from "../../utils/directive-tags.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { OriginatingChannelType } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload, ReplyThreadingPolicy } from "../types.js";
import { formatBunFetchSocketError, isBunFetchSocketError } from "./agent-runner-utils.js";
import { createBlockReplyContentKey, type BlockReplyPipeline } from "./block-reply-pipeline.js";
import {
  resolveOriginAccountId,
  resolveOriginMessageProvider,
  resolveOriginMessageTo,
} from "./origin-routing.js";
import { normalizeReplyPayloadDirectives } from "./reply-delivery.js";
import { applyReplyThreading, isRenderablePayload } from "./reply-payloads-base.js";

let replyPayloadsDedupeRuntimePromise: Promise<
  typeof import("./reply-payloads-dedupe.runtime.js")
> | null = null;

const EMOTION_RAW_TTS_TEXT_KEY = "__openclawEmotionRawTtsText";

type EmotionTaggedPayload = ReplyPayload & {
  [EMOTION_RAW_TTS_TEXT_KEY]?: string;
};

function loadReplyPayloadsDedupeRuntime() {
  replyPayloadsDedupeRuntimePromise ??= import("./reply-payloads-dedupe.runtime.js");
  return replyPayloadsDedupeRuntimePromise;
}

async function normalizeReplyPayloadMedia(params: {
  payload: ReplyPayload;
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
}): Promise<ReplyPayload> {
  if (!params.normalizeMediaPaths || !resolveSendableOutboundReplyParts(params.payload).hasMedia) {
    return params.payload;
  }

  try {
    return await params.normalizeMediaPaths(params.payload);
  } catch (err) {
    logVerbose(`reply payload media normalization failed: ${String(err)}`);
    return {
      ...params.payload,
      mediaUrl: undefined,
      mediaUrls: undefined,
      audioAsVoice: false,
    };
  }
}

async function normalizeSentMediaUrlsForDedupe(params: {
  sentMediaUrls: readonly string[];
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
}): Promise<string[]> {
  if (params.sentMediaUrls.length === 0 || !params.normalizeMediaPaths) {
    return [...params.sentMediaUrls];
  }

  const normalizedUrls: string[] = [];
  const seen = new Set<string>();
  for (const raw of params.sentMediaUrls) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      normalizedUrls.push(trimmed);
    }
    try {
      const normalized = await params.normalizeMediaPaths({
        mediaUrl: trimmed,
        mediaUrls: [trimmed],
      });
      const normalizedMediaUrls = resolveSendableOutboundReplyParts(normalized).mediaUrls;
      for (const mediaUrl of normalizedMediaUrls) {
        const candidate = mediaUrl.trim();
        if (!candidate || seen.has(candidate)) {
          continue;
        }
        seen.add(candidate);
        normalizedUrls.push(candidate);
      }
    } catch (err) {
      logVerbose(`messaging tool sent-media normalization failed: ${String(err)}`);
    }
  }

  return normalizedUrls;
}

export async function buildReplyPayloads(params: {
  payloads: ReplyPayload[];
  emotionMode?: EmotionMode;
  isHeartbeat: boolean;
  didLogHeartbeatStrip: boolean;
  silentExpected?: boolean;
  blockStreamingEnabled: boolean;
  blockReplyPipeline: BlockReplyPipeline | null;
  /** Payload keys sent directly (not via pipeline) during tool flush. */
  directlySentBlockKeys?: Set<string>;
  replyToMode: ReplyToMode;
  replyToChannel?: OriginatingChannelType;
  currentMessageId?: string;
  replyThreading?: ReplyThreadingPolicy;
  messageProvider?: string;
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  messagingToolSentTargets?: MessagingToolSend[];
  originatingChannel?: OriginatingChannelType;
  originatingTo?: string;
  accountId?: string;
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
}): Promise<{ replyPayloads: ReplyPayload[]; didLogHeartbeatStrip: boolean }> {
  let didLogHeartbeatStrip = params.didLogHeartbeatStrip;
  const emotionMode = params.emotionMode ?? "off";
  const preserveRawEmotionTtsText = isEmotionModeEnabled(emotionMode);
  const sanitizedPayloads: EmotionTaggedPayload[] = params.isHeartbeat
    ? params.payloads
    : params.payloads.flatMap((payload) => {
        let text = payload.text;
        let rawEmotionTtsText: string | undefined;

        if (payload.isError && text && isBunFetchSocketError(text)) {
          text = formatBunFetchSocketError(text);
        }

        if (!text || !text.includes("HEARTBEAT_OK")) {
          if (typeof text === "string") {
            if (preserveRawEmotionTtsText) {
              rawEmotionTtsText = text;
            }
            const emotionSanitized = sanitizeEmotionTagsForMode(text, emotionMode);
            text = emotionSanitized.text;
          }
          return [
            {
              ...payload,
              text,
              // Per chatgpt-codex P2 + Copilot reviews on PR-D's
              // agent-runner-payloads.ts:151,153: in `/emotions full` mode the
              // sanitizer is a no-op so `rawEmotionTtsText === text`. Without
              // dropping the inequality guard, the EMOTION_RAW_TTS_TEXT_KEY
              // marker would never get set, so PR-A's writer would never set
              // `ttsSourceText` and ElevenLabs would lose its expressive variant.
              // Carry the raw whenever emotion mode is enabled.
              ...(typeof rawEmotionTtsText === "string"
                ? { [EMOTION_RAW_TTS_TEXT_KEY]: rawEmotionTtsText }
                : {}),
            },
          ];
        }
        const stripped = stripHeartbeatToken(text, { mode: "message" });
        if (stripped.didStrip && !didLogHeartbeatStrip) {
          didLogHeartbeatStrip = true;
          logVerbose("Stripped stray HEARTBEAT_OK token from reply");
        }
        const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
        if (stripped.shouldSkip && !hasMedia) {
          return [];
        }
        if (preserveRawEmotionTtsText) {
          rawEmotionTtsText = stripped.text;
        }
        const emotionSanitized = sanitizeEmotionTagsForMode(stripped.text, emotionMode);
        return [
          {
            ...payload,
            text: emotionSanitized.text,
            // See note above on the `/emotions full` no-op sanitizer issue.
            ...(typeof rawEmotionTtsText === "string"
              ? { [EMOTION_RAW_TTS_TEXT_KEY]: rawEmotionTtsText }
              : {}),
          },
        ];
      });

  const replyTaggedPayloads = (
    await Promise.all(
      applyReplyThreading({
        payloads: sanitizedPayloads,
        replyToMode: params.replyToMode,
        replyToChannel: params.replyToChannel,
        currentMessageId: params.currentMessageId,
        replyThreading: params.replyThreading,
      }).map(async (payload) => {
        const parsed = normalizeReplyPayloadDirectives({
          payload,
          currentMessageId: params.currentMessageId,
          silentToken: SILENT_REPLY_TOKEN,
          parseMode: "always",
        });
        const parsedPayload = parsed.payload as EmotionTaggedPayload;
        const rawEmotionTtsText =
          typeof parsedPayload[EMOTION_RAW_TTS_TEXT_KEY] === "string"
            ? parsedPayload[EMOTION_RAW_TTS_TEXT_KEY]
            : undefined;
        const mediaNormalizedPayload = (await normalizeReplyPayloadMedia({
          payload: parsedPayload,
          normalizeMediaPaths: params.normalizeMediaPaths,
        })) as EmotionTaggedPayload;
        // Strip inline directive tags ([[audio_as_voice]] etc.) BEFORE handing the
        // raw text to TTS, otherwise tag-aware providers would speak the directive.
        // Order: directive strip first, emotion tag strip later (PR-A's TTS layer).
        const cleanedRawEmotionTtsText =
          typeof rawEmotionTtsText === "string"
            ? stripInlineDirectiveTagsForDelivery(rawEmotionTtsText).text
            : undefined;
        if (
          typeof cleanedRawEmotionTtsText === "string" &&
          cleanedRawEmotionTtsText.trim().length > 0
        ) {
          // Per chatgpt-codex P1 review: in `/emotions full` mode the visible reply
          // text intentionally still contains expressive tags. Without an explicit
          // ttsPlainText, plain TTS providers in PR-A's fallback chain would speak
          // the tag words out loud. Compute the stripped variant here so the per-
          // provider router gets a clean fallback regardless of emotion mode.
          const cleanedPlainTtsText = sanitizeEmotionTagsForMode(
            cleanedRawEmotionTtsText,
            "on", // force-strip; emotion mode is already factored into rawEmotionTtsText
          ).text.trim();
          setReplyPayloadMetadata(mediaNormalizedPayload, {
            ttsSourceText: cleanedRawEmotionTtsText,
            ...(cleanedPlainTtsText !== cleanedRawEmotionTtsText
              ? { ttsPlainText: cleanedPlainTtsText }
              : {}),
          });
        }
        delete mediaNormalizedPayload[EMOTION_RAW_TTS_TEXT_KEY];
        if (
          parsed.isSilent &&
          !resolveSendableOutboundReplyParts(mediaNormalizedPayload).hasMedia
        ) {
          mediaNormalizedPayload.text = undefined;
        }
        return mediaNormalizedPayload;
      }),
    )
  ).filter(isRenderablePayload);
  const silentFilteredPayloads = params.silentExpected ? [] : replyTaggedPayloads;

  // Drop final payloads only when block streaming succeeded end-to-end.
  // If streaming aborted (e.g., timeout), fall back to final payloads.
  const shouldDropFinalPayloads =
    params.blockStreamingEnabled &&
    Boolean(params.blockReplyPipeline?.didStream()) &&
    !params.blockReplyPipeline?.isAborted();
  const messagingToolSentTexts = params.messagingToolSentTexts ?? [];
  const messagingToolSentTargets = params.messagingToolSentTargets ?? [];
  const shouldCheckMessagingToolDedupe =
    messagingToolSentTexts.length > 0 ||
    (params.messagingToolSentMediaUrls?.length ?? 0) > 0 ||
    messagingToolSentTargets.length > 0;
  const dedupeRuntime = shouldCheckMessagingToolDedupe
    ? await loadReplyPayloadsDedupeRuntime()
    : null;
  const suppressMessagingToolReplies =
    dedupeRuntime?.shouldSuppressMessagingToolReplies({
      messageProvider: resolveOriginMessageProvider({
        originatingChannel: params.originatingChannel,
        provider: params.messageProvider,
      }),
      messagingToolSentTargets,
      originatingTo: resolveOriginMessageTo({
        originatingTo: params.originatingTo,
      }),
      accountId: resolveOriginAccountId({
        originatingAccountId: params.accountId,
      }),
    }) ?? false;
  // Only dedupe against messaging tool sends for the same origin target.
  // Cross-target sends (for example posting to another channel) must not
  // suppress the current conversation's final reply.
  // If target metadata is unavailable, keep legacy dedupe behavior.
  const dedupeMessagingToolPayloads =
    suppressMessagingToolReplies || messagingToolSentTargets.length === 0;
  const messagingToolSentMediaUrls = dedupeMessagingToolPayloads
    ? await normalizeSentMediaUrlsForDedupe({
        sentMediaUrls: params.messagingToolSentMediaUrls ?? [],
        normalizeMediaPaths: params.normalizeMediaPaths,
      })
    : (params.messagingToolSentMediaUrls ?? []);
  const mediaFilteredPayloads = dedupeMessagingToolPayloads
    ? (
        dedupeRuntime ?? (await loadReplyPayloadsDedupeRuntime())
      ).filterMessagingToolMediaDuplicates({
        payloads: silentFilteredPayloads,
        sentMediaUrls: messagingToolSentMediaUrls,
      })
    : silentFilteredPayloads;
  const dedupedPayloads = dedupeMessagingToolPayloads
    ? (dedupeRuntime ?? (await loadReplyPayloadsDedupeRuntime())).filterMessagingToolDuplicates({
        payloads: mediaFilteredPayloads,
        sentTexts: messagingToolSentTexts,
      })
    : mediaFilteredPayloads;
  const isDirectlySentBlockPayload = (payload: ReplyPayload) =>
    Boolean(params.directlySentBlockKeys?.has(createBlockReplyContentKey(payload)));
  const contentSuppressedPayloads = shouldDropFinalPayloads
    ? dedupedPayloads.filter((payload) => payload.isError)
    : params.blockStreamingEnabled
      ? dedupedPayloads.filter(
          (payload) =>
            !params.blockReplyPipeline?.hasSentPayload(payload) &&
            !isDirectlySentBlockPayload(payload),
        )
      : params.directlySentBlockKeys?.size
        ? dedupedPayloads.filter(
            (payload) => !params.directlySentBlockKeys!.has(createBlockReplyContentKey(payload)),
          )
        : dedupedPayloads;
  const blockSentMediaUrls = params.blockStreamingEnabled
    ? await normalizeSentMediaUrlsForDedupe({
        sentMediaUrls: params.blockReplyPipeline?.getSentMediaUrls() ?? [],
        normalizeMediaPaths: params.normalizeMediaPaths,
      })
    : [];
  const filteredPayloads =
    blockSentMediaUrls.length > 0
      ? (
          dedupeRuntime ?? (await loadReplyPayloadsDedupeRuntime())
        ).filterMessagingToolMediaDuplicates({
          payloads: contentSuppressedPayloads,
          sentMediaUrls: blockSentMediaUrls,
        })
      : contentSuppressedPayloads;
  const replyPayloads = suppressMessagingToolReplies ? [] : filteredPayloads;

  return {
    replyPayloads,
    didLogHeartbeatStrip,
  };
}
