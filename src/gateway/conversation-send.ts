import type { ConversationSendResult } from "../../packages/gateway-protocol/src/schema/agent.js";
import {
  ConversationDeliveryInputError,
  getConversationDeliveryOperation,
  type ConversationDeliveryRecord,
} from "../config/sessions/conversation-delivery-store.js";
import {
  readConversation,
  prepareConversationRegistryScope,
} from "../config/sessions/conversation-registry.js";
import { resolveConversationRouteFingerprint } from "../config/sessions/conversation-route-fingerprint.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  ConversationDeliveryRejectedError,
  resultFromExistingOperation,
  sendGatewayConversationMessage,
} from "../infra/outbound/conversation-delivery.js";
import {
  ConversationInputError,
  ConversationOperationConflictError,
} from "./conversation-errors.js";
import {
  withAuthorizedConversationDelivery,
  prepareConversationDeliveryRouteAuthorization,
} from "./conversation-route-ownership.js";

/** Performs one durable conversation send inside the Gateway channel owner. */
export async function runGatewayConversationSend(params: {
  config: OpenClawConfig;
  readCurrentConfig?: () => OpenClawConfig;
  agentId: string;
  senderIsOwner: boolean;
  sourceSessionKey?: string;
  operationId: string;
  conversationRef: string;
  message: string;
  signal?: AbortSignal;
}): Promise<ConversationSendResult> {
  const scope = await prepareConversationRegistryScope(params);
  params.signal?.throwIfAborted();
  let routeAuthority:
    | Awaited<ReturnType<typeof prepareConversationDeliveryRouteAuthorization>>
    | undefined;
  try {
    const operation: ConversationDeliveryRecord | undefined =
      await getConversationDeliveryOperation(scope, params.operationId, {
        operationKind: "send",
        conversationRef: params.conversationRef,
        ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
        message: params.message,
      });

    const conversation = await readConversation(scope, params.conversationRef);
    params.signal?.throwIfAborted();
    if (!conversation) {
      throw new ConversationInputError(
        `Conversation not found: ${params.conversationRef} (use conversations_list)`,
      );
    }
    const currentConfig = params.readCurrentConfig?.() ?? params.config;
    const routeFingerprint = resolveConversationRouteFingerprint(conversation);
    const authority = {
      conversationRef: conversation.conversationRef,
      expectedRouteFingerprint: routeFingerprint,
    };
    routeAuthority = await prepareConversationDeliveryRouteAuthorization({
      ...authority,
      config: currentConfig,
      readCurrentConfig: params.readCurrentConfig,
      agentId: params.agentId,
      conversation,
    });
    routeAuthority.assertCurrent(conversation);
    // Completed retries retain persisted metadata and bypass current delivery-store resolution.
    const completed = operation ? resultFromExistingOperation(operation) : undefined;
    const sent =
      completed ??
      (await sendGatewayConversationMessage({
        scope,
        context: {
          agentId: params.agentId,
          ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
          config: currentConfig,
          senderIsOwner: params.senderIsOwner,
        },
        conversation,
        message: params.message,
        operationId: params.operationId,
        operationKind: "send",
        routeFingerprint,
        authority,
        assertCurrent: () => {
          params.signal?.throwIfAborted();
          routeAuthority!.assertCurrent(conversation);
        },
        withDirectAdapterHandoff: (initiate) =>
          withAuthorizedConversationDelivery(
            {
              ...authority,
              config: currentConfig,
              readCurrentConfig: params.readCurrentConfig,
              agentId: params.agentId,
              scope,
              routeAuthority,
            },
            () => {
              params.signal?.throwIfAborted();
              return initiate();
            },
          ),
        ...(operation ? { operation } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      }));
    const resultConversation = completed ? completed.operation : conversation;
    return {
      status: sent.deliveryStatus,
      conversationRef: resultConversation.conversationRef,
      channel: resultConversation.channel,
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
  } finally {
    routeAuthority?.dispose();
  }
}
