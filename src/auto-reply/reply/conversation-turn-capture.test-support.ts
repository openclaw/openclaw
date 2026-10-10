import {
  beginConversationDeliveryOperation,
  markConversationDeliveryQueued,
  markConversationDeliverySent,
} from "../../config/sessions/conversation-delivery-store.js";

export async function persistSentOperation(params: {
  scope: { agentId: string; storePath: string };
  operationId: string;
  conversationRef: string;
  outboundMessageId: string;
}) {
  await beginConversationDeliveryOperation(params.scope, {
    operationId: params.operationId,
    operationKind: "turn",
    conversationRef: params.conversationRef,
    message: "outbound",
    preparedMessageId: params.outboundMessageId,
  });
  await markConversationDeliveryQueued(
    params.scope,
    params.operationId,
    `queue-${params.operationId}`,
  );
  await markConversationDeliverySent(params.scope, params.operationId, params.outboundMessageId);
}
