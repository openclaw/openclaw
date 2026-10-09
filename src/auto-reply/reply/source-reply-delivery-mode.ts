import {
  isSyntheticSourceReplyTurn,
  type ReplyExpectation,
} from "../../agents/reply-completion.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveSilentReplySettings } from "../../config/silent-reply.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isProgressCardRefreshInputProvenance } from "../../sessions/input-provenance.js";
import type { SessionSendPolicyDecision } from "../../sessions/send-policy.js";
import { classifySilentReplyConversationType } from "../../shared/silent-reply-policy.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveCommandTurnContext } from "../command-turn-context.js";
import { isExplicitCommandTurnContext } from "../command-turn-detection.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import type { MsgContext } from "../templating.js";

export type SourceReplyDeliveryModeContext = Pick<
  MsgContext,
  | "ChatType"
  | "SessionKey"
  | "InboundEventKind"
  | "Provider"
  | "Surface"
  | "ExplicitDeliverRoute"
  | "CommandAuthorized"
  | "CommandBody"
  | "CommandSource"
  | "CommandTurn"
  | "BotUsername"
  | "WasMentioned"
  | "InputProvenance"
>;

export function isUnauthorizedTextSlashCommand(ctx: SourceReplyDeliveryModeContext): boolean {
  const commandTurn = resolveCommandTurnContext(ctx);
  return (
    commandTurn.kind === "text-slash" &&
    !commandTurn.authorized &&
    (commandTurn.commandName !== undefined || commandTurn.body?.trim().startsWith("/") === true)
  );
}

/** Returns true for internal message-channel turns that should remain local. */
export function isInternalSourceReplyChannel(ctx: SourceReplyDeliveryModeContext): boolean {
  const providerChannel = normalizeMessageChannel(ctx.Provider);
  const surfaceChannel = normalizeMessageChannel(ctx.Surface);
  const currentSurface = providerChannel ?? surfaceChannel;
  return (
    currentSurface === INTERNAL_MESSAGE_CHANNEL &&
    (surfaceChannel === INTERNAL_MESSAGE_CHANNEL || !surfaceChannel) &&
    ctx.ExplicitDeliverRoute !== true
  );
}

export function resolveSourceReplyDeliveryMode(params: {
  cfg: OpenClawConfig;
  ctx: SourceReplyDeliveryModeContext;
  requested?: SourceReplyDeliveryMode;
  strictMessageToolOnly?: boolean;
  messageToolAvailable?: boolean;
  defaultVisibleReplies?: "automatic" | "message_tool";
}): SourceReplyDeliveryMode {
  if (params.strictMessageToolOnly === true) {
    return "message_tool_only";
  }
  if (params.ctx.InboundEventKind === "room_event" && !isInternalSourceReplyChannel(params.ctx)) {
    return "message_tool_only";
  }
  if (
    params.requested &&
    (params.requested !== "message_tool_only" || params.messageToolAvailable !== false)
  ) {
    return params.requested;
  }
  if (isExplicitCommandTurnContext(params.ctx, params.cfg)) {
    return "automatic";
  }
  const chatType = normalizeChatType(params.ctx.ChatType);
  const isGroup = chatType === "group" || chatType === "channel";
  if (isGroup && isUnauthorizedTextSlashCommand(params.ctx)) {
    return "message_tool_only";
  }
  const configuredMode = isGroup
    ? (params.cfg.messages?.groupChat?.visibleReplies ?? params.cfg.messages?.visibleReplies)
    : (params.cfg.messages?.visibleReplies ??
      (isInternalSourceReplyChannel(params.ctx) ? "automatic" : params.defaultVisibleReplies));
  return configuredMode === "message_tool" && params.messageToolAvailable !== false
    ? "message_tool_only"
    : "automatic";
}

