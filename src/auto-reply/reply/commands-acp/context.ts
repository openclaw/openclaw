import {
  buildTelegramTopicConversationId,
  normalizeConversationText,
  parseTelegramChatIdFromTarget,
} from "../../../acp/conversation-id.js";
import { DISCORD_THREAD_BINDING_CHANNEL } from "../../../channels/thread-bindings-policy.js";
import { resolveConversationIdFromTargets } from "../../../infra/outbound/conversation-id.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import type { HandleCommandsParams } from "../commands-types.js";
import { parseDiscordParentChannelFromSessionKey } from "../discord-parent-channel.js";
import {
  resolveMatrixConversationId,
  resolveMatrixParentConversationId,
} from "../matrix-context.js";
import { resolveTelegramConversationId } from "../telegram-context.js";

type FeishuGroupSessionScope = "group" | "group_sender" | "group_topic" | "group_topic_sender";

function buildFeishuConversationId(params: {
  chatId: string;
  scope: FeishuGroupSessionScope;
  senderOpenId?: string;
  topicId?: string;
}): string {
  const chatId = normalizeConversationText(params.chatId) ?? "unknown";
  const senderOpenId = normalizeConversationText(params.senderOpenId);
  const topicId = normalizeConversationText(params.topicId);

  switch (params.scope) {
    case "group_sender":
      return senderOpenId ? `${chatId}:sender:${senderOpenId}` : chatId;
    case "group_topic":
      return topicId ? `${chatId}:topic:${topicId}` : chatId;
    case "group_topic_sender":
      if (topicId && senderOpenId) {
        return `${chatId}:topic:${topicId}:sender:${senderOpenId}`;
      }
      if (topicId) {
        return `${chatId}:topic:${topicId}`;
      }
      return senderOpenId ? `${chatId}:sender:${senderOpenId}` : chatId;
    case "group":
    default:
      return chatId;
  }
}

function parseFeishuTargetId(raw: unknown): string | undefined {
  const target = normalizeConversationText(raw);
  if (!target) {
    return undefined;
  }
  const withoutProvider = target.replace(/^(feishu|lark):/i, "").trim();
  if (!withoutProvider) {
    return undefined;
  }
  const lowered = withoutProvider.toLowerCase();
  for (const prefix of ["chat:", "group:", "channel:", "user:", "dm:", "open_id:"]) {
    if (lowered.startsWith(prefix)) {
      return normalizeConversationText(withoutProvider.slice(prefix.length));
    }
  }
  return withoutProvider;
}

function parseFeishuDirectConversationId(raw: unknown): string | undefined {
  const target = normalizeConversationText(raw);
  if (!target) {
    return undefined;
  }
  const withoutProvider = target.replace(/^(feishu|lark):/i, "").trim();
  if (!withoutProvider) {
    return undefined;
  }
  const lowered = withoutProvider.toLowerCase();
  for (const prefix of ["user:", "dm:", "open_id:"]) {
    if (lowered.startsWith(prefix)) {
      return normalizeConversationText(withoutProvider.slice(prefix.length));
    }
  }
  const id = parseFeishuTargetId(target);
  if (!id) {
    return undefined;
  }
  if (id.startsWith("ou_") || id.startsWith("on_")) {
    return id;
  }
  return undefined;
}

function resolveFeishuSenderScopedConversationId(params: {
  accountId: string;
  parentConversationId?: string;
  threadId?: string;
  senderId?: string;
  sessionKey?: string;
  parentSessionKey?: string;
}): string | undefined {
  const parentConversationId = normalizeConversationText(params.parentConversationId);
  const threadId = normalizeConversationText(params.threadId);
  const senderId = normalizeConversationText(params.senderId);
  const expectedScopePrefix = `feishu:group:${parentConversationId?.toLowerCase()}:topic:${threadId?.toLowerCase()}:sender:`;
  const isSenderScopedSession = [params.sessionKey, params.parentSessionKey].some((candidate) => {
    const scopedRest = parseAgentSessionKey(candidate)?.rest?.trim().toLowerCase() ?? "";
    return Boolean(scopedRest && expectedScopePrefix && scopedRest.startsWith(expectedScopePrefix));
  });
  if (!parentConversationId || !threadId || !senderId) {
    return undefined;
  }
  if (!isSenderScopedSession && params.sessionKey?.trim()) {
    const boundConversation = getSessionBindingService()
      .listBySession(params.sessionKey)
      .find((binding) => {
        if (
          binding.conversation.channel !== "feishu" ||
          binding.conversation.accountId !== params.accountId
        ) {
          return false;
        }
        return (
          binding.conversation.conversationId ===
          buildFeishuConversationId({
            chatId: parentConversationId,
            scope: "group_topic_sender",
            topicId: threadId,
            senderOpenId: senderId,
          })
        );
      });
    if (boundConversation) {
      return boundConversation.conversation.conversationId;
    }
    return undefined;
  }
  return buildFeishuConversationId({
    chatId: parentConversationId,
    scope: "group_topic_sender",
    topicId: threadId,
    senderOpenId: senderId,
  });
}

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
  if (channel === "matrix") {
    return resolveMatrixConversationId({
      ctx: {
        MessageThreadId: params.ctx.MessageThreadId,
        OriginatingTo: params.ctx.OriginatingTo,
        To: params.ctx.To,
      },
      command: {
        to: params.command.to,
      },
    });
  }
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
  if (channel === "feishu") {
    const threadId = resolveAcpCommandThreadId(params);
    const parentConversationId = resolveAcpCommandParentConversationId(params);
    if (threadId && parentConversationId) {
      const senderScopedConversationId = resolveFeishuSenderScopedConversationId({
        accountId: resolveAcpCommandAccountId(params),
        parentConversationId,
        threadId,
        senderId: params.command.senderId ?? params.ctx.SenderId,
        sessionKey: params.sessionKey,
        parentSessionKey: params.ctx.ParentSessionKey,
      });
      return (
        senderScopedConversationId ??
        buildFeishuConversationId({
          chatId: parentConversationId,
          scope: "group_topic",
          topicId: threadId,
        })
      );
    }
    return (
      parseFeishuDirectConversationId(params.ctx.OriginatingTo) ??
      parseFeishuDirectConversationId(params.command.to) ??
      parseFeishuDirectConversationId(params.ctx.To)
    );
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
  if (channel === "matrix") {
    return resolveMatrixParentConversationId({
      ctx: {
        MessageThreadId: params.ctx.MessageThreadId,
        OriginatingTo: params.ctx.OriginatingTo,
        To: params.ctx.To,
      },
      command: {
        to: params.command.to,
      },
    });
  }
  if (channel === "telegram") {
    return (
      parseTelegramChatIdFromTarget(params.ctx.OriginatingTo) ??
      parseTelegramChatIdFromTarget(params.command.to) ??
      parseTelegramChatIdFromTarget(params.ctx.To)
    );
  }
  if (channel === "feishu") {
    const threadId = resolveAcpCommandThreadId(params);
    if (!threadId) {
      return undefined;
    }
    return (
      parseFeishuTargetId(params.ctx.OriginatingTo) ??
      parseFeishuTargetId(params.command.to) ??
      parseFeishuTargetId(params.ctx.To)
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
