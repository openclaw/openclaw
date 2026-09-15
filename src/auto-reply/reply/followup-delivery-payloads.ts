import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import type { MessagingToolSend } from "../../agents/embedded-agent-messaging.types.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { ReplyToMode } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import { copyReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { isRenderablePayload, resolveReplyThreadingPayloads } from "./reply-payloads-base.js";
import { filterMessagingToolReplyPayload } from "./reply-payloads.js";
import {
  createReplyDeliveryContext,
  createReplyToModeFilterForChannel,
  resolveReplyToMode,
} from "./reply-threading.js";

/** Resolver-less channels inject here; channels with a transport resolver decide at route time. */
function resolveChannelOwnedImplicitCurrentMessageId(params: {
  channel?: string;
  currentMessageId?: string;
}): string | undefined {
  const currentMessageId = params.currentMessageId;
  if (!currentMessageId) {
    return undefined;
  }
  // SAFETY: originating provider is already a registered channel id or lookup is undefined.
  const plugin = params.channel ? getChannelPlugin(params.channel as ChannelId) : undefined;
  // Calling the resolver here cannot see per-payload opt-outs (`replyToId: ""`).
  // Leave that correlation on routeReply so empty / explicit targets survive.
  if (plugin?.threading?.resolveReplyTransport) {
    return undefined;
  }
  return currentMessageId;
}

/** Strips empty/heartbeat payloads, applies threading, and dedupes message-tool sends. */
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
  currentMessageId?: string;
  reasoningPayloadsEnabled?: boolean;
  commentaryPayloadsEnabled?: boolean;
  sentMediaUrls?: string[];
  sentTargets?: MessagingToolSend[];
  sentTexts?: string[];
}): ReplyPayload[] {
  const replyMessageProvider = resolveOriginMessageProvider({
    originatingChannel: params.originatingChannel,
    provider: params.messageProvider,
  });
  // SAFETY: resolveOriginMessageProvider already returns a channel id or undefined.
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
    const text = payload.text;
    const sanitized =
      text?.includes("HEARTBEAT_OK") === true
        ? copyReplyPayloadMetadata(payload, {
            ...payload,
            text: stripHeartbeatToken(text, { mode: "message" }).text,
          })
        : payload;
    // Normalize before callers decide whether the run was empty. Otherwise a
    // whitespace-only model payload can suppress the interactive fallback.
    if (hasOutboundReplyContent(sanitized, { trimText: true })) {
      sanitizedPayloads.push(sanitized);
    }
  }
  const originatingTo = params.originatingTo;
  const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
  const threadedPayloads = resolveReplyThreadingPayloads({
    payloads: sanitizedPayloads,
    replyToMode,
    replyToChannel,
    currentMessageId: resolveChannelOwnedImplicitCurrentMessageId({
      channel: replyMessageProvider,
      currentMessageId: params.currentMessageId,
    }),
  });
  return threadedPayloads.flatMap((payload) =>
    filterMessagingToolReplyPayload({
      payload: applyReplyToMode.preview(
        setReplyPayloadMetadata(payload, {
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
    })
      .filter(isRenderablePayload)
      .map(applyReplyToMode),
  );
}
