import {
  buildTelegramTopicConversationId,
  parseTelegramChatIdFromTarget,
} from "../../../acp/conversation-id.js";
import { DISCORD_THREAD_BINDING_CHANNEL } from "../../../channels/thread-bindings-policy.js";
import { resolveConversationIdFromTargets } from "../../../infra/outbound/conversation-id.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import type { HandleCommandsParams } from "../commands-types.js";

function normalizeString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return `${value}`.trim();
  }
  return "";
}

export function resolveAcpCommandChannel(params: HandleCommandsParams): string {
  const raw =
    params.ctx.OriginatingChannel ??
    params.command.channel ??
    params.ctx.Surface ??
    params.ctx.Provider;
  return normalizeString(raw).toLowerCase();
}

export function resolveAcpCommandAccountId(params: HandleCommandsParams): string {
  const accountId = normalizeString(params.ctx.AccountId);
  return accountId || "default";
}

export function resolveAcpCommandThreadId(params: HandleCommandsParams): string | undefined {
  const threadId =
    params.ctx.MessageThreadId != null ? normalizeString(String(params.ctx.MessageThreadId)) : "";
  return threadId || undefined;
}

export function resolveAcpCommandConversationId(params: HandleCommandsParams): string | undefined {
  const channel = resolveAcpCommandChannel(params);
  if (channel === "telegram") {
    const threadId = resolveAcpCommandThreadId(params);
    const parentConversationId = resolveAcpCommandParentConversationId(params);
    if (threadId && parentConversationId) {
      const canonical = buildTelegramTopicConversationId({
        chatId: parentConversationId,
        topicId: threadId,
      });
      if (canonical) {
        return canonical;
      }
    }
    if (threadId) {
      return threadId;
    }
  }
  return resolveConversationIdFromTargets({
    threadId: params.ctx.MessageThreadId,
    targets: [params.ctx.OriginatingTo, params.command.to, params.ctx.To],
  });
}

function parseDiscordParentChannelFromSessionKey(raw: unknown): string | undefined {
  const sessionKey = normalizeString(raw);
  if (!sessionKey) {
    return undefined;
  }
  const scoped = parseAgentSessionKey(sessionKey)?.rest ?? sessionKey.toLowerCase();
  const match = scoped.match(/(?:^|:)channel:([^:]+)$/);
  if (!match?.[1]) {
    return undefined;
  }
  return match[1];
}

export function resolveAcpCommandParentConversationId(
  params: HandleCommandsParams,
): string | undefined {
  const channel = resolveAcpCommandChannel(params);
  if (channel === "telegram") {
    return (
      parseTelegramChatIdFromTarget(params.ctx.OriginatingTo) ??
      parseTelegramChatIdFromTarget(params.command.to) ??
      parseTelegramChatIdFromTarget(params.ctx.To)
    );
  }
  if (channel === DISCORD_THREAD_BINDING_CHANNEL) {
    const threadId = resolveAcpCommandThreadId(params);
    if (!threadId) {
      return undefined;
    }
    const fromParentSession = parseDiscordParentChannelFromSessionKey(params.ctx.ParentSessionKey);
    if (fromParentSession && fromParentSession !== threadId) {
      return fromParentSession;
    }
    const fromTargets = resolveConversationIdFromTargets({
      targets: [params.ctx.OriginatingTo, params.command.to, params.ctx.To],
    });
    if (fromTargets && fromTargets !== threadId) {
      return fromTargets;
    }
  }
  return undefined;
}

export function isAcpCommandDiscordChannel(params: HandleCommandsParams): boolean {
  return resolveAcpCommandChannel(params) === DISCORD_THREAD_BINDING_CHANNEL;
}

export function resolveAcpCommandBindingContext(params: HandleCommandsParams): {
  channel: string;
  accountId: string;
  threadId?: string;
  conversationId?: string;
  parentConversationId?: string;
} {
  const parentConversationId = resolveAcpCommandParentConversationId(params);
  return {
    channel: resolveAcpCommandChannel(params),
    accountId: resolveAcpCommandAccountId(params),
    threadId: resolveAcpCommandThreadId(params),
    conversationId: resolveAcpCommandConversationId(params),
    ...(parentConversationId ? { parentConversationId } : {}),
  };
}
