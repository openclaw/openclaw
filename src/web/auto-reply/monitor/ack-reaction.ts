import { shouldAckReactionForWhatsApp } from "../../../channels/ack-reactions.js";
import type { loadConfig } from "../../../config/config.js";
import { logVerbose } from "../../../globals.js";
import { sendReactionWhatsApp } from "../../outbound.js";
import { formatError } from "../../session.js";
import type { WebInboundMsg } from "../types.js";
import { resolveGroupActivationFor } from "./group-activation.js";

export type WhatsAppAckReactionTarget = {
  chatId: string;
  messageId: string;
  participant?: string;
  accountId?: string;
};

export type WhatsAppAckReactionDecision = {
  shouldReact: boolean;
  emoji: string;
  target: WhatsAppAckReactionTarget | null;
};

export function resolveWhatsAppAckReactionDecision(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  agentId: string;
  sessionKey: string;
  conversationId: string;
  accountId?: string;
}): WhatsAppAckReactionDecision {
  if (!params.msg.id) {
    return { shouldReact: false, emoji: "", target: null };
  }

  const ackConfig = params.cfg.channels?.whatsapp?.ackReaction;
  const emoji = (ackConfig?.emoji ?? "").trim();
  const directEnabled = ackConfig?.direct ?? true;
  const groupMode = ackConfig?.group ?? "mentions";
  const conversationIdForCheck =
    params.msg.conversationId ?? params.conversationId ?? params.msg.from;

  const activation =
    params.msg.chatType === "group"
      ? resolveGroupActivationFor({
          cfg: params.cfg,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          conversationId: conversationIdForCheck,
        })
      : null;
  const shouldReact = shouldAckReactionForWhatsApp({
    emoji,
    isDirect: params.msg.chatType === "direct",
    isGroup: params.msg.chatType === "group",
    directEnabled,
    groupMode,
    wasMentioned: params.msg.wasMentioned === true,
    groupActivated: activation === "always",
  });

  if (!shouldReact) {
    return { shouldReact: false, emoji, target: null };
  }

  return {
    shouldReact: true,
    emoji,
    target: {
      chatId: params.msg.chatId,
      messageId: params.msg.id,
      participant: params.msg.senderJid,
      accountId: params.accountId,
    },
  };
}

export function maybeSendAckReaction(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  agentId: string;
  sessionKey: string;
  conversationId: string;
  verbose: boolean;
  accountId?: string;
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}) {
  const decision = resolveWhatsAppAckReactionDecision({
    cfg: params.cfg,
    msg: params.msg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    conversationId: params.conversationId,
    accountId: params.accountId,
  });
  if (!decision.shouldReact || !decision.target) {
    return;
  }
  const target = decision.target;

  params.info(
    {
      chatId: target.chatId,
      messageId: target.messageId,
      emoji: decision.emoji,
    },
    "sending ack reaction",
  );
  sendReactionWhatsApp(target.chatId, target.messageId, decision.emoji, {
    verbose: params.verbose,
    fromMe: false,
    participant: target.participant,
    accountId: target.accountId,
  }).catch((err) => {
    params.warn(
      {
        error: formatError(err),
        chatId: target.chatId,
        messageId: target.messageId,
      },
      "failed to send ack reaction",
    );
    logVerbose(`WhatsApp ack reaction failed for chat ${target.chatId}: ${formatError(err)}`);
  });
}
