import { normalizeConversationText } from "../../acp/conversation-id.js";
import { resolveConversationBindingContext } from "../../channels/conversation-binding-context.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import type { HandleCommandsParams } from "./commands-types.js";

type BindingMsgContext = Pick<
  MsgContext,
  | "OriginatingChannel"
  | "Surface"
  | "Provider"
  | "AccountId"
  | "ChatType"
  | "MessageThreadId"
  | "ThreadParentId"
  | "SenderId"
  | "SessionKey"
  | "ParentSessionKey"
  | "OriginatingTo"
  | "To"
  | "From"
  | "NativeChannelId"
>;

function resolveBindingChannel(ctx: BindingMsgContext, commandChannel?: string | null): string {
  const raw = ctx.OriginatingChannel ?? commandChannel ?? ctx.Surface ?? ctx.Provider;
  return normalizeConversationText(raw).toLowerCase();
}

function resolveBindingAccountId(ctx: BindingMsgContext): string {
  const accountId = normalizeConversationText(ctx.AccountId);
  return accountId || "default";
}

function resolveBindingThreadId(threadId: string | number | null | undefined): string | undefined {
  const normalized = threadId != null ? normalizeConversationText(String(threadId)) : undefined;
  return normalized || undefined;
}

export function resolveConversationBindingContextFromMessage(params: {
  cfg: OpenClawConfig;
  ctx: BindingMsgContext;
  senderId?: string | null;
  sessionKey?: string | null;
  parentSessionKey?: string | null;
  commandTo?: string | null;
}): ReturnType<typeof resolveConversationBindingContext> {
  return resolveConversationBindingContext({
    cfg: params.cfg,
    channel: resolveBindingChannel(params.ctx),
    accountId: resolveBindingAccountId(params.ctx),
    chatType: params.ctx.ChatType,
    threadId: resolveBindingThreadId(params.ctx.MessageThreadId),
    threadParentId: params.ctx.ThreadParentId,
    senderId: params.senderId ?? params.ctx.SenderId,
    sessionKey: params.sessionKey ?? params.ctx.SessionKey,
    parentSessionKey: params.parentSessionKey ?? params.ctx.ParentSessionKey,
    originatingTo: params.ctx.OriginatingTo,
    commandTo: params.commandTo,
    fallbackTo: params.ctx.To,
    from: params.ctx.From,
    nativeChannelId: params.ctx.NativeChannelId,
  });
}

export function resolveConversationBindingContextFromAcpCommand(
  params: HandleCommandsParams,
): ReturnType<typeof resolveConversationBindingContext> {
  return resolveConversationBindingContextFromMessage({
    cfg: params.cfg,
    ctx: params.ctx,
    senderId: params.command.senderId,
    sessionKey: params.sessionKey,
    parentSessionKey: params.ctx.ParentSessionKey,
    commandTo: params.command.to,
  });
}

export function resolveConversationBindingChannelFromMessage(
  ctx: BindingMsgContext,
  commandChannel?: string | null,
): string {
  return resolveBindingChannel(ctx, commandChannel);
}

export function resolveConversationBindingAccountIdFromMessage(ctx: BindingMsgContext): string {
  return resolveBindingAccountId(ctx);
}

export function resolveConversationBindingThreadIdFromMessage(
  ctx: Pick<BindingMsgContext, "MessageThreadId">,
): string | undefined {
  return resolveBindingThreadId(ctx.MessageThreadId);
}
