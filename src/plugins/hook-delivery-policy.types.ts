import type { SourceReplyDeliveryMode } from "../auto-reply/get-reply-options.types.js";
import type { ReplyDispatchKind } from "../auto-reply/reply/reply-dispatcher.types.js";
import type { PluginHookMessageContext } from "./hook-message.types.js";
import type { PluginHookReplyPayload } from "./hook-reply-payload.types.js";

export type PluginHookSourcePolicyEvent = {
  content: string;
  body?: string;
  channel: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  runId?: string;
  senderId?: string;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  isGroup: boolean;
  chatType?: string;
  inboundEventKind?: string;
  requestedSourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  configuredVisibleReplies?: "automatic" | "message_tool";
  defaultVisibleReplies?: "automatic" | "message_tool";
  sendPolicy: "allow" | "deny";
};

export type PluginHookSourcePolicyContext = PluginHookMessageContext;

export type PluginHookCurrentInboundPromptContext = {
  text: string;
  resumableText?: string;
  promptJoiner?: "\n\n" | "\n" | " ";
};

export type PluginHookSourcePolicyResult = {
  /** Force source replies through the message tool; this cannot loosen policy. */
  sourceReplyDeliveryMode?: "message_tool_only";
  /** Replaces the current inbound body submitted to the model for this turn. */
  promptBody?: string;
  /** Replaces or clears runtime current-inbound context prepended to the model prompt. */
  currentInboundContext?: PluginHookCurrentInboundPromptContext | null;
  reason?: string;
};

export type PluginHookOutboundDeliveryPolicyPath =
  | "durable_delivery"
  | "message_action"
  | "internal_source";

export type PluginHookOutboundDeliveryPolicySource = {
  channel?: string;
  conversationId?: string;
  accountId?: string;
  sessionKey?: string;
  senderId?: string;
  threadId?: string | number;
  inboundEventKind?: string;
};

export type PluginHookOutboundDeliveryPolicyDestination = {
  channel: string;
  to: string;
  conversationId: string;
  accountId?: string;
  threadId?: string | number;
  path: PluginHookOutboundDeliveryPolicyPath;
};

export type PluginHookOutboundDeliveryPolicyEvent = {
  payload: PluginHookReplyPayload;
  kind: ReplyDispatchKind | "message_action";
  action?: string;
  source?: PluginHookOutboundDeliveryPolicySource;
  destination: PluginHookOutboundDeliveryPolicyDestination;
  sessionKey?: string;
  runId?: string;
};

export type PluginHookOutboundDeliveryPolicyResult =
  | {
      decision?: "allow";
      payload?: PluginHookReplyPayload;
      reason?: string;
    }
  | {
      decision: "cancel";
      payload?: PluginHookReplyPayload;
      reason?: string;
    }
  | {
      decision: "reroute";
      destination: Omit<PluginHookOutboundDeliveryPolicyDestination, "conversationId" | "path">;
      payload?: PluginHookReplyPayload;
      reason?: string;
    };
