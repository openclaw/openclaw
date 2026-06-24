/** Builds plugin hook agent context snapshots from active session and model state. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseRawSessionConversationRef } from "../sessions/session-key-utils.js";
import type { PluginHookChannelContext } from "./hook-channel-context.types.js";
import type { PluginHookAgentContext } from "./hook-types.js";

const TARGET_PREFIXES = new Set(["channel", "chat", "direct", "dm", "group", "thread", "user"]);

function normalizeKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function stripConversationPrefix(
  value: string | undefined,
  ...providers: Array<string | undefined>
): string | undefined {
  const text = normalizeOptionalString(value);
  if (!text) {
    return undefined;
  }

  const separatorIndex = text.indexOf(":");
  if (separatorIndex === -1) {
    return text;
  }

  const prefix = normalizeKey(text.slice(0, separatorIndex));
  const suffix = normalizeOptionalString(text.slice(separatorIndex + 1));
  if (!suffix) {
    return text;
  }
  if (
    TARGET_PREFIXES.has(prefix) ||
    providers.some((provider) => prefix === normalizeKey(provider))
  ) {
    return suffix;
  }
  return text;
}

function inferNarrowProviderChannel(params: {
  messageProvider?: string | null;
  currentChannelId?: string | null;
  messageTo?: string | null;
}): string | undefined {
  const providerKey = normalizeKey(normalizeOptionalString(params.messageProvider));
  if (!providerKey) {
    return undefined;
  }
  for (const value of [params.currentChannelId, params.messageTo]) {
    const text = normalizeOptionalString(value);
    const separatorIndex = text?.indexOf(":") ?? -1;
    if (!text || separatorIndex <= 0) {
      continue;
    }
    const prefix = normalizeOptionalString(text.slice(0, separatorIndex));
    const prefixKey = normalizeKey(prefix);
    if (prefix && providerKey.startsWith(`${prefixKey}-`)) {
      return prefix;
    }
  }
  return undefined;
}

function resolveAgentHookChannel(params: {
  messageChannel?: string | null;
  messageProvider?: string | null;
  currentChannelId?: string | null;
  messageTo?: string | null;
}): string | undefined {
  const messageChannel = normalizeOptionalString(params.messageChannel);
  const provider = normalizeOptionalString(params.messageProvider);
  const inferredProviderChannel = inferNarrowProviderChannel(params);
  if (!messageChannel) {
    return inferredProviderChannel ?? provider;
  }

  const separatorIndex = messageChannel.indexOf(":");
  if (separatorIndex === -1) {
    if (inferredProviderChannel && normalizeKey(messageChannel) === normalizeKey(provider)) {
      return inferredProviderChannel;
    }
    return messageChannel;
  }

  const prefix = normalizeOptionalString(messageChannel.slice(0, separatorIndex));
  if (!prefix) {
    return provider;
  }
  if (
    TARGET_PREFIXES.has(normalizeKey(prefix)) ||
    normalizeKey(prefix) === normalizeKey(provider)
  ) {
    return inferredProviderChannel ?? provider;
  }
  return prefix;
}

/** Resolves the channel id exposed to plugin agent hooks. */
export function resolveAgentHookChannelId(params: {
  sessionKey?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  currentChannelId?: string | null;
  messageTo?: string | null;
}): string | undefined {
  const provider = normalizeOptionalString(params.messageProvider);
  const messageChannel = normalizeOptionalString(params.messageChannel);
  const channel = resolveAgentHookChannel(params);
  const parsed = parseRawSessionConversationRef(params.sessionKey);
  if (parsed?.rawId) {
    return parsed.rawId;
  }

  const metadataChannel =
    stripConversationPrefix(
      params.currentChannelId ?? undefined,
      provider,
      messageChannel,
      channel,
    ) ?? stripConversationPrefix(params.messageTo ?? undefined, provider, messageChannel, channel);
  if (metadataChannel && normalizeKey(metadataChannel) !== normalizeKey(provider)) {
    return metadataChannel;
  }

  const strippedMessageChannel = stripConversationPrefix(
    params.messageChannel ?? undefined,
    provider,
    messageChannel,
  );
  if (strippedMessageChannel && normalizeKey(strippedMessageChannel) !== normalizeKey(provider)) {
    return strippedMessageChannel;
  }
  return messageChannel ?? provider;
}

/** Builds channel/provider fields for plugin agent hook context. */
export function buildAgentHookContextChannelFields(params: {
  sessionKey?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  currentChannelId?: string | null;
  messageTo?: string | null;
  senderId?: string | null;
}): Pick<
  PluginHookAgentContext,
  "channel" | "channelId" | "chatId" | "messageProvider" | "senderId"
> {
  const channel = resolveAgentHookChannel(params);
  const channelId = resolveAgentHookChannelId(params);
  return {
    channel,
    messageProvider: normalizeOptionalString(params.messageProvider),
    channelId,
    chatId: channelId,
    senderId: normalizeOptionalString(params.senderId),
  };
}

export function buildAgentHookContextIdentityFields(params: {
  trigger?: string | null;
  senderId?: string | null;
  chatId?: string | null;
  channelContext?: PluginHookChannelContext;
}): Pick<PluginHookAgentContext, "senderId" | "chatId" | "channelContext"> {
  const trigger = normalizeOptionalString(params.trigger);
  if (trigger && trigger !== "user") {
    return {};
  }

  const senderId = normalizeOptionalString(params.senderId);
  const chatId = normalizeOptionalString(params.chatId);
  const sender = senderId
    ? { ...params.channelContext?.sender, id: senderId }
    : params.channelContext?.sender;
  const chat = chatId
    ? { ...params.channelContext?.chat, id: chatId }
    : params.channelContext?.chat;
  const channelContext =
    sender || chat || params.channelContext
      ? {
          ...params.channelContext,
          ...(sender ? { sender } : {}),
          ...(chat ? { chat } : {}),
        }
      : undefined;

  return {
    ...(senderId ? { senderId } : {}),
    ...(chatId ? { chatId } : {}),
    ...(channelContext ? { channelContext } : {}),
  };
}

/** Builds canonical channel and requester fields shared by agent and tool hooks. */
export function buildAgentHookContextOriginFields(params: {
  sessionKey?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  currentChannelId?: string | null;
  messageTo?: string | null;
  trigger?: string | null;
  senderId?: string | null;
  chatId?: string | null;
  channelContext?: PluginHookChannelContext;
}): Pick<
  PluginHookAgentContext,
  "channel" | "messageProvider" | "channelId" | "chatId" | "senderId" | "channelContext"
> {
  const channelFields = buildAgentHookContextChannelFields({
    sessionKey: params.sessionKey,
    messageChannel: params.messageChannel,
    messageProvider: params.messageProvider,
    currentChannelId: params.currentChannelId,
    messageTo: params.messageTo,
  });
  return {
    ...(channelFields.channel ? { channel: channelFields.channel } : {}),
    ...(channelFields.messageProvider ? { messageProvider: channelFields.messageProvider } : {}),
    ...(channelFields.channelId ? { channelId: channelFields.channelId } : {}),
    ...buildAgentHookContextIdentityFields({
      trigger: params.trigger,
      senderId: params.senderId ?? params.channelContext?.sender?.id,
      chatId: params.chatId ?? params.channelContext?.chat?.id,
      channelContext: params.channelContext,
    }),
  };
}
