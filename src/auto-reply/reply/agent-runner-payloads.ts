/** Builds final reply payloads after sanitization, media normalization, and dedupe. */
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { isMessagingToolDuplicate } from "../../agents/embedded-agent-helpers.js";
import { sanitizeUserFacingText } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import type { MessagingToolSend } from "../../agents/embedded-agent-messaging.types.js";
import type { ReplyToMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import {
  hasInteractiveReplyBlocks,
  hasMessagePresentationBlocks,
  hasReplyChannelData,
} from "../../interactive/payload.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { stripLegacyBracketToolCallBlocks } from "../../shared/text/assistant-visible-text.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import {
  appendReplyMediaFailureWarning,
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  markReplyPayloadForMessageToolDeliveryForReplyRoute,
  REPLY_MEDIA_FAILURE_WARNING,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
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

const replyPayloadsDedupeRuntimeLoader = createLazyImportLoader(
  () => import("./reply-payloads-dedupe.runtime.js"),
);

function loadReplyPayloadsDedupeRuntime() {
  return replyPayloadsDedupeRuntimeLoader.load();
}

function hasNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.some((entry) => typeof entry === "string" && entry.trim());
}

function shouldMarkHeartbeatMessageToolDelivered(
  payload: ReplyPayload,
  options: { requireTextMatch: boolean; sentTexts: string[] },
): boolean {
  if (payload.isError || payload.isFallbackNotice) {
    return false;
  }
  if (
    hasInteractiveReplyBlocks(payload.interactive) ||
    hasMessagePresentationBlocks(payload.presentation) ||
    hasReplyChannelData(payload.channelData)
  ) {
    return false;
  }
  const sendable = resolveSendableOutboundReplyParts(payload);
  if (sendable.text.includes(REPLY_MEDIA_FAILURE_WARNING)) {
    return false;
  }
  if (!sendable.hasText || sendable.hasMedia) {
    return false;
  }
  return !options.requireTextMatch || isMessagingToolDuplicate(sendable.text, options.sentTexts);
}

function requiresHeartbeatDelivery(payload: ReplyPayload): boolean {
  return payload.isReasoning !== true && hasOutboundReplyContent(payload);
}

function markHeartbeatMessageToolDeliveredPayloads(params: {
  payloads: ReplyPayload[];
  sentTexts: readonly string[];
  requireTextMatch: boolean;
}): ReplyPayload[] {
  if (params.requireTextMatch && params.sentTexts.length === 0) {
    return params.payloads;
  }
  const sentTexts = [...params.sentTexts];
  const requireTextMatch =
    params.requireTextMatch ||
    params.payloads.filter((payload) =>
      shouldMarkHeartbeatMessageToolDelivered(payload, {
        sentTexts,
        requireTextMatch: false,
      }),
    ).length > 1;
  let nextPayloads: ReplyPayload[] | undefined;
  for (let index = 0; index < params.payloads.length; index++) {
    const payload = params.payloads[index];
    if (
      !shouldMarkHeartbeatMessageToolDelivered(payload, {
        sentTexts,
        requireTextMatch,
      })
    ) {
      if (nextPayloads) {
        nextPayloads.push(payload);
      }
      continue;
    }
    if (!nextPayloads) {
      nextPayloads = params.payloads.slice(0, index);
    }
    nextPayloads.push(markReplyPayloadForMessageToolDeliveryForReplyRoute(payload));
  }
  return nextPayloads ?? params.payloads;
}

function isHeartbeatMessageToolDeliveredPayload(payload: ReplyPayload): boolean {
  return getReplyPayloadMetadata(payload)?.messageToolDeliveredForReplyRoute === true;
}

function finalizeHeartbeatMessageToolDeliveredPayloads(params: {
  payloads: ReplyPayload[];
  fallbackPayloads: ReplyPayload[];
}): ReplyPayload[] {
  let hasMessageToolDeliveredPayload = false;
  let hasUndeliveredPayload = false;
  for (const payload of params.payloads) {
    const messageToolDelivered = isHeartbeatMessageToolDeliveredPayload(payload);
    hasMessageToolDeliveredPayload ||= messageToolDelivered;
    if (!messageToolDelivered && requiresHeartbeatDelivery(payload)) {
      hasUndeliveredPayload = true;
    }
  }
  if (!hasUndeliveredPayload && !hasMessageToolDeliveredPayload) {
    const fallbackPayload = params.fallbackPayloads.find(isHeartbeatMessageToolDeliveredPayload);
    if (fallbackPayload) {
      return [...params.payloads, fallbackPayload];
    }
  }
  if (!hasMessageToolDeliveredPayload || !hasUndeliveredPayload) {
    return params.payloads;
  }
  return params.payloads.filter((payload) => !isHeartbeatMessageToolDeliveredPayload(payload));
}

async function normalizeReplyPayloadMedia(params: {
  payload: ReplyPayload;
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
  suppressMediaFailureWarning?: boolean;
}): Promise<ReplyPayload> {
  if (!params.normalizeMediaPaths || !resolveSendableOutboundReplyParts(params.payload).hasMedia) {
    return params.payload;
  }

  try {
    const normalized = await params.normalizeMediaPaths(params.payload);
    return copyReplyPayloadMetadata(params.payload, normalized);
  } catch (err) {
    logVerbose(`reply payload media normalization failed: ${String(err)}`);
    // Preserve the text reply and drop unusable media so channels can still send the answer.
    return copyReplyPayloadMetadata(params.payload, {
      ...params.payload,
      text: params.suppressMediaFailureWarning
        ? params.payload.text
        : appendReplyMediaFailureWarning(params.payload.text),
      mediaUrl: undefined,
      mediaUrls: undefined,
      audioAsVoice: false,
    });
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

function shouldKeepPayloadDuringSilentTurn(payload: ReplyPayload): boolean {
  if (payload.isError) {
    return true;
  }
  return payload.audioAsVoice === true && resolveSendableOutboundReplyParts(payload).hasMedia;
}

function sanitizeFinalReplyText(
  payload: ReplyPayload,
  text: string | undefined,
): string | undefined {
  if (!text) {
    return text;
  }
  return sanitizeUserFacingText(text, { errorContext: Boolean(payload.isError) });
}

function sanitizeHeartbeatPayload(payload: ReplyPayload): ReplyPayload {
  const text = payload.text;
  if (!text) {
    return payload;
  }
  const withoutLegacyBlocks = stripLegacyBracketToolCallBlocks(text);
  const cleaned = sanitizeFinalReplyText(payload, withoutLegacyBlocks);
  if (cleaned === text) {
    return payload;
  }
  if (withoutLegacyBlocks !== text) {
    logVerbose("Stripped legacy tool-call block from heartbeat reply");
  }
  return copyPayloadWithSanitizedText(payload, cleaned);
}

function copyPayloadWithSanitizedText(
  payload: ReplyPayload,
  text: string | undefined,
): ReplyPayload {
  const sanitizedText = sanitizeFinalReplyText(payload, text);
  const next = copyReplyPayloadMetadata(payload, {
    ...payload,
    text: sanitizedText,
  });
  const mirror = getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror;
  if (!mirror?.text) {
    return next;
  }
  setReplyPayloadMetadata(next, {
    sourceReplyTranscriptMirror: {
      ...mirror,
      text: sanitizeFinalReplyText(payload, mirror.text) || undefined,
    },
  });
  return next;
}

/** Builds final outbound payloads from agent output and message-tool delivery evidence. */
export async function buildReplyPayloads(params: {
  payloads: ReplyPayload[];
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
  originatingThreadId?: string | number;
  accountId?: string;
  allowImplicitCurrentRouteMessageToolEvidence?: boolean;
  extractMarkdownImages?: boolean;
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
}): Promise<{ replyPayloads: ReplyPayload[]; didLogHeartbeatStrip: boolean }> {
  let didLogHeartbeatStrip = params.didLogHeartbeatStrip;
  const sanitizedPayloads: ReplyPayload[] = [];
  if (params.isHeartbeat) {
    for (const payload of params.payloads) {
      sanitizedPayloads.push(sanitizeHeartbeatPayload(payload));
    }
  } else {
    for (const payload of params.payloads) {
      let text = payload.text;

      if (payload.isError && text && isBunFetchSocketError(text)) {
        text = formatBunFetchSocketError(text);
      }

      if (!text || !text.includes("HEARTBEAT_OK")) {
        sanitizedPayloads.push(copyPayloadWithSanitizedText(payload, text));
        continue;
      }
      const stripped = stripHeartbeatToken(text, { mode: "message" });
      if (stripped.didStrip && !didLogHeartbeatStrip) {
        didLogHeartbeatStrip = true;
        logVerbose("Stripped stray HEARTBEAT_OK token from reply");
      }
      const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
      if (stripped.shouldSkip && !hasMedia) {
        continue;
      }
      sanitizedPayloads.push(copyPayloadWithSanitizedText(payload, stripped.text));
    }
  }

  const replyTaggedPayloadCandidates = await Promise.all(
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
        extractMarkdownImages: params.extractMarkdownImages,
      });
      const mediaNormalizedPayload = await normalizeReplyPayloadMedia({
        payload: parsed.payload,
        normalizeMediaPaths: params.normalizeMediaPaths,
        suppressMediaFailureWarning: parsed.isSilent,
      });
      if (parsed.isSilent) {
        mediaNormalizedPayload.text = undefined;
      }
      return mediaNormalizedPayload;
    }),
  );
  const replyTaggedPayloads: ReplyPayload[] = [];
  for (const payload of replyTaggedPayloadCandidates) {
    if (isRenderablePayload(payload)) {
      replyTaggedPayloads.push(payload);
    }
  }
  const silentFilteredPayloads: ReplyPayload[] = [];
  if (params.silentExpected) {
    for (const payload of replyTaggedPayloads) {
      if (shouldKeepPayloadDuringSilentTurn(payload)) {
        silentFilteredPayloads.push(payload);
      }
    }
  } else {
    silentFilteredPayloads.push(...replyTaggedPayloads);
  }

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
  const messagingToolPayloadDedupe = dedupeRuntime?.resolveMessagingToolPayloadDedupe({
    messageProvider: resolveOriginMessageProvider({
      originatingChannel: params.originatingChannel,
      provider: params.messageProvider,
    }),
    messagingToolSentTargets,
    originatingTo: resolveOriginMessageTo({
      originatingTo: params.originatingTo,
    }),
    originatingThreadId: params.originatingThreadId,
    accountId: resolveOriginAccountId({
      originatingAccountId: params.accountId,
    }),
  }) ?? {
    shouldDedupePayloads: shouldCheckMessagingToolDedupe && messagingToolSentTargets.length === 0,
    matchingRoute: false,
    routeSentTexts: [],
    routeSentMediaUrls: [],
    useGlobalSentTextEvidenceFallback: false,
    useGlobalSentMediaUrlEvidenceFallback: false,
  };
  const dedupeMessagingToolPayloads = messagingToolPayloadDedupe.shouldDedupePayloads;
  const sentMediaUrlFallback = params.messagingToolSentMediaUrls ?? [];
  const shouldUseGlobalSentMediaUrlEvidence =
    messagingToolPayloadDedupe.matchingRoute &&
    messagingToolPayloadDedupe.routeSentMediaUrls.length === 0 &&
    messagingToolPayloadDedupe.useGlobalSentMediaUrlEvidenceFallback;
  const shouldUseGlobalSentTextEvidence =
    messagingToolPayloadDedupe.matchingRoute &&
    messagingToolPayloadDedupe.routeSentTexts.length === 0 &&
    messagingToolPayloadDedupe.useGlobalSentTextEvidenceFallback;
  const sentMediaUrlsForDedupe = messagingToolPayloadDedupe.matchingRoute
    ? shouldUseGlobalSentMediaUrlEvidence
      ? sentMediaUrlFallback
      : messagingToolPayloadDedupe.routeSentMediaUrls
    : sentMediaUrlFallback;
  const sentTextsForDedupe = messagingToolPayloadDedupe.matchingRoute
    ? shouldUseGlobalSentTextEvidence
      ? messagingToolSentTexts
      : messagingToolPayloadDedupe.routeSentTexts
    : messagingToolSentTexts;
  const currentRouteHasImplicitMessageToolTextEvidence =
    params.allowImplicitCurrentRouteMessageToolEvidence === true &&
    messagingToolSentTargets.length === 0 &&
    hasNonEmptyStringArray(messagingToolSentTexts) &&
    Boolean(
      resolveOriginMessageProvider({
        originatingChannel: params.originatingChannel,
        provider: params.messageProvider,
      }) &&
      resolveOriginMessageTo({
        originatingTo: params.originatingTo,
      }),
    );
  const currentRouteHasExplicitMessageToolTextEvidence =
    messagingToolPayloadDedupe.matchingRoute && hasNonEmptyStringArray(sentTextsForDedupe);
  const heartbeatMessageToolDeliveryEvidence =
    params.isHeartbeat && currentRouteHasExplicitMessageToolTextEvidence
      ? { sentTexts: sentTextsForDedupe, requireTextMatch: false }
      : params.isHeartbeat && currentRouteHasImplicitMessageToolTextEvidence
        ? { sentTexts: messagingToolSentTexts, requireTextMatch: true }
        : null;
  const messagingToolSentMediaUrls = dedupeMessagingToolPayloads
    ? await normalizeSentMediaUrlsForDedupe({
        sentMediaUrls: sentMediaUrlsForDedupe,
        normalizeMediaPaths: params.normalizeMediaPaths,
      })
    : sentMediaUrlsForDedupe;
  const mediaFilteredPayloads = dedupeMessagingToolPayloads
    ? (
        dedupeRuntime ?? (await loadReplyPayloadsDedupeRuntime())
      ).filterMessagingToolMediaDuplicates({
        payloads: silentFilteredPayloads,
        sentMediaUrls: messagingToolSentMediaUrls,
      })
    : silentFilteredPayloads;
  const dedupedPayloads = heartbeatMessageToolDeliveryEvidence
    ? markHeartbeatMessageToolDeliveredPayloads({
        payloads: mediaFilteredPayloads,
        ...heartbeatMessageToolDeliveryEvidence,
      })
    : params.isHeartbeat
      ? mediaFilteredPayloads
      : dedupeMessagingToolPayloads
        ? (dedupeRuntime ?? (await loadReplyPayloadsDedupeRuntime())).filterMessagingToolDuplicates(
            {
              payloads: mediaFilteredPayloads,
              sentTexts: sentTextsForDedupe,
            },
          )
        : mediaFilteredPayloads;
  const isDirectlySentBlockPayload = (payload: ReplyPayload) =>
    Boolean(params.directlySentBlockKeys?.has(createBlockReplyContentKey(payload)));
  const preserveUnsentMediaAfterBlockStream = (payload: ReplyPayload): ReplyPayload | null => {
    if (payload.isError || payload.isFallbackNotice) {
      return payload;
    }
    const reply = resolveSendableOutboundReplyParts(payload);
    if (!reply.hasMedia) {
      return null;
    }
    if (!reply.trimmedText) {
      return payload;
    }
    const textOnlyPayload = copyReplyPayloadMetadata(payload, {
      ...payload,
      mediaUrl: undefined,
      mediaUrls: undefined,
      audioAsVoice: undefined,
    });
    if (!params.blockReplyPipeline?.hasSentPayload(textOnlyPayload)) {
      return payload;
    }
    return copyReplyPayloadMetadata(payload, {
      ...payload,
      text: undefined,
      audioAsVoice: payload.audioAsVoice || undefined,
    });
  };
  const contentSuppressedPayloads = shouldDropFinalPayloads
    ? (() => {
        const preserved: ReplyPayload[] = [];
        for (const payload of dedupedPayloads) {
          const next = preserveUnsentMediaAfterBlockStream(payload);
          if (next) {
            preserved.push(next);
          }
        }
        return preserved;
      })()
    : params.blockStreamingEnabled
      ? (() => {
          const unsent: ReplyPayload[] = [];
          for (const payload of dedupedPayloads) {
            if (
              !params.blockReplyPipeline?.hasSentPayload(payload) &&
              !isDirectlySentBlockPayload(payload)
            ) {
              unsent.push(payload);
            }
          }
          return unsent;
        })()
      : params.directlySentBlockKeys?.size
        ? (() => {
            const unsent: ReplyPayload[] = [];
            for (const payload of dedupedPayloads) {
              if (!params.directlySentBlockKeys.has(createBlockReplyContentKey(payload))) {
                unsent.push(payload);
              }
            }
            return unsent;
          })()
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
  const postMediaMarkedPayloads = heartbeatMessageToolDeliveryEvidence
    ? markHeartbeatMessageToolDeliveredPayloads({
        payloads: filteredPayloads,
        ...heartbeatMessageToolDeliveryEvidence,
      })
    : filteredPayloads;
  const deliveryFinalizedPayloads = heartbeatMessageToolDeliveryEvidence
    ? finalizeHeartbeatMessageToolDeliveredPayloads({
        payloads: postMediaMarkedPayloads,
        fallbackPayloads: dedupedPayloads,
      })
    : postMediaMarkedPayloads;
  const replyPayloads: ReplyPayload[] = [];
  for (const payload of deliveryFinalizedPayloads) {
    if (isRenderablePayload(payload)) {
      replyPayloads.push(payload);
    }
  }

  return {
    replyPayloads,
    didLogHeartbeatStrip,
  };
}
