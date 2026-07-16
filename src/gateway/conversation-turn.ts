import type { ConversationTurnResult } from "../../packages/gateway-protocol/src/schema/agent.js";
import {
  resolveConversation,
  type ConversationRecord,
  type ConversationRegistryScope,
} from "../config/sessions/conversation-registry.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOutboundChannelPlugin } from "../infra/outbound/channel-resolution.js";
import {
  defaultConversationDeliveryDeps,
  sendConversationMessage,
  type ConversationDeliveryDeps,
} from "../infra/outbound/conversation-delivery.js";
import { registerPendingConversationTurn } from "../sessions/conversation-turns.js";

export class ConversationTurnInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationTurnInputError";
  }
}

type ConversationTurnDeps = ConversationDeliveryDeps & {
  registerPendingConversationTurn: typeof registerPendingConversationTurn;
  resolveConversation: typeof resolveConversation;
  resolveOutboundChannelPlugin: typeof resolveOutboundChannelPlugin;
};

const defaultDeps: ConversationTurnDeps = {
  ...defaultConversationDeliveryDeps,
  registerPendingConversationTurn,
  resolveConversation,
  resolveOutboundChannelPlugin,
};

function resolveConversationScope(params: {
  agentId: string;
  config: OpenClawConfig;
}): ConversationRegistryScope {
  const configuredStore = params.config.session?.store;
  return {
    agentId: params.agentId,
    ...(configuredStore
      ? { storePath: resolveStorePath(configuredStore, { agentId: params.agentId }) }
      : {}),
  };
}

function resultForCompletedOperation(params: {
  conversation: ConversationRecord;
  operation: ReturnType<ConversationDeliveryDeps["beginOperation"]>["record"];
}): ConversationTurnResult | undefined {
  const { conversation, operation } = params;
  const messageId = operation.platformMessageId ?? operation.preparedMessageId;
  if (operation.status === "replied" && operation.reply && messageId) {
    return {
      status: "replied",
      conversationRef: conversation.conversationRef,
      channel: conversation.channel,
      messageId,
      correlationPersisted: true,
      reply: {
        conversationRef: conversation.conversationRef,
        messageId: operation.reply.messageId,
        ...(operation.reply.replyToId ? { replyToId: operation.reply.replyToId } : {}),
        ...(operation.reply.threadId ? { threadId: operation.reply.threadId } : {}),
        text: operation.reply.text,
        timestamp: operation.reply.timestamp,
      },
    };
  }
  if (operation.status === "created") {
    return undefined;
  }
  const base = {
    conversationRef: conversation.conversationRef,
    channel: conversation.channel,
    ...(messageId ? { messageId } : {}),
  };
  switch (operation.status) {
    case "sent":
      return {
        ...base,
        status: "sent",
        correlationPersisted: true,
        error: "Message was already sent; no process-local reply waiter remains.",
      };
    case "queued":
      return {
        ...base,
        status: "queued",
        correlationPersisted: true,
        error: "Delivery is queued; a later reply will start an ordinary inbound turn.",
      };
    case "suppressed":
      return {
        ...base,
        status: "suppressed",
        correlationPersisted: false,
        error: "Delivery was suppressed before a message was sent.",
      };
    case "unknown":
      return {
        ...base,
        status: "unknown",
        correlationPersisted: false,
        error: "Delivery could not be confirmed and will not be retried automatically.",
      };
    case "replied":
      return {
        ...base,
        status: "sent",
        correlationPersisted: true,
        error: "A reply was recorded, but its durable reply payload is incomplete.",
      };
  }
  return operation.status satisfies never;
}

function prepareConversationMessageId(params: {
  deps: ConversationTurnDeps;
  config: OpenClawConfig;
  conversation: ConversationRecord;
  message: string;
}): string {
  const prepare = params.deps.resolveOutboundChannelPlugin({
    channel: params.conversation.channel,
    cfg: params.config,
  })?.outbound?.prepareConversationTurnMessageId;
  if (!prepare) {
    throw new ConversationTurnInputError(
      `Channel ${params.conversation.channel} does not support correlated conversation turns; use conversations_send`,
    );
  }
  let preparedMessageId: string;
  try {
    preparedMessageId = prepare({
      cfg: params.config,
      to: params.conversation.target,
      text: params.message,
      accountId: params.conversation.accountId,
      threadId: params.conversation.threadId,
    }).trim();
  } catch (error) {
    throw new ConversationTurnInputError(error instanceof Error ? error.message : String(error));
  }
  if (!preparedMessageId) {
    throw new ConversationTurnInputError(
      `Channel ${params.conversation.channel} prepared an empty conversation-turn message id`,
    );
  }
  return preparedMessageId;
}

/** Owns correlation, delivery, and waiting inside the Gateway process that receives ingress. */
export async function runGatewayConversationTurn(
  params: {
    config: OpenClawConfig;
    agentId: string;
    sourceSessionKey?: string;
    turnId: string;
    conversationRef: string;
    message: string;
    timeoutMs: number;
  },
  deps: ConversationTurnDeps = defaultDeps,
): Promise<ConversationTurnResult> {
  const scope = resolveConversationScope(params);
  const conversation = deps.resolveConversation(scope, params.conversationRef);
  if (!conversation) {
    throw new ConversationTurnInputError(
      `Conversation not found: ${params.conversationRef} (use conversations_list)`,
    );
  }

  const prior = deps.getOperation(scope, params.turnId);
  const preparedMessageId =
    prior?.preparedMessageId ??
    prepareConversationMessageId({
      deps,
      config: params.config,
      conversation,
      message: params.message,
    });
  const begun = deps.beginOperation(scope, {
    operationId: params.turnId,
    conversationRef: conversation.conversationRef,
    message: params.message,
    preparedMessageId,
  });
  const completed = resultForCompletedOperation({ conversation, operation: begun.record });
  if (completed) {
    return completed;
  }

  const pending = deps.registerPendingConversationTurn({
    id: params.turnId,
    conversationRef: conversation.conversationRef,
    sessionId: conversation.sessionId,
    ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
    timeoutMs: params.timeoutMs,
  });
  // Correlation exists before recipient-visible I/O; a fast peer may reply
  // while the transport send promise is still resolving.
  pending.setOutboundMessageId(preparedMessageId);
  try {
    const sent = await sendConversationMessage({
      deps,
      context: {
        agentId: params.agentId,
        ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
        config: params.config,
        senderIsOwner: true,
      },
      conversation,
      message: params.message,
      operationId: pending.id,
      operation: begun.record,
      preparedMessageId,
    });
    if (sent.deliveryStatus !== "sent") {
      pending.cancel();
      return resultForCompletedOperation({ conversation, operation: sent.operation })!;
    }
    const exactMessageId = sent.messageId === preparedMessageId;
    if (!exactMessageId) {
      pending.cancel();
      return {
        status: "sent",
        conversationRef: conversation.conversationRef,
        channel: conversation.channel,
        ...(sent.messageId ? { messageId: sent.messageId } : {}),
        correlationPersisted: true,
        error:
          "Channel delivery did not preserve its prepared message id; reply correlation was disabled.",
      };
    }
    pending.markReady();
    const reply = await pending.wait();
    return reply
      ? {
          status: "replied",
          conversationRef: conversation.conversationRef,
          channel: conversation.channel,
          messageId: preparedMessageId,
          correlationPersisted: true,
          reply,
        }
      : {
          status: "timeout",
          conversationRef: conversation.conversationRef,
          channel: conversation.channel,
          messageId: preparedMessageId,
          correlationPersisted: true,
        };
  } catch (error) {
    pending.cancel();
    throw error;
  }
}