/** Selects reply requiredness at admission, preserving configured ambient group silence. */
export function resolveSourceReplyExpectation(params: {
  ctx: SourceReplyDeliveryModeContext;
  cfg: OpenClawConfig;
  isHeartbeat?: boolean;
}): ReplyExpectation {
  if (
    isSyntheticSourceReplyTurn({
      inputProvenance: params.ctx.InputProvenance,
      isHeartbeat: params.isHeartbeat,
    })
  ) {
    return "optional";
  }
  if (isExplicitCommandTurnContext(params.ctx, params.cfg)) {
    return "required";
  }
  if (params.ctx.InboundEventKind === "room_event") {
    return "optional";
  }
  const chatType = normalizeChatType(params.ctx.ChatType);
  const conversationType = classifySilentReplyConversationType({
    conversationType: chatType === "group" || chatType === "channel" ? "group" : chatType,
    sessionKey: params.ctx.SessionKey,
    surface: params.ctx.Surface ?? params.ctx.Provider,
  });
  if (
    conversationType === "group" &&
    params.ctx.WasMentioned !== true &&
    resolveSilentReplySettings({
      cfg: params.cfg,
      surface: params.ctx.Surface ?? params.ctx.Provider,
      conversationType: "group",
    }).policy === "allow"
  ) {
    return "optional";
  }
  return "required";
}

export function resolveSourceReplyVisibilityPolicy(params: {
  cfg: OpenClawConfig;
  ctx: SourceReplyDeliveryModeContext;
  requested?: SourceReplyDeliveryMode;
  strictMessageToolOnly?: boolean;
  sendPolicy: SessionSendPolicyDecision;
  suppressAcpChildUserDelivery?: boolean;
  explicitSuppressTyping?: boolean;
  shouldSuppressTyping?: boolean;
  messageToolAvailable?: boolean;
  /**
   * Sender-independent availability for the session-stable mode. The stable
   * mode feeds CLI binding facts shared by every turn kind, so a sender-scoped
   * message-tool denial must not downgrade it while sender-less synthetic
   * turns resolve tool-only — that hash split resets the CLI session (#121485).
   */
  sessionStableMessageToolAvailable?: boolean;
  defaultVisibleReplies?: "automatic" | "message_tool";
  isHeartbeat?: boolean;
}) {
  const sourceReplyDeliveryMode = resolveSourceReplyDeliveryMode(params);
  const hasStableTurnOverride =
    !isSyntheticSourceReplyTurn({
      inputProvenance: params.ctx.InputProvenance,
      isHeartbeat: params.isHeartbeat,
    }) &&
    (params.requested !== undefined || isExplicitCommandTurnContext(params.ctx, params.cfg));
  const sessionStableSourceReplyDeliveryMode = hasStableTurnOverride
    ? sourceReplyDeliveryMode
    : resolveSourceReplyDeliveryMode({
        cfg: params.cfg,
        ctx: {
          ChatType: params.ctx.ChatType,
          Provider: params.ctx.Provider,
          Surface: params.ctx.Surface,
          ExplicitDeliverRoute: params.ctx.ExplicitDeliverRoute,
        },
        messageToolAvailable:
          params.sessionStableMessageToolAvailable ?? params.messageToolAvailable,
        defaultVisibleReplies: params.defaultVisibleReplies,
      });
  const sendPolicyDenied = params.sendPolicy === "deny";
  const progressRefresh = isProgressCardRefreshInputProvenance(params.ctx.InputProvenance);
  const suppressAutomaticSourceDelivery =
    progressRefresh || sourceReplyDeliveryMode === "message_tool_only";
  const suppressDelivery = sendPolicyDenied || suppressAutomaticSourceDelivery;
  const deliverySuppressionReason = sendPolicyDenied
    ? "sendPolicy: deny"
    : progressRefresh
      ? "progress card refresh"
      : suppressAutomaticSourceDelivery
        ? "sourceReplyDeliveryMode: message_tool_only"
        : "";

  const suppressTyping =
    progressRefresh ||
    sendPolicyDenied ||
    params.explicitSuppressTyping === true ||
    params.shouldSuppressTyping === true;

  return {
    sourceReplyDeliveryMode,
    sessionStableSourceReplyDeliveryMode,
    sendPolicyDenied,
    suppressAutomaticSourceDelivery,
    suppressDelivery,
    suppressHookUserDelivery: params.suppressAcpChildUserDelivery === true || suppressDelivery,
    suppressHookReplyLifecycle: suppressTyping || params.suppressAcpChildUserDelivery === true,
    suppressTyping,
    deliverySuppressionReason,
  };
}
