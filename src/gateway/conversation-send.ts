import type { ConversationSendResult } from "../../packages/gateway-protocol/src/schema/agent.js";
import { ConversationDeliveryInputError } from "../config/sessions/conversation-delivery-store.js";
import {
  resolveConversation,
  type ConversationRegistryScope,
} from "../config/sessions/conversation-registry.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  ConversationDeliveryRejectedError,
  defaultConversationDeliveryDeps,
  sendGatewayConversationMessage,
  type ConversationDeliveryDeps,
} from "../infra/outbound/conversation-delivery.js";
import {
  ConversationInputError,
  ConversationOperationConflictError,
} from "./conversation-errors.js";

type ConversationSendDeps = ConversationDeliveryDeps & {
  resolveConversation: typeof resolveConversation;
};

const defaultDeps: ConversationSendDeps = {
  ...defaultConversationDeliveryDeps,
  resolveConversation,
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

/** Performs one durable conversation send inside the Gateway channel owner. */
export async function runGatewayConversationSend(
  params: {
    config: OpenClawConfig;
    agentId: string;
    senderIsOwner: boolean;
    sourceSessionKey?: string;
    operationId: string;
    conversationRef: string;
    message: string;
    signal?: AbortSignal;
  },
  deps: ConversationSendDeps = defaultDeps,
): Promise<ConversationSendResult> {
  const conversation = deps.resolveConversation(
    resolveConversationScope(params),
    params.conversationRef,
  );
  if (!conversation) {
    throw new ConversationInputError(
      `Conversation not found: ${params.conversationRef} (use conversations_list)`,
    );
  }
  try {
    const sent = await sendGatewayConversationMessage({
      deps,
      context: {
        agentId: params.agentId,
        ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
        config: params.config,
        senderIsOwner: params.senderIsOwner,
      },
      conversation,
      message: params.message,
      operationId: params.operationId,
      operationKind: "send",
      ...(params.signal ? { signal: params.signal } : {}),
    });
    return {
      status: sent.deliveryStatus,
      conversationRef: conversation.conversationRef,
      channel: conversation.channel,
      ...(sent.messageId ? { messageId: sent.messageId } : {}),
      ...(sent.operation.queueId ? { queueId: sent.operation.queueId } : {}),
    };
  } catch (error) {
    if (error instanceof ConversationDeliveryInputError) {
      throw new ConversationOperationConflictError(error.message);
    }
    if (error instanceof ConversationDeliveryRejectedError) {
      throw new ConversationInputError(error.message);
    }
    throw error;
  }
}
