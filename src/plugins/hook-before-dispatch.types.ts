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
  /**
   * Originating authenticated Control UI connection. Correlation only; not
   * authority or a delivery capability.
   */
  connId?: string;
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
