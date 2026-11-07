import type { MessagingToolSend } from "../../agents/embedded-agent-messaging.types.js";
import type { ReplyToMode } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setReplyPayloadMetadata, isRenderablePayload } from "../reply-payload.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import type { AdmittedFollowupTurn } from "./reply-agent-turn-preparation.js";
import { normalizeSentMediaUrlsForDedupe } from "./reply-media-dedupe.js";
import { applyReplyTagsToPayload } from "./reply-payloads-base.js";
import { filterMessagingToolReplyPayload } from "./reply-payloads-dedupe.js";
import {
  createReplyDeliveryContext,
  createReplyToModeFilterForChannel,
  resolveReplyToMode,
} from "./reply-threading.js";

export function resolveFollowupPayloadContext(turn: AdmittedFollowupTurn) {
  return {
    cfg: turn.config,
    messageProvider: turn.queued.run.messageProvider,
    originatingAccountId: turn.queued.originatingAccountId ?? turn.queued.run.agentAccountId,
    originatingChannel: turn.queued.originatingChannel,
    originatingChatType: turn.queued.originatingChatType,
    originatingReplyToMode: turn.queued.originatingReplyToMode,
    originatingTo: turn.queued.originatingTo,
    originatingThreadId: turn.queued.originatingThreadId,
  };
}

/** Normalizes delivery content, applies threading, and dedupes message-tool sends. */
export async function resolveFollowupDeliveryPayloads(params: {
  cfg: OpenClawConfig;
  payloads: ReplyPayload[];
  normalizePayload?: (payload: ReplyPayload) => Promise<ReplyPayload>;
  messageProvider?: string;
  originatingAccountId?: string;
  originatingChannel?: string;
  originatingChatType?: string | null;
  originatingReplyToMode?: ReplyToMode;
  originatingTo?: string;
  originatingThreadId?: string | number;
  reasoningPayloadsEnabled?: boolean;
  commentaryPayloadsEnabled?: boolean;
  sentMediaUrls?: string[];
  sentTargets?: MessagingToolSend[];
  sentTexts?: string[];
  onDeliveredTerminalDuplicate?: () => void;
}): Promise<ReplyPayload[]> {
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
  const accountId = params.originatingAccountId;
  const replyDelivery = createReplyDeliveryContext(replyToMode, params.originatingChatType);
  const replyDeliverySource = replyMessageProvider
    ? {
        channel: replyMessageProvider,
        ...(accountId ? { accountId } : {}),
      }
    : undefined;
  const sanitizedPayloads = params.payloads.flatMap((payload) =>
    (payload.isReasoning === true && params.reasoningPayloadsEnabled !== true) ||
    (payload.isCommentary === true && params.commentaryPayloadsEnabled !== true)
      ? []
      : (normalizeReplyPayload(payload, { applyChannelTransforms: false }) ?? []),
  );
  // Retain the media owner's source references before deduping against tool sends.
  const preparedPayloads = params.normalizePayload
    ? await Promise.all(sanitizedPayloads.map(params.normalizePayload))
    : sanitizedPayloads;
  const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
  const resolvedPayloads: ReplyPayload[] = [];
  for (const payload of preparedPayloads) {
    const deduped = await filterMessagingToolReplyPayload({
      payload: applyReplyToMode.preview(
        setReplyPayloadMetadata(applyReplyTagsToPayload({ payload }), {
          replyDelivery,
          ...(replyDeliverySource ? { replyDeliverySource } : {}),
        }),
      ),
      config: params.cfg,
      messageProvider: replyMessageProvider,
      messagingToolSentTargets: params.sentTargets,
      originatingTo: params.originatingTo,
      originatingThreadId: params.originatingThreadId,
      accountId,
      sentMediaUrls: params.sentMediaUrls,
      sentTexts: params.sentTexts,
      onDeliveredTerminalDuplicate: params.onDeliveredTerminalDuplicate,
      normalizeSentMediaUrls: (sentMediaUrls) =>
        normalizeSentMediaUrlsForDedupe({
          sentMediaUrls,
          normalizeMediaPaths: params.normalizePayload,
        }),
    });
    resolvedPayloads.push(...deduped.filter(isRenderablePayload).map(applyReplyToMode));
  }
  return resolvedPayloads;
}
