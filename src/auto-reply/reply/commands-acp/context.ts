import { normalizeConversationText } from "../../../acp/conversation-id.js";
import { resolveChannelConfiguredBindingProviderByChannel } from "../../../channels/plugins/binding-provider.js";
import { resolveConversationIdFromTargets } from "../../../infra/outbound/conversation-id.js";
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
  const channel = resolveAcpCommandChannel(params);
  const threadId = resolveAcpCommandThreadId(params);
  const provider = resolveChannelConfiguredBindingProviderByChannel(channel);
  const resolvedByProvider = provider?.resolveCommandConversation?.({
    accountId: resolveAcpCommandAccountId(params),
    threadId,
    threadParentId: normalizeConversationText(params.ctx.ThreadParentId),
    senderId: normalizeConversationText(params.command.senderId ?? params.ctx.SenderId),
    sessionKey: params.sessionKey,
    parentSessionKey: normalizeConversationText(params.ctx.ParentSessionKey),
    originatingTo: params.ctx.OriginatingTo,
    commandTo: params.command.to,
    fallbackTo: params.ctx.To,
  });
  if (resolvedByProvider?.conversationId) {
    return resolvedByProvider;
  }
  const targets = [params.ctx.OriginatingTo, params.command.to, params.ctx.To];
  const conversationId = resolveConversationIdFromTargets({
    threadId,
    targets,
  });
  if (!conversationId) {
    return null;
  }
  const parentConversationId = threadId
    ? resolveConversationIdFromTargets({
        targets,
      })
    : undefined;
  return {
    conversationId,
    ...(parentConversationId && parentConversationId !== conversationId
      ? { parentConversationId }
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
