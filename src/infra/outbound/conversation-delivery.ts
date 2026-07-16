/** Shared external-conversation delivery and transcript correlation helpers. */
import { resolveMessageReceiptPrimaryId } from "../../channels/message/receipt.js";
import type { ConversationRecord } from "../../config/sessions/conversation-registry.js";
import {
  appendAssistantMessageToSessionTranscript,
  type SessionTranscriptAssistantMessage,
  type SessionTranscriptDeliveryMirror,
} from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runMessageAction, type MessageActionRunResult } from "./message-action-runner.js";

type AppendAssistantMessageParams = Parameters<typeof appendAssistantMessageToSessionTranscript>[0];

export type ConversationDeliveryDeps = {
  appendAssistantMessage: typeof appendAssistantMessageToSessionTranscript;
  beforeMessageWrite: NonNullable<AppendAssistantMessageParams["beforeMessageWrite"]>;
  runMessageAction: typeof runMessageAction;
};

export type ConversationDeliveryContext = {
  agentId: string;
  sourceSessionId?: string;
  sourceSessionKey?: string;
  config: OpenClawConfig;
  senderIsOwner?: boolean;
};

function buildConversationDeliveryMirror(params: {
  context: ConversationDeliveryContext;
  conversation: ConversationRecord;
  messageId?: string;
  status: "delivered" | "pending";
}): Extract<SessionTranscriptDeliveryMirror, { kind: "conversation-send" }> {
  const replayInBackingSession = params.context.sourceSessionId !== params.conversation.sessionId;
  return {
    kind: "conversation-send",
    status: params.status,
    channel: params.conversation.channel,
    conversationRef: params.conversation.conversationRef,
    ...(params.messageId ? { messageId: params.messageId } : {}),
    ...(replayInBackingSession ? { replay: "backing-session" } : {}),
    ...(params.conversation.threadId ? { threadId: params.conversation.threadId } : {}),
  };
}

function readMessageIdFromActionResult(result: MessageActionRunResult): string | undefined {
  if (result.kind !== "send") {
    return undefined;
  }
  const sendResult = result.sendResult?.result;
  if (sendResult && "receipt" in sendResult && sendResult.receipt) {
    const receiptId = resolveMessageReceiptPrimaryId(sendResult.receipt);
    if (receiptId) {
      return receiptId;
    }
  }
  if (sendResult && "messageId" in sendResult && typeof sendResult.messageId === "string") {
    return sendResult.messageId.trim() || undefined;
  }
  const payload = result.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const messageId = (payload as { messageId?: unknown }).messageId;
    return typeof messageId === "string" && messageId.trim() ? messageId.trim() : undefined;
  }
  return undefined;
}

export async function sendConversationMessage(params: {
  deps: ConversationDeliveryDeps;
  context: ConversationDeliveryContext;
  conversation: ConversationRecord;
  message: string;
  turnId: string;
  preparedMessageId?: string;
  gatewayOwnedDelivery?: boolean;
  signal?: AbortSignal;
}): Promise<{ deliveredMessage?: string; messageId?: string }> {
  const idempotencyKey = `conversation-outbound:${params.turnId}`;
  const pendingMirror = buildConversationDeliveryMirror({
    context: params.context,
    conversation: params.conversation,
    status: "pending",
    ...(params.preparedMessageId ? { messageId: params.preparedMessageId } : {}),
  });
  // Persist recipient-visible intent first. A fast reply can now append after
  // this stable row even when transport I/O outpaces the sender's promise.
  const pending = await params.deps.appendAssistantMessage({
    agentId: params.context.agentId,
    sessionKey: params.conversation.sessionKey,
    expectedSessionId: params.conversation.sessionId,
    idempotencyKey,
    config: params.context.config,
    text: params.message,
    deliveryMirror: pendingMirror,
    beforeMessageWrite: (hookParams) => {
      const nextMessage = params.deps.beforeMessageWrite(hookParams);
      if (!nextMessage) {
        return null;
      }
      return {
        ...nextMessage,
        openclawDeliveryMirror: pendingMirror,
      } as SessionTranscriptAssistantMessage;
    },
  });
  if (!pending.ok) {
    throw new Error(`Conversation delivery intent was not persisted: ${pending.reason}`);
  }
  const deliveredMirror = buildConversationDeliveryMirror({
    context: params.context,
    conversation: params.conversation,
    status: "delivered",
    ...(params.preparedMessageId ? { messageId: params.preparedMessageId } : {}),
  });
  const action = await params.deps.runMessageAction({
    cfg: params.context.config,
    action: "send",
    params: {
      channel: params.conversation.channel,
      to: params.conversation.target,
      accountId: params.conversation.accountId,
      message: params.message,
      ...(params.conversation.threadId ? { threadId: params.conversation.threadId } : {}),
      idempotencyKey: params.turnId,
    },
    defaultAccountId: params.conversation.accountId,
    agentId: params.context.agentId,
    sessionKey: params.context.sourceSessionKey,
    senderIsOwner: params.context.senderIsOwner,
    transcriptMirror: {
      agentId: params.context.agentId,
      sessionKey: params.conversation.sessionKey,
      expectedSessionId: params.conversation.sessionId,
      idempotencyKey,
      deliveryMirror: deliveredMirror,
      deliveryMirrorUpdateMode: "marker-only",
    },
    ...(params.preparedMessageId ? { preparedMessageId: params.preparedMessageId } : {}),
    ...(params.gatewayOwnedDelivery ? { gatewayOwnedDelivery: true } : {}),
    ...(params.signal ? { abortSignal: params.signal } : {}),
  });
  if (action.kind !== "send") {
    throw new Error(`Conversation delivery returned unexpected action: ${action.kind}`);
  }
  if (action.dryRun) {
    throw new Error("Conversation delivery was only prepared; no message was sent");
  }
  return {
    ...(action.deliveredText ? { deliveredMessage: action.deliveredText } : {}),
    messageId: readMessageIdFromActionResult(action),
  };
}

export async function recordConversationDelivery(params: {
  deps: ConversationDeliveryDeps;
  context: ConversationDeliveryContext;
  conversation: ConversationRecord;
  message: string;
  deliveredMessage?: string;
  turnId: string;
  outboundMessageId?: string;
}): Promise<boolean> {
  try {
    // Same-session sends are redundant with their tool call. Cross-session
    // sends are the backing conversation's only outbound model context.
    const deliveryMirror = buildConversationDeliveryMirror({
      context: params.context,
      conversation: params.conversation,
      status: "delivered",
      ...(params.outboundMessageId ? { messageId: params.outboundMessageId } : {}),
    });
    // Only direct core delivery can report post-normalization text exactly.
    // Unknown plugin/gateway text keeps the durable intent and upgrades only its marker.
    const result = await params.deps.appendAssistantMessage({
      agentId: params.context.agentId,
      sessionKey: params.conversation.sessionKey,
      expectedSessionId: params.conversation.sessionId,
      idempotencyKey: `conversation-outbound:${params.turnId}`,
      config: params.context.config,
      text: params.deliveredMessage ?? params.message,
      deliveryMirror,
      deliveryMirrorUpdateMode: params.deliveredMessage ? "replace" : "marker-only",
      beforeMessageWrite: (hookParams) => {
        const nextMessage = params.deps.beforeMessageWrite(hookParams);
        if (!nextMessage) {
          return null;
        }
        return {
          ...nextMessage,
          openclawDeliveryMirror: deliveryMirror,
        } as SessionTranscriptAssistantMessage;
      },
    });
    return result.ok;
  } catch {
    // Delivery has already happened. Never surface a bookkeeping failure as a retryable send.
    return false;
  }
}
