import { normalizeConversationText } from "../../../acp/conversation-id.js";
import type { HandleCommandsParams } from "../commands-types.js";
import {
  resolveConversationBindingAccountIdFromMessage,
  resolveConversationBindingChannelFromMessage,
  resolveConversationBindingContextFromAcpCommand,
  resolveConversationBindingThreadIdFromMessage,
} from "../conversation-binding-input.js";

export function resolveAcpCommandChannel(params: HandleCommandsParams): string {
  const resolved = resolveConversationBindingChannelFromMessage(params.ctx, params.command.channel);
  return normalizeConversationText(resolved).toLowerCase();
}

export function resolveAcpCommandAccountId(params: HandleCommandsParams): string {
  return resolveConversationBindingAccountIdFromMessage(params.ctx);
}

export function resolveAcpCommandThreadId(params: HandleCommandsParams): string | undefined {
  return resolveConversationBindingThreadIdFromMessage(params.ctx);
}

function resolveAcpCommandConversationRef(params: HandleCommandsParams): {
  conversationId: string;
  parentConversationId?: string;
} | null {
  const resolved = resolveConversationBindingContextFromAcpCommand(params);
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
