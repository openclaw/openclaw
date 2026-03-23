import {
  buildTelegramTopicConversationId,
  normalizeConversationText,
} from "../../acp/conversation-id.js";
import type { ChatType } from "../../channels/chat-type.js";
import {
  parseExplicitTargetForChannel,
  type ParsedChannelExplicitTarget,
} from "../../channels/plugins/target-parsing.js";
import { DISCORD_THREAD_BINDING_CHANNEL } from "../../channels/thread-bindings-policy.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveConversationIdFromTargets } from "./conversation-id.js";
import { getSessionBindingService } from "./session-binding-service.js";

type FeishuGroupSessionScope = "group" | "group_sender" | "group_topic" | "group_topic_sender";

export type CanonicalConversationContext = {
  conversationId?: string;
  parentConversationId?: string;
  currentBindingEligible: boolean;
  chatType?: ChatType;
};

export type CanonicalConversationInput = {
  channel: string;
  accountId?: string;
  threadId?: string | number | null;
  targets: Array<string | undefined | null>;
  senderId?: string;
  sessionKey?: string;
  parentSessionKey?: string;
  threadParentId?: string;
};

function normalizeText(value: unknown): string | undefined {
  const normalized = normalizeConversationText(value);
  return normalized || undefined;
}

function normalizeChannel(raw: string): string {
  return raw.trim().toLowerCase();
}

function normalizeThreadId(raw: string | number | null | undefined): string | undefined {
  if (raw == null) {
    return undefined;
  }
  const normalized = normalizeText(String(raw));
  return normalized || undefined;
}

function findFirstParsedTarget(
  channel: string,
  targets: Array<string | undefined | null>,
): ParsedChannelExplicitTarget | null {
  for (const rawTarget of targets) {
    const target = normalizeText(rawTarget);
    if (!target) {
      continue;
    }
    const parsed = parseExplicitTargetForChannel(channel, target);
    if (parsed?.to) {
      return parsed;
    }
  }
  return null;
}

function buildFeishuConversationId(params: {
  chatId: string;
  scope: FeishuGroupSessionScope;
  senderOpenId?: string;
  topicId?: string;
}): string {
  const chatId = normalizeText(params.chatId) ?? "unknown";
  const senderOpenId = normalizeText(params.senderOpenId);
  const topicId = normalizeText(params.topicId);

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
  const target = normalizeText(raw);
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
      return normalizeText(withoutProvider.slice(prefix.length));
    }
  }
  return withoutProvider;
}

