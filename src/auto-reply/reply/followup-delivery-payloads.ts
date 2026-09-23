import type { MessagingToolSend } from "../../agents/embedded-agent-messaging.types.js";
import type { ReplyToMode } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setReplyPayloadMetadata, isRenderablePayload } from "../reply-payload.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { applyReplyTagsToPayload } from "./reply-payloads-base.js";
import { filterMessagingToolReplyPayload } from "./reply-payloads.js";
import {
  createReplyDeliveryContext,
  createReplyToModeFilterForChannel,
  resolveReplyToMode,
} from "./reply-threading.js";

/** Normalizes delivery content, applies threading, and dedupes message-tool sends. */
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
  reasoningPayloadsEnabled?: boolean;
  commentaryPayloadsEnabled?: boolean;
  sentMediaUrls?: string[];
  sentTargets?: MessagingToolSend[];
  sentTexts?: string[];
  onDeliveredTerminalDuplicate?: () => void;
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
  const accountId = params.originatingAccountId;
  const replyDelivery = createReplyDeliveryContext(replyToMode, params.originatingChatType);
  const replyDeliverySource = replyMessageProvider
    ? {
        channel: replyMessageProvider,
        ...(accountId ? { accountId } : {}),
      }
    : undefined;
  const deliverablePayloads = params.payloads.filter(
    (payload) =>
      !(payload.isReasoning === true && params.reasoningPayloadsEnabled !== true) &&
      !(payload.isCommentary === true && params.commentaryPayloadsEnabled !== true),
  );
  const sanitizedPayloads: ReplyPayload[] = [];
  for (const payload of deliverablePayloads) {
    const normalized = normalizeReplyPayload(payload, { applyChannelTransforms: false });
    if (normalized) {
      sanitizedPayloads.push(normalized);
    }
  }
  const originatingTo = params.originatingTo;
  const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
  return sanitizedPayloads.flatMap((payload) =>
    filterMessagingToolReplyPayload({
      payload: applyReplyToMode.preview(
        setReplyPayloadMetadata(applyReplyTagsToPayload(payload), {
          replyDelivery,
          ...(replyDeliverySource ? { replyDeliverySource } : {}),
        }),
      ),
      config: params.cfg,
      messageProvider: replyMessageProvider,
      messagingToolSentTargets: params.sentTargets,
      originatingTo,
      originatingThreadId: params.originatingThreadId,
      accountId,
      sentMediaUrls: params.sentMediaUrls,
      sentTexts: params.sentTexts,
      onDeliveredTerminalDuplicate: params.onDeliveredTerminalDuplicate,
    })
      .filter(isRenderablePayload)
      .map(applyReplyToMode),
  );
}
