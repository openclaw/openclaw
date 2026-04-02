import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
  PluginHookMessageContext,
  PluginHookMessageReceivedEvent,
  PluginHookMessageSentEvent,
} from "../plugins/types.js";
import type {
  MessagePreprocessedHookContext,
  MessageReceivedHookContext,
  MessageSentHookContext,
  MessageTranscribedHookContext,
} from "./internal-hooks.js";

export type CanonicalInboundMessageHookContext = {
  from: string;
  to?: string;
  content: string;
  body?: string;
  bodyForAgent?: string;
  transcript?: string;
  timestamp?: number;
  channelId: string;
  accountId?: string;
  conversationId?: string;
  messageId?: string;
  senderId?: string;
  senderAgentId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  provider?: string;
  surface?: string;
  threadId?: string | number;
  mediaPath?: string;
  mediaType?: string;
  mediaPaths?: string[];
  mediaTypes?: string[];
  originatingChannel?: string;
  originatingTo?: string;
  guildId?: string;
  channelName?: string;
  isGroup: boolean;
  groupId?: string;
};

export type CanonicalSentMessageHookContext = {
  to: string;
  content: string;
  success: boolean;
  error?: string;
  channelId: string;
  accountId?: string;
  conversationId?: string;
  messageId?: string;
  isGroup?: boolean;
  groupId?: string;
};

export function deriveInboundMessageHookContext(
  ctx: FinalizedMsgContext,
  overrides?: {
    content?: string;
    messageId?: string;
  },
): CanonicalInboundMessageHookContext {
  const content =
    overrides?.content ??
    (typeof ctx.BodyForCommands === "string"
      ? ctx.BodyForCommands
      : typeof ctx.RawBody === "string"
        ? ctx.RawBody
        : typeof ctx.Body === "string"
          ? ctx.Body
          : "");
  const channelId = (ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "").toLowerCase();
  const conversationId = ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? undefined;
  const isGroup = Boolean(ctx.GroupSubject || ctx.GroupChannel);
  const mediaPaths = Array.isArray(ctx.MediaPaths)
    ? ctx.MediaPaths.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : undefined;
  const mediaTypes = Array.isArray(ctx.MediaTypes)
    ? ctx.MediaTypes.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : undefined;
  return {
    from: ctx.From ?? "",
    to: ctx.To,
    content,
    body: ctx.Body,
    bodyForAgent: ctx.BodyForAgent,
    transcript: ctx.Transcript,
    timestamp:
      typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp)
        ? ctx.Timestamp
        : undefined,
    channelId,
    accountId: ctx.AccountId,
    conversationId,
    messageId:
      overrides?.messageId ??
      ctx.MessageSidFull ??
      ctx.MessageSid ??
      ctx.MessageSidFirst ??
      ctx.MessageSidLast,
    senderId: ctx.SenderId,
    senderAgentId: ctx.SenderAgentId,
    senderName: ctx.SenderName,
    senderUsername: ctx.SenderUsername,
    senderE164: ctx.SenderE164,
    provider: ctx.Provider,
    surface: ctx.Surface,
    threadId: ctx.MessageThreadId,
    mediaPath: ctx.MediaPath ?? mediaPaths?.[0],
    mediaType: ctx.MediaType ?? mediaTypes?.[0],
    mediaPaths,
    mediaTypes,
    originatingChannel: ctx.OriginatingChannel,
    originatingTo: ctx.OriginatingTo,
    guildId: ctx.GroupSpace,
    channelName: ctx.GroupChannel,
    isGroup,
    groupId: isGroup ? conversationId : undefined,
  };
}

export function buildCanonicalSentMessageHookContext(params: {
  to: string;
  content: string;
  success: boolean;
  error?: string;
  channelId: string;
  accountId?: string;
  conversationId?: string;
  messageId?: string;
  isGroup?: boolean;
  groupId?: string;
}): CanonicalSentMessageHookContext {
  return {
    to: params.to,
    content: params.content,
    success: params.success,
    error: params.error,
    channelId: params.channelId,
    accountId: params.accountId,
    conversationId: params.conversationId ?? params.to,
    messageId: params.messageId,
    isGroup: params.isGroup,
    groupId: params.groupId,
  };
}

