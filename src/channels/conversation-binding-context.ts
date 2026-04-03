import { normalizeConversationText } from "../acp/conversation-id.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveConversationIdFromTargets } from "../infra/outbound/conversation-id.js";
import { getActivePluginChannelRegistry } from "../plugins/runtime.js";
import { parseExplicitTargetForChannel } from "./plugins/target-parsing.js";
import type { ChannelPlugin } from "./plugins/types.js";
import { normalizeAnyChannelId, normalizeChannelId } from "./registry.js";

export type ConversationBindingContext = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string;
};

export type ResolveConversationBindingContextInput = {
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
  chatType?: string | null;
  threadId?: string | number | null;
  threadParentId?: string | null;
  senderId?: string | null;
  sessionKey?: string | null;
  parentSessionKey?: string | null;
  originatingTo?: string | null;
  commandTo?: string | null;
  fallbackTo?: string | null;
  from?: string | null;
  nativeChannelId?: string | null;
};

const CANONICAL_TARGET_PREFIXES = [
  "user:",
  "channel:",
  "conversation:",
  "group:",
  "room:",
  "dm:",
  "spaces/",
] as const;

function normalizeText(value: unknown): string | undefined {
  const normalized = normalizeConversationText(value);
  return normalized || undefined;
}

function getLoadedChannelPlugin(rawChannel: string): ChannelPlugin | undefined {
  const normalized = normalizeAnyChannelId(rawChannel) ?? normalizeText(rawChannel);
  if (!normalized) {
    return undefined;
  }
  return getActivePluginChannelRegistry()?.channels.find((entry) => entry.plugin.id === normalized)
    ?.plugin;
}

function resolveChannelTargetId(params: {
  channel: string;
  target?: string | null;
}): string | undefined {
  const target = normalizeText(params.target);
  if (!target) {
    return undefined;
  }

  const lower = target.toLowerCase();
  const channelPrefix = `${params.channel}:`;
  if (lower.startsWith(channelPrefix)) {
    return resolveChannelTargetId({
      channel: params.channel,
      target: target.slice(channelPrefix.length),
    });
  }
  if (CANONICAL_TARGET_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return target;
  }

  const parsed = parseExplicitTargetForChannel(params.channel, target);
  const parsedTarget = normalizeText(parsed?.to);
  if (parsedTarget) {
    return (
      resolveConversationIdFromTargets({
        targets: [parsedTarget],
      }) ?? parsedTarget
    );
  }

  const explicitConversationId = resolveConversationIdFromTargets({
    targets: [target],
  });
  return explicitConversationId ?? target;
}

function buildThreadingContext(params: {
  fallbackTo?: string;
  originatingTo?: string;
  threadId?: string;
  from?: string;
  chatType?: string;
  nativeChannelId?: string;
}) {
  const to = normalizeText(params.originatingTo) ?? normalizeText(params.fallbackTo);
  return {
    ...(to ? { To: to } : {}),
    ...(params.from ? { From: params.from } : {}),
    ...(params.chatType ? { ChatType: params.chatType } : {}),
    ...(params.threadId ? { MessageThreadId: params.threadId } : {}),
    ...(params.nativeChannelId ? { NativeChannelId: params.nativeChannelId } : {}),
  };
}

export function resolveConversationBindingContext(
  params: ResolveConversationBindingContextInput,
): ConversationBindingContext | null {
  const channel =
    normalizeAnyChannelId(params.channel) ??
    normalizeChannelId(params.channel) ??
    normalizeText(params.channel)?.toLowerCase();
  if (!channel) {
    return null;
  }
  const accountId = normalizeText(params.accountId) || "default";
  const threadId = normalizeText(params.threadId != null ? String(params.threadId) : undefined);
  const loadedPlugin = getLoadedChannelPlugin(channel);

  const resolvedByProvider = loadedPlugin?.bindings?.resolveCommandConversation?.({
    accountId,
    threadId,
    threadParentId: normalizeText(params.threadParentId),
    senderId: normalizeText(params.senderId),
    sessionKey: normalizeText(params.sessionKey),
    parentSessionKey: normalizeText(params.parentSessionKey),
    originatingTo: params.originatingTo ?? undefined,
    commandTo: params.commandTo ?? undefined,
    fallbackTo: params.fallbackTo ?? undefined,
  });
  if (resolvedByProvider?.conversationId) {
    const resolvedParentConversationId =
      channel === "telegram" && !threadId && !resolvedByProvider.parentConversationId
        ? resolvedByProvider.conversationId
        : resolvedByProvider.parentConversationId;
    return {
      channel,
      accountId,
      conversationId: resolvedByProvider.conversationId,
      ...(resolvedParentConversationId
        ? { parentConversationId: resolvedParentConversationId }
        : {}),
      ...(threadId ? { threadId } : {}),
    };
  }

  const focusedBinding = loadedPlugin?.threading?.resolveFocusedBinding?.({
    cfg: params.cfg,
    accountId,
    context: buildThreadingContext({
      fallbackTo: params.fallbackTo ?? undefined,
      originatingTo: params.originatingTo ?? undefined,
      threadId,
      from: normalizeText(params.from),
      chatType: normalizeText(params.chatType),
      nativeChannelId: normalizeText(params.nativeChannelId),
    }),
  });
  if (focusedBinding?.conversationId) {
    return {
      channel,
      accountId,
      conversationId: focusedBinding.conversationId,
      ...(focusedBinding.parentConversationId
        ? { parentConversationId: focusedBinding.parentConversationId }
        : {}),
      ...(threadId ? { threadId } : {}),
    };
  }

  const baseConversationId =
    resolveChannelTargetId({
      channel,
      target: params.originatingTo,
    }) ??
    resolveChannelTargetId({
      channel,
      target: params.commandTo,
    }) ??
    resolveChannelTargetId({
      channel,
      target: params.fallbackTo,
    });
  const parentConversationId =
    resolveChannelTargetId({
      channel,
      target: params.threadParentId,
    }) ??
    (threadId && baseConversationId && baseConversationId !== threadId
      ? baseConversationId
      : undefined);
  const conversationId = threadId || baseConversationId;
  if (!conversationId) {
    return null;
  }
  const normalizedParentConversationId =
    channel === "telegram" && !threadId && !parentConversationId
      ? conversationId
      : parentConversationId;
  return {
    channel,
    accountId,
    conversationId,
    ...(normalizedParentConversationId
      ? { parentConversationId: normalizedParentConversationId }
      : {}),
    ...(threadId ? { threadId } : {}),
  };
}
