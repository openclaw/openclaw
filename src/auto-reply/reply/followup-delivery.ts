import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { MessagingToolSend } from "../../agents/pi-embedded-runner.js";
import type { OpenClawConfig } from "../../config/config.js";
import { stripHeartbeatToken } from "../heartbeat.js";
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
  shouldSuppressMessagingToolReplies,
} from "./reply-payloads.js";
import { resolveReplyToMode } from "./reply-threading.js";

export function resolveFollowupDeliveryPayloads(params: {
  cfg: OpenClawConfig;
  payloads: ReplyPayload[];
  messageProvider?: string;
  originatingAccountId?: string;
  originatingChannel?: string;
  originatingChatType?: string | null;
  originatingTo?: string;
  sentMediaUrls?: string[];
  sentTargets?: MessagingToolSend[];
  sentTexts?: string[];
}): ReplyPayload[] {
  const replyToChannel = resolveOriginMessageProvider({
    originatingChannel: params.originatingChannel,
    provider: params.messageProvider,
  }) as OriginatingChannelType | undefined;
  const replyToMode = resolveReplyToMode(
    params.cfg,
    replyToChannel,
    params.originatingAccountId,
    params.originatingChatType,
  );
  const sanitizedPayloads = params.payloads.flatMap((payload) => {
    const text = payload.text;
    if (!text || !text.includes("HEARTBEAT_OK")) {
      return [payload];
    }
    const stripped = stripHeartbeatToken(text, { mode: "message" });
    const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
    if (stripped.shouldSkip && !hasMedia) {
      return [];
    }
    return [{ ...payload, text: stripped.text }];
  });
  const replyTaggedPayloads = applyReplyThreading({
    payloads: sanitizedPayloads,
    replyToMode,
    replyToChannel,
  });
  const dedupedPayloads = filterMessagingToolDuplicates({
    payloads: replyTaggedPayloads,
    sentTexts: params.sentTexts ?? [],
  });
  const mediaFilteredPayloads = filterMessagingToolMediaDuplicates({
    payloads: dedupedPayloads,
    sentMediaUrls: params.sentMediaUrls ?? [],
  });
  const suppressMessagingToolReplies = shouldSuppressMessagingToolReplies({
    messageProvider: replyToChannel,
    messagingToolSentTargets: params.sentTargets,
    originatingTo: resolveOriginMessageTo({
      originatingTo: params.originatingTo,
    }),
    accountId: resolveOriginAccountId({
      originatingAccountId: params.originatingAccountId,
    }),
  });
  return suppressMessagingToolReplies ? [] : mediaFilteredPayloads;
}
