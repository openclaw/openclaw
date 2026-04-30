import { normalizeChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SessionSendPolicyDecision } from "../../sessions/send-policy.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";

const log = createSubsystemLogger("auto-reply", { prefix: "auto-reply" });

let visibleRepliesMigrationWarned = false;

export type SourceReplyDeliveryModeContext = {
  ChatType?: string;
  CommandSource?: "text" | "native";
};

export function resolveSourceReplyDeliveryMode(params: {
  cfg: OpenClawConfig;
  ctx: SourceReplyDeliveryModeContext;
  requested?: SourceReplyDeliveryMode;
}): SourceReplyDeliveryMode {
  if (params.requested) {
    return params.requested;
  }
  if (params.ctx.CommandSource === "native") {
    return "automatic";
  }
  const chatType = normalizeChatType(params.ctx.ChatType);
  if (chatType === "group" || chatType === "channel") {
    const configuredMode =
      params.cfg.messages?.groupChat?.visibleReplies ?? params.cfg.messages?.visibleReplies;
    if (configuredMode === undefined && !visibleRepliesMigrationWarned) {
      visibleRepliesMigrationWarned = true;
      log.warn(
        `Group/channel replies are private by default since 2026.4.27. ` +
          `To restore automatic posting to all group chats, add ` +
          `"messages": { "groupChat": { "visibleReplies": "automatic" } } to openclaw.json and restart the gateway. ` +
          `See https://github.com/openclaw/openclaw/issues/74876`,
      );
    }
    return configuredMode === "automatic" ? "automatic" : "message_tool_only";
  }
  return params.cfg.messages?.visibleReplies === "message_tool" ? "message_tool_only" : "automatic";
}

export type SourceReplyVisibilityPolicy = {
  sourceReplyDeliveryMode: SourceReplyDeliveryMode;
  sendPolicyDenied: boolean;
  suppressAutomaticSourceDelivery: boolean;
  suppressDelivery: boolean;
  suppressHookUserDelivery: boolean;
  suppressHookReplyLifecycle: boolean;
  suppressTyping: boolean;
  deliverySuppressionReason: string;
};

export function resolveSourceReplyVisibilityPolicy(params: {
  cfg: OpenClawConfig;
  ctx: SourceReplyDeliveryModeContext;
  requested?: SourceReplyDeliveryMode;
  sendPolicy: SessionSendPolicyDecision;
  suppressAcpChildUserDelivery?: boolean;
  explicitSuppressTyping?: boolean;
  shouldSuppressTyping?: boolean;
}): SourceReplyVisibilityPolicy {
  const sourceReplyDeliveryMode = resolveSourceReplyDeliveryMode({
    cfg: params.cfg,
    ctx: params.ctx,
    requested: params.requested,
  });
  const sendPolicyDenied = params.sendPolicy === "deny";
  const suppressAutomaticSourceDelivery = sourceReplyDeliveryMode === "message_tool_only";
  const suppressDelivery = sendPolicyDenied || suppressAutomaticSourceDelivery;
  const deliverySuppressionReason = sendPolicyDenied
    ? "sendPolicy: deny"
    : suppressAutomaticSourceDelivery
      ? "sourceReplyDeliveryMode: message_tool_only"
      : "";

  return {
    sourceReplyDeliveryMode,
    sendPolicyDenied,
    suppressAutomaticSourceDelivery,
    suppressDelivery,
    suppressHookUserDelivery: params.suppressAcpChildUserDelivery === true || suppressDelivery,
    suppressHookReplyLifecycle:
      sendPolicyDenied ||
      params.suppressAcpChildUserDelivery === true ||
      params.explicitSuppressTyping === true ||
      params.shouldSuppressTyping === true,
    suppressTyping:
      sendPolicyDenied ||
      params.explicitSuppressTyping === true ||
      params.shouldSuppressTyping === true,
    deliverySuppressionReason,
  };
}
