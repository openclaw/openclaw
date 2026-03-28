import { normalizeConversationText } from "../../../acp/conversation-id.js";
import { resolveConversationBindingContext } from "../../../channels/conversation-binding-context.js";
import type { HandleCommandsParams } from "../commands-types.js";

export function resolveAcpCommandChannel(params: HandleCommandsParams): string {
  const raw =
    params.ctx.OriginatingChannel ??
    params.command.channel ??
    params.ctx.Surface ??
    params.ctx.Provider;
  return normalizeConversationText(raw).toLowerCase();
}

export function resolveAcpCommandAccountId(params: HandleCommandsParams): string {
  const accountId = normalizeConversationText(params.ctx.AccountId);
  return accountId || "default";
}

export function resolveAcpCommandThreadId(params: HandleCommandsParams): string | undefined {
  const threadId =
    params.ctx.MessageThreadId != null
      ? normalizeConversationText(String(params.ctx.MessageThreadId))
      : "";
  return threadId || undefined;
}

function resolveAcpCommandConversationRef(params: HandleCommandsParams): {
  conversationId: string;
  parentConversationId?: string;
} | null {
  const resolved = resolveConversationBindingContext({
    cfg: params.cfg,
    channel: resolveAcpCommandChannel(params),
    accountId: resolveAcpCommandAccountId(params),
    chatType: params.ctx.ChatType,
    threadId: resolveAcpCommandThreadId(params),
    threadParentId: params.ctx.ThreadParentId,
    senderId: params.command.senderId ?? params.ctx.SenderId,
    sessionKey: params.sessionKey,
    parentSessionKey: params.ctx.ParentSessionKey,
    originatingTo: params.ctx.OriginatingTo,
    commandTo: params.command.to,
    fallbackTo: params.ctx.To,
    from: params.ctx.From,
    nativeChannelId: params.ctx.NativeChannelId,
  });
  if (!resolved) {
    return null;
  }
  return {
    conversationId: resolved.conversationId,
    ...(resolved.parentConversationId && resolved.parentConversationId !== resolved.conversationId
      ? { parentConversationId: resolved.parentConversationId }
      : {}),
  };
}

export function resolveAcpCommandConversationId(params: HandleCommandsParams): string | undefined {
  return resolveAcpCommandConversationRef(params)?.conversationId;
}

export function resolveAcpCommandParentConversationId(
  params: HandleCommandsParams,
): string | undefined {
  return resolveAcpCommandConversationRef(params)?.parentConversationId;
}

export function resolveAcpCommandBindingContext(params: HandleCommandsParams): {
  channel: string;
  accountId: string;
  threadId?: string;
  conversationId?: string;
  parentConversationId?: string;
} {
  const conversationRef = resolveAcpCommandConversationRef(params);
  if (!conversationRef) {
    return {
      channel: resolveAcpCommandChannel(params),
      accountId: resolveAcpCommandAccountId(params),
      threadId: resolveAcpCommandThreadId(params),
    };
  }
  return {
    channel: resolveAcpCommandChannel(params),
    accountId: resolveAcpCommandAccountId(params),
    threadId: resolveAcpCommandThreadId(params),
    conversationId: conversationRef.conversationId,
    ...(conversationRef.parentConversationId
      ? { parentConversationId: conversationRef.parentConversationId }
      : {}),
  };
}