export function toPluginMessageContext(
  canonical: CanonicalInboundMessageHookContext | CanonicalSentMessageHookContext,
): PluginHookMessageContext {
  return {
    channelId: canonical.channelId,
    accountId: canonical.accountId,
    conversationId: canonical.conversationId,
  };
}

function stripChannelPrefix(value: string | undefined, channelId: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const genericPrefixes = ["channel:", "chat:", "user:"];
  for (const prefix of genericPrefixes) {
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }
  const prefix = `${channelId}:`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function deriveParentConversationId(
  canonical: CanonicalInboundMessageHookContext,
): string | undefined {
  if (canonical.channelId !== "telegram") {
    return undefined;
  }
  if (typeof canonical.threadId !== "number" && typeof canonical.threadId !== "string") {
    return undefined;
  }
  return stripChannelPrefix(
    canonical.to ?? canonical.originatingTo ?? canonical.conversationId,
    "telegram",
  );
}

function deriveConversationId(canonical: CanonicalInboundMessageHookContext): string | undefined {
  if (canonical.channelId === "discord") {
    const rawTarget = canonical.to ?? canonical.originatingTo ?? canonical.conversationId;
    const rawSender = canonical.from;
    const senderUserId = rawSender?.startsWith("discord:user:")
      ? rawSender.slice("discord:user:".length)
      : rawSender?.startsWith("discord:")
        ? rawSender.slice("discord:".length)
        : undefined;
    if (!canonical.isGroup && senderUserId) {
      return `user:${senderUserId}`;
    }
    if (!rawTarget) {
      return undefined;
    }
    if (rawTarget.startsWith("discord:channel:")) {
      return `channel:${rawTarget.slice("discord:channel:".length)}`;
    }
    if (rawTarget.startsWith("discord:user:")) {
      return `user:${rawTarget.slice("discord:user:".length)}`;
    }
    if (rawTarget.startsWith("discord:")) {
      return `user:${rawTarget.slice("discord:".length)}`;
    }
    if (rawTarget.startsWith("channel:") || rawTarget.startsWith("user:")) {
      return rawTarget;
    }
  }
  const baseConversationId = stripChannelPrefix(
    canonical.to ?? canonical.originatingTo ?? canonical.conversationId,
    canonical.channelId,
  );
  if (canonical.channelId === "telegram" && baseConversationId) {
    const threadId =
      typeof canonical.threadId === "number" || typeof canonical.threadId === "string"
        ? String(canonical.threadId).trim()
        : "";
    if (threadId) {
      return `${baseConversationId}:topic:${threadId}`;
    }
  }
  return baseConversationId;
}

export function toPluginInboundClaimContext(
  canonical: CanonicalInboundMessageHookContext,
): PluginHookInboundClaimContext {
  const conversationId = deriveConversationId(canonical);
  return {
    channelId: canonical.channelId,
    accountId: canonical.accountId,
    conversationId,
    parentConversationId: deriveParentConversationId(canonical),
    senderId: canonical.senderId,
    messageId: canonical.messageId,
  };
}

export function toPluginInboundClaimEvent(
  canonical: CanonicalInboundMessageHookContext,
  extras?: {
    commandAuthorized?: boolean;
    wasMentioned?: boolean;
  },
): PluginHookInboundClaimEvent {
  const context = toPluginInboundClaimContext(canonical);
  return {
    content: canonical.content,
    body: canonical.body,
    bodyForAgent: canonical.bodyForAgent,
    transcript: canonical.transcript,
    timestamp: canonical.timestamp,
    channel: canonical.channelId,
    accountId: canonical.accountId,
    conversationId: context.conversationId,
    parentConversationId: context.parentConversationId,
    senderId: canonical.senderId,
    senderName: canonical.senderName,
    senderUsername: canonical.senderUsername,
    threadId: canonical.threadId,
    messageId: canonical.messageId,
    isGroup: canonical.isGroup,
    commandAuthorized: extras?.commandAuthorized,
    wasMentioned: extras?.wasMentioned,
    metadata: {
      from: canonical.from,
      to: canonical.to,
      provider: canonical.provider,
      surface: canonical.surface,
      originatingChannel: canonical.originatingChannel,
      originatingTo: canonical.originatingTo,
      senderE164: canonical.senderE164,
      mediaPath: canonical.mediaPath,
      mediaType: canonical.mediaType,
      mediaPaths: canonical.mediaPaths,
      mediaTypes: canonical.mediaTypes,
      guildId: canonical.guildId,
      channelName: canonical.channelName,
      groupId: canonical.groupId,
    },
  };
}

export function toPluginMessageReceivedEvent(
  canonical: CanonicalInboundMessageHookContext,
): PluginHookMessageReceivedEvent {
  return {
    from: canonical.from,
    content: canonical.content,
    timestamp: canonical.timestamp,
    metadata: {
      to: canonical.to,
      provider: canonical.provider,
      surface: canonical.surface,
      threadId: canonical.threadId,
      originatingChannel: canonical.originatingChannel,
      originatingTo: canonical.originatingTo,
      messageId: canonical.messageId,
      senderId: canonical.senderId,
      senderAgentId: canonical.senderAgentId,
      senderName: canonical.senderName,
      senderUsername: canonical.senderUsername,
      senderE164: canonical.senderE164,
      guildId: canonical.guildId,
      channelName: canonical.channelName,
    },
  };
}

export function toPluginMessageSentEvent(
  canonical: CanonicalSentMessageHookContext,
): PluginHookMessageSentEvent {
  return {
    to: canonical.to,
    content: canonical.content,
    success: canonical.success,
    ...(canonical.error ? { error: canonical.error } : {}),
  };
}

export function toInternalMessageReceivedContext(
  canonical: CanonicalInboundMessageHookContext,
): MessageReceivedHookContext {
  return {
    from: canonical.from,
    content: canonical.content,
    timestamp: canonical.timestamp,
    channelId: canonical.channelId,
    accountId: canonical.accountId,
    conversationId: canonical.conversationId,
    messageId: canonical.messageId,
    metadata: {
      to: canonical.to,
      provider: canonical.provider,
      surface: canonical.surface,
      threadId: canonical.threadId,
      senderId: canonical.senderId,
      senderAgentId: canonical.senderAgentId,
      senderName: canonical.senderName,
      senderUsername: canonical.senderUsername,
      senderE164: canonical.senderE164,
      guildId: canonical.guildId,
      channelName: canonical.channelName,
    },
  };
}

export function toInternalMessageTranscribedContext(
  canonical: CanonicalInboundMessageHookContext,
  cfg: OpenClawConfig,
): MessageTranscribedHookContext & { cfg: OpenClawConfig } {
  const shared = toInternalInboundMessageHookContextBase(canonical);
  return {
    ...shared,
    transcript: canonical.transcript ?? "",
    cfg,
  };
}

export function toInternalMessagePreprocessedContext(
  canonical: CanonicalInboundMessageHookContext,
  cfg: OpenClawConfig,
): MessagePreprocessedHookContext & { cfg: OpenClawConfig } {
  const shared = toInternalInboundMessageHookContextBase(canonical);
  return {
    ...shared,
    transcript: canonical.transcript,
    isGroup: canonical.isGroup,
    groupId: canonical.groupId,
    cfg,
  };
}

function toInternalInboundMessageHookContextBase(canonical: CanonicalInboundMessageHookContext) {
  return {
    from: canonical.from,
    to: canonical.to,
    body: canonical.body,
    bodyForAgent: canonical.bodyForAgent,
    timestamp: canonical.timestamp,
    channelId: canonical.channelId,
    conversationId: canonical.conversationId,
    messageId: canonical.messageId,
    senderId: canonical.senderId,
    senderName: canonical.senderName,
    senderUsername: canonical.senderUsername,
    provider: canonical.provider,
    surface: canonical.surface,
    mediaPath: canonical.mediaPath,
    mediaType: canonical.mediaType,
  };
}

export function toInternalMessageSentContext(
  canonical: CanonicalSentMessageHookContext,
): MessageSentHookContext {
  return {
    to: canonical.to,
    content: canonical.content,
    success: canonical.success,
    ...(canonical.error ? { error: canonical.error } : {}),
    channelId: canonical.channelId,
    accountId: canonical.accountId,
    conversationId: canonical.conversationId,
    messageId: canonical.messageId,
    ...(canonical.isGroup != null ? { isGroup: canonical.isGroup } : {}),
    ...(canonical.groupId ? { groupId: canonical.groupId } : {}),
  };
}
