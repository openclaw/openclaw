import type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import type { PluginConversationBinding } from "./conversation-binding.types.js";

export type PluginHookMessageContext = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
  senderId?: string;
  trace?: DiagnosticTraceContext;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  callDepth?: number;
};

export type PluginHookInboundClaimContext = PluginHookMessageContext & {
  parentConversationId?: string;
  senderId?: string;
  messageId?: string;
  pluginBinding?: PluginConversationBinding;
};

export type PluginHookInboundClaimEvent = {
  content: string;
  body?: string;
  bodyForAgent?: string;
  transcript?: string;
  timestamp?: number;
  channel: string;
  accountId?: string;
  conversationId?: string;
  parentConversationId?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  threadId?: string | number;
  messageId?: string;
  sessionKey?: string;
  runId?: string;
  trace?: DiagnosticTraceContext;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  isGroup: boolean;
  commandAuthorized?: boolean;
  wasMentioned?: boolean;
  metadata?: Record<string, unknown>;
};

export type PluginHookMessageReceivedEvent = {
  from: string;
  content: string;
  timestamp?: number;
  threadId?: string | number;
  messageId?: string;
  senderId?: string;
  sessionKey?: string;
  runId?: string;
  trace?: DiagnosticTraceContext;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  metadata?: Record<string, unknown>;
};

export type PluginHookMessageSendingEvent = {
  to: string;
  content: string;
  replyToId?: string | number;
  threadId?: string | number;
  metadata?: Record<string, unknown>;
};

export type PluginHookMessageSendingResult = {
  content?: string;
  cancel?: boolean;
  cancelReason?: string;
  metadata?: Record<string, unknown>;
};

export type PluginHookMessageSentEvent = {
  to: string;
  content: string;
  success: boolean;
  messageId?: string;
  sessionKey?: string;
  runId?: string;
  trace?: DiagnosticTraceContext;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  error?: string;
};

// ── before_route_inbound_message hook ──────────────────────────────────────

/** Context supplied to the `before_route_inbound_message` handler. */
export type PluginHookBeforeRouteInboundMessageContext = {
  /** Channel the message arrived on (e.g. "discord", "telegram"). */
  channelId: string;
  /** Account identifier for multi-account gateways. */
  accountId?: string;
  /** Provider-native channel/conversation ID from MsgContext metadata. */
  conversationId?: string;
  /** Thread/parent conversation ID (Telegram topic, Discord thread, etc.). */
  parentConversationId?: string;
  /** The session key that was resolved for this message before hook invocation. */
  sessionKey: string;
};

/** Event payload for the `before_route_inbound_message` hook. */
export type PluginHookBeforeRouteInboundMessageEvent = {
  /** Channel the message arrived on (e.g. "discord", "telegram"). */
  channel: string;
  /** Account identifier for multi-account gateways. */
  accountId?: string;
  /** Provider-native channel/conversation ID from MsgContext metadata. */
  conversationId?: string;
  /** Thread/parent conversation ID (Telegram topic, Discord thread, etc.). */
  parentConversationId?: string;
  /** Plain-text body of the inbound message. */
  body: string;
  /** Whether the message originated in a group/supergroup context. */
  isGroup: boolean;
  /** Sender identifier from the inbound message. */
  senderId?: string;
  /** The session key that was resolved before the hook fired. */
  originalSessionKey: string;
};

/** Result returned by a `before_route_inbound_message` handler. */
export type PluginHookBeforeRouteInboundMessageResult = {
  /** Set to `true` when the plugin has made a routing decision. */
  handled: true;
  /** Redirect the message to a different session key. */
  redirectSessionKey?: string;
  /** Suppress delivery entirely — do not route the message to any session. */
  suppressDelivery?: boolean;
};
