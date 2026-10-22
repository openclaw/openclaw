/**
 * Event-owned provider facts before attachment loading; never requester authority.
 * Telegram prepares ordinary noncommand singletons after its native sender/group/topic
 * gate and fresh-message dedupe, excluding commands, native-command config grants,
 * and album members. Final route-bound ingress authority remains with the later
 * native context builder.
 */
export type PluginHookBeforeChannelIngressEvent = {
  /** Channel-specific primitive DTO; never the transport's native journal/update object. */
  readonly providerUpdate: Readonly<Record<string, unknown>>;
};

export type PluginHookBeforeChannelIngressContext = {
  readonly channelId: string;
  readonly accountId: string;
  readonly abortSignal: AbortSignal;
  /** Report actual pre-adoption preparation liveness; expires with this handler. */
  readonly heartbeat: () => void;
  readonly heartbeatIntervalMs?: number;
};

export type PluginHookBeforeChannelIngressResult = {
  /** Prepared inbound text, not an outbound reply or adoption receipt. */
  text: string;
  /** Skip native attachment loading when the text already replaces those attachments. */
  suppressAttachments?: boolean;
};

export type PluginHookBeforeDispatchEvent = {
  messageId?: string;
  content: string;
  body?: string;
  channel?: string;
  sessionKey?: string;
  senderId?: string;
  replyToId?: string;
  replyToIdFull?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToIsQuote?: boolean;
  isGroup?: boolean;
  timestamp?: number;
};

export type PluginHookBeforeDispatchContext = {
  messageId?: string;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  senderId?: string;
  replyToId?: string;
  replyToIdFull?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToIsQuote?: boolean;
};

export type PluginHookBeforeDispatchResult = {
  handled: boolean;
  text?: string;
};
