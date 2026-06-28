/** Prepares queued follow-up payloads for source-channel delivery. */
import type { MessagingToolSend } from "../../agents/embedded-agent-messaging.types.js";
import type { ReplyToMode } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import {
  resolveOriginAccountId,
  resolveOriginMessageProvider,
  resolveOriginMessageTo,
} from "./origin-routing.js";
import {
  applyReplyThreading,
  filterMessagingToolDuplicates,
  filterMessagingToolMediaDuplicates,
  resolveMessagingToolPayloadDedupe,
} from "./reply-payloads.js";
import { createReplyDeliveryContext, resolveReplyToMode } from "./reply-threading.js";

function hasReplyPayloadMedia(payload: ReplyPayload): boolean {
  if (typeof payload.mediaUrl === "string" && payload.mediaUrl.trim().length > 0) {
    return true;
  }
  return Array.isArray(payload.mediaUrls) && payload.mediaUrls.some((url) => url.trim().length > 0);
}

/** Strips heartbeat tokens, applies threading, and dedupes message-tool sends. */
export function resolveFollowupDeliveryPayloads(params: {
  cfg: OpenClawConfig;
  payloads: ReplyPayload[];
  messageProvider?: string;
  originatingAccountId?: string;
  originatingChannel?: string;
  originatingChatType?: string | null;
  originatingReplyToMode?: ReplyToMode;
  originatingTo?: string;
  originatingThreadId?: string | number;
  sentMediaUrls?: string[];
  sentTargets?: MessagingToolSend[];
  sentTexts?: string[];
}): ReplyPayload[] {
  const replyMessageProvider = resolveOriginMessageProvider({
    originatingChannel: params.originatingChannel,
    provider: params.messageProvider,
  });
  const replyToChannel = replyMessageProvider as OriginatingChannelType | undefined;
  const replyToMode =
    params.originatingReplyToMode ??
    resolveReplyToMode(
      params.cfg,
      replyToChannel,
      params.originatingAccountId,
      params.originatingChatType,
    );
  const accountId = resolveOriginAccountId({
    originatingAccountId: params.originatingAccountId,
  });
  const replyDelivery = createReplyDeliveryContext(replyToMode, params.originatingChatType);
  const replyDeliverySource = replyMessageProvider
    ? {
        channel: replyMessageProvider,
        ...(accountId ? { accountId } : {}),
      }
    : undefined;
  const sanitizedPayloads: ReplyPayload[] = [];
  for (const payload of params.payloads) {
    const text = payload.text;
    if (!text || !text.includes("HEARTBEAT_OK")) {
      sanitizedPayloads.push(payload);
      continue;
    }
    const stripped = stripHeartbeatToken(text, { mode: "message" });
    const hasMedia = hasReplyPayloadMedia(payload);
    if (stripped.shouldSkip && !hasMedia) {
      continue;
    }
    sanitizedPayloads.push(copyReplyPayloadMetadata(payload, { ...payload, text: stripped.text }));
  }
  const replyTaggedPayloads = applyReplyThreading({
    payloads: sanitizedPayloads,
    replyToMode,
    replyToChannel,
  }).map((payload) =>
    setReplyPayloadMetadata(payload, {
      replyDelivery,
      ...(replyDeliverySource ? { replyDeliverySource } : {}),
    }),
  );
  const sentMediaUrlFallback = params.sentMediaUrls ?? [];
  const sentTextFallback = params.sentTexts ?? [];
  const originatingTo = resolveOriginMessageTo({
    originatingTo: params.originatingTo,
  });
  const dedupedPayloads: ReplyPayload[] = [];
  for (const payload of replyTaggedPayloads) {
    const decision = resolveMessagingToolPayloadDedupe({
      config: params.cfg,
      messageProvider: replyMessageProvider,
      messagingToolSentTargets: params.sentTargets,
      originatingTo,
      originatingThreadId: params.originatingThreadId,
      replyToId: payload.replyToId ?? undefined,
      replyToIsExplicit: Boolean(
        getReplyPayloadMetadata(payload)?.replyToIdExplicit ||
        payload.replyToTag ||
        payload.replyToCurrent,
      ),
      replyDelivery: getReplyPayloadMetadata(payload)?.replyDelivery,
      accountId,
    });
    if (!decision.shouldDedupePayloads) {
      dedupedPayloads.push(payload);
      continue;
    }
    const sentMediaUrls =
      decision.matchingRoute && !decision.useGlobalSentMediaUrlEvidenceFallback
        ? decision.routeSentMediaUrls
        : sentMediaUrlFallback;
    const sentTexts =
      decision.matchingRoute && !decision.useGlobalSentTextEvidenceFallback
        ? decision.routeSentTexts
        : sentTextFallback;
    const mediaFiltered = filterMessagingToolMediaDuplicates({
      payloads: [payload],
      sentMediaUrls,
    });
    const textFiltered = filterMessagingToolDuplicates({
      payloads: mediaFiltered,
      sentTexts,
    });
    dedupedPayloads.push(...textFiltered);
  }
  return dedupedPayloads;
}
