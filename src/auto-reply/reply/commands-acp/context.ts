import {
  buildTelegramTopicConversationId,
  normalizeConversationText,
  parseTelegramChatIdFromTarget,
} from "../../../acp/conversation-id.js";
import {
  DISCORD_THREAD_BINDING_CHANNEL,
  SLACK_THREAD_BINDING_CHANNEL,
} from "../../../channels/thread-bindings-policy.js";
import {
  resolveConversationIdFromTargets,
  resolveParentConversationIdFromTargets,
} from "../../../infra/outbound/conversation-id.js";
import type { HandleCommandsParams } from "../commands-types.js";
import { parseDiscordParentChannelFromSessionKey } from "../discord-parent-channel.js";
import { resolveTelegramConversationId } from "../telegram-context.js";

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

export function resolveAcpCommandConversationId(params: HandleCommandsParams): string | undefined {
  const channel = resolveAcpCommandChannel(params);
  if (channel === "telegram") {
    const telegramConversationId = resolveTelegramConversationId({
      ctx: {
        MessageThreadId: params.ctx.MessageThreadId,
        OriginatingTo: params.ctx.OriginatingTo,
        To: params.ctx.To,
      },
      command: {
        to: params.command.to,
      },
    });
    if (telegramConversationId) {
      return telegramConversationId;
    }
    const threadId = resolveAcpCommandThreadId(params);
    const parentConversationId = resolveAcpCommandParentConversationId(params);
    if (threadId && parentConversationId) {
      return (
        buildTelegramTopicConversationId({
          chatId: parentConversationId,
          topicId: threadId,
        }) ?? threadId
      );
    }
  }
  return resolveConversationIdFromTargets({
    threadId: params.ctx.MessageThreadId,
    targets: [params.ctx.OriginatingTo, params.command.to, params.ctx.To],
  });
}

function parseDiscordParentChannelFromContext(raw: unknown): string | undefined {
  const parentId = normalizeConversationText(raw);
  if (!parentId) {
    return undefined;
  }
  return parentId;
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
    const fromContext = parseDiscordParentChannelFromContext(params.ctx.ThreadParentId);
    if (fromContext && fromContext !== threadId) {
      return fromContext;
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
    return undefined;
  }
  if (channel === SLACK_THREAD_BINDING_CHANNEL) {
    const fromTargets = resolveParentConversationIdFromTargets({
      targets: [params.ctx.OriginatingTo, params.command.to, params.ctx.To],
    });
    if (fromTargets) {
      return fromTargets;
    }
    const fromContext = normalizeConversationText(params.ctx.ThreadParentId);
    if (fromContext) {
      return fromContext;
    }
    const fromOriginatingConversationId = normalizeConversationText(
      params.ctx.OriginatingConversationId,
    );
    return fromOriginatingConversationId || undefined;
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
