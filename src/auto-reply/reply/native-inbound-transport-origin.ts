import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { resolveInboundConversationResolution } from "../../channels/conversation-resolution.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Only admitted, single native turns can make a user transcript reply-selectable. */
export function resolveNativeInboundTransportOrigin(params: {
  cfg: OpenClawConfig;
  messageId?: string | null;
  chatId?: string | number | null;
  channel?: string | null;
  routedChannel?: string | null;
  accountId?: string | null;
  to?: string | null;
  from?: string | null;
  threadId?: string | number | null;
  threadParentId?: string | number | null;
  chatType?: string | null;
  synthetic: boolean;
}): RunEmbeddedAgentParams["inboundTransport"] {
  const messageId = normalizeOptionalString(params.messageId);
  const chatId = normalizeOptionalString(params.chatId);
  const channel = normalizeOptionalString(params.channel);
  if (
    !messageId ||
    !chatId ||
    (channel !== "telegram" && channel !== "discord") ||
    channel !== params.routedChannel ||
    !params.chatType ||
    params.synthetic
  ) {
    return undefined;
  }
  const resolved = resolveInboundConversationResolution({
    cfg: params.cfg,
    channel,
    accountId: params.accountId,
    to: params.to,
    conversationId: chatId,
    from: params.from,
    threadId: params.threadId,
    threadParentId: params.threadParentId,
    isGroup: params.chatType !== "direct",
  });
  if (!resolved) {
    return undefined;
  }
  return {
    messageId,
    conversation: {
      channel: resolved.channel,
      accountId: resolved.accountId,
      conversationId: resolved.conversationId,
      ...(resolved.parentConversationId
        ? { parentConversationId: resolved.parentConversationId }
        : {}),
    },
  };
}
