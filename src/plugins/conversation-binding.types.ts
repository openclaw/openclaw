import type { ReplyPayload } from "../auto-reply/reply-payload.js";

/**
 * Plugin-supplied metadata for a request to bind the current conversation.
 */
export type PluginConversationBindingRequestParams = {
  summary?: string;
  detachHint?: string;
  data?: Record<string, unknown>;
};

/**
 * Decisions accepted by the interactive approval flow.
 */
export type PluginConversationBindingResolutionDecision = "allow-once" | "allow-always" | "deny";

/**
 * Host-owned record describing a plugin's current claim on a conversation.
 */
export type PluginConversationBinding = {
  bindingId: string;
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string | number;
  boundAt: number;
  summary?: string;
  detachHint?: string;
  data?: Record<string, unknown>;
};

/**
 * Result returned to plugin command and interactive handlers when they request a binding.
 */
export type PluginConversationBindingRequestResult =
  | {
      status: "bound";
      binding: PluginConversationBinding;
    }
  | {
      status: "pending";
      approvalId: string;
      reply: ReplyPayload;
    }
  | {
      status: "error";
      message: string;
    };

/**
 * Event delivered back to a plugin after a pending binding request is resolved.
 */
export type PluginConversationBindingResolvedEvent = {
  status: "approved" | "denied";
  binding?: PluginConversationBinding;
  decision: PluginConversationBindingResolutionDecision;
  request: {
    summary?: string;
    detachHint?: string;
    data?: Record<string, unknown>;
    requestedBySenderId?: string;
    conversation: {
      channel: string;
      accountId: string;
      conversationId: string;
      parentConversationId?: string;
      threadId?: string | number;
    };
  };
};