function parseFeishuDirectConversationId(raw: unknown): string | undefined {
  const target = normalizeText(raw);
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
      return normalizeText(withoutProvider.slice(prefix.length));
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
  const parentConversationId = normalizeText(params.parentConversationId);
  const threadId = normalizeText(params.threadId);
  const senderId = normalizeText(params.senderId);
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

function parseDiscordParentChannelFromSessionKey(raw: unknown): string | undefined {
  const sessionKey = normalizeText(raw);
  if (!sessionKey) {
    return undefined;
  }
  const scoped = parseAgentSessionKey(sessionKey)?.rest ?? sessionKey.toLowerCase();
  const match = scoped.match(/(?:^|:)channel:([^:]+)$/);
  return match?.[1] ? match[1] : undefined;
}

function resolveDiscordParentConversationId(params: {
  threadId?: string;
  threadParentId?: string;
  targets: Array<string | undefined | null>;
  parentSessionKey?: string;
}): string | undefined {
  const threadId = normalizeText(params.threadId);
  if (!threadId) {
    return undefined;
  }
  const fromContext = normalizeText(params.threadParentId);
  if (fromContext && fromContext !== threadId) {
    return fromContext;
  }
  const fromParentSession = parseDiscordParentChannelFromSessionKey(params.parentSessionKey);
  if (fromParentSession && fromParentSession !== threadId) {
    return fromParentSession;
  }
  const fromTargets = resolveConversationIdFromTargets({
    targets: params.targets,
  });
  if (fromTargets && fromTargets !== threadId) {
    return fromTargets;
  }
  return undefined;
}

function buildDiscordDirectConversationId(raw: unknown): string | undefined {
  const id = normalizeText(raw);
  if (!id) {
    return undefined;
  }
  return /^user:/i.test(id) ? id : `user:${id}`;
}

function resolveTelegramConversation(
  params: CanonicalConversationInput,
): CanonicalConversationContext {
  const parsed = findFirstParsedTarget("telegram", params.targets);
  const chatId = normalizeText(parsed?.to);
  const threadId = normalizeThreadId(params.threadId);
  if (!chatId) {
    return {
      conversationId: undefined,
      parentConversationId: undefined,
      currentBindingEligible: false,
      chatType: parsed?.chatType,
    };
  }
  if (threadId) {
    return {
      conversationId:
        buildTelegramTopicConversationId({
          chatId,
          topicId: threadId,
        }) ?? undefined,
      parentConversationId: chatId,
      currentBindingEligible: true,
      chatType: parsed?.chatType,
    };
  }
  return {
    conversationId: chatId,
    parentConversationId: chatId,
    // Only Telegram DMs are safe to bind in place without an explicit topic.
    // Plain group chats should fail closed so ACP does not implicitly take over
    // the entire chat when forum mode/topics are not in play.
    currentBindingEligible: parsed?.chatType === "direct",
    chatType: parsed?.chatType,
  };
}

function resolveFeishuConversation(
  params: CanonicalConversationInput,
): CanonicalConversationContext {
  const threadId = normalizeThreadId(params.threadId);
  const parentConversationId = threadId
    ? params.targets.map((target) => parseFeishuTargetId(target)).find(Boolean)
    : undefined;
  if (threadId && parentConversationId) {
    const senderScopedConversationId = resolveFeishuSenderScopedConversationId({
      accountId: params.accountId?.trim() || "default",
      parentConversationId,
      threadId,
      senderId: params.senderId,
      sessionKey: params.sessionKey,
      parentSessionKey: params.parentSessionKey,
    });
    return {
      conversationId:
        senderScopedConversationId ??
        buildFeishuConversationId({
          chatId: parentConversationId,
          scope: "group_topic",
          topicId: threadId,
        }),
      parentConversationId,
      currentBindingEligible: true,
      chatType: "channel",
    };
  }

  const directConversationId = params.targets
    .map((target) => parseFeishuDirectConversationId(target))
    .find(Boolean);
  if (directConversationId) {
    return {
      conversationId: directConversationId,
      currentBindingEligible: true,
      chatType: "direct",
    };
  }

  const groupConversationId = params.targets
    .map((target) => parseFeishuTargetId(target))
    .find(Boolean);
  if (groupConversationId) {
    return {
      conversationId: groupConversationId,
      currentBindingEligible: false,
      chatType: "channel",
    };
  }

  return {
    currentBindingEligible: false,
  };
}

function resolveDiscordConversation(
  params: CanonicalConversationInput,
): CanonicalConversationContext {
  const threadId = normalizeThreadId(params.threadId);
  const parsed = findFirstParsedTarget(DISCORD_THREAD_BINDING_CHANNEL, params.targets);
  const directConversationId =
    parsed?.chatType === "direct" ? buildDiscordDirectConversationId(parsed.to) : undefined;
  if (threadId) {
    return {
      conversationId: threadId,
      parentConversationId: resolveDiscordParentConversationId({
        threadId,
        threadParentId: params.threadParentId,
        targets: params.targets,
        parentSessionKey: params.parentSessionKey,
      }),
      currentBindingEligible: true,
      chatType: parsed?.chatType,
    };
  }
  return {
    conversationId:
      directConversationId ??
      normalizeText(parsed?.to) ??
      resolveConversationIdFromTargets({ targets: params.targets }),
    currentBindingEligible: parsed?.chatType === "direct",
    chatType: parsed?.chatType,
  };
}

function resolveGenericConversation(
  params: CanonicalConversationInput,
): CanonicalConversationContext {
  const parsed = findFirstParsedTarget(params.channel, params.targets);
  const threadId = normalizeThreadId(params.threadId);
  const conversationId =
    normalizeText(parsed?.to) ??
    resolveConversationIdFromTargets({
      threadId,
      targets: params.targets,
    });
  const parentConversationId =
    threadId && parsed?.to && normalizeText(parsed.to) !== conversationId
      ? normalizeText(parsed.to)
      : undefined;
  return {
    conversationId,
    parentConversationId,
    currentBindingEligible: Boolean(threadId || parsed?.chatType === "direct"),
    chatType: parsed?.chatType,
  };
}

export function canonicalizeConversationContext(
  params: CanonicalConversationInput,
): CanonicalConversationContext {
  const channel = normalizeChannel(params.channel);
  if (channel === "telegram") {
    return resolveTelegramConversation(params);
  }
  if (channel === "feishu") {
    return resolveFeishuConversation(params);
  }
  if (channel === DISCORD_THREAD_BINDING_CHANNEL) {
    return resolveDiscordConversation(params);
  }
  return resolveGenericConversation(params);
}
