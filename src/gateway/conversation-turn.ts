import type { ConversationTurnResult } from "../../packages/gateway-protocol/src/schema/agent.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import {
  beginConversationDeliveryOperation,
  ConversationDeliveryInputError,
  getConversationDeliveryOperation,
  type ConversationDeliveryRecord,
} from "../config/sessions/conversation-delivery-store.js";
import {
  readConversation,
  prepareConversationRegistryScope,
  type ConversationRecord,
} from "../config/sessions/conversation-registry.js";
import { resolveConversationRouteFingerprint } from "../config/sessions/conversation-route-fingerprint.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOutboundChannelPlugin } from "../infra/outbound/channel-resolution.js";
import {
  ConversationDeliveryRejectedError,
  sendGatewayConversationMessage,
} from "../infra/outbound/conversation-delivery.js";
import {
  bindOutboundSessionEntry,
  captureOutboundSessionBinding,
  prepareOutboundSessionBinding,
  resolveOutboundSessionRoute,
} from "../infra/outbound/outbound-session.js";
import { registerPendingConversationTurn } from "../sessions/conversation-turns.js";
import {
  ConversationInputError,
  ConversationOperationConflictError,
} from "./conversation-errors.js";
import {
  withAuthorizedConversationDelivery,
  assertConversationDeliveryRouteAuthorized,
  assertConversationRouteEligibleForAgent,
} from "./conversation-route-ownership.js";

type BoundConversationRecord = ConversationRecord & {
  sessionId: string;
  sessionKey: string;
};

function hasConversationSessionBinding(
  conversation: ConversationRecord,
): conversation is BoundConversationRecord {
  return Boolean(conversation.sessionId && conversation.sessionKey);
}

const COMPLETED_TURN_MESSAGES = {
  sent: "Message was already sent; no process-local reply waiter remains.",
  queued: "Delivery is queued; a later reply will start an ordinary inbound turn.",
  suppressed: "Delivery was suppressed before a message was sent.",
  unknown: "Delivery could not be confirmed and will not be retried automatically.",
  replied: "A reply was recorded, but its durable reply payload is incomplete.",
} satisfies Record<Exclude<ConversationDeliveryRecord["status"], "created" | "rejected">, string>;

function resultForCompletedOperation(
  operation: ConversationDeliveryRecord,
): ConversationTurnResult | undefined {
  const messageId = operation.platformMessageId ?? operation.preparedMessageId;
  if (operation.status === "replied" && operation.reply && messageId) {
    return {
      status: "replied",
      conversationRef: operation.conversationRef,
      channel: operation.channel,
      messageId,
      correlationPersisted: true,
      reply: {
        conversationRef: operation.conversationRef,
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
    conversationRef: operation.conversationRef,
    channel: operation.channel,
    ...(messageId ? { messageId } : {}),
  };
  if (operation.status === "rejected") {
    throw new ConversationInputError(
      operation.rejectionError ?? "Conversation delivery was permanently rejected",
    );
  }
  return {
    ...base,
    status: operation.status === "replied" ? "sent" : operation.status,
    correlationPersisted:
      operation.status === "sent" ||
      operation.status === "queued" ||
      operation.status === "replied",
    error: COMPLETED_TURN_MESSAGES[operation.status],
  };
}

/** Owns correlation, delivery, and waiting inside the Gateway process that receives ingress. */
export async function runGatewayConversationTurn(params: {
  config: OpenClawConfig;
  readCurrentConfig?: () => OpenClawConfig;
  agentId: string;
  senderIsOwner: boolean;
  sourceSessionKey?: string;
  turnId: string;
  conversationRef: string;
  message: string;
  timeoutMs: number;
}): Promise<ConversationTurnResult> {
  const scope = await prepareConversationRegistryScope(params);
  const binding = captureOutboundSessionBinding({
    cfg: params.config,
    scope,
    sourceSessionKey: params.sourceSessionKey,
  });
  let begun: Awaited<ReturnType<typeof beginConversationDeliveryOperation>> | undefined;
  try {
    const prior = await getConversationDeliveryOperation(scope, params.turnId, {
      operationKind: "turn",
      conversationRef: params.conversationRef,
      ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
      message: params.message,
    });
    begun = prior ? { created: false, record: prior } : undefined;
  } catch (error) {
    if (error instanceof ConversationDeliveryInputError) {
      throw new ConversationOperationConflictError(error.message);
    }
    throw error;
  }

  const discoveredConversation = await readConversation(scope, params.conversationRef);
  if (!discoveredConversation) {
    throw new ConversationInputError(
      `Conversation not found: ${params.conversationRef} (use conversations_list)`,
    );
  }
  const readCurrentConfig = params.readCurrentConfig ?? (() => params.config);
  const currentConfig = readCurrentConfig();
  assertConversationRouteEligibleForAgent({
    config: currentConfig,
    agentId: params.agentId,
    conversation: discoveredConversation,
  });
  const discoveredRouteFingerprint = resolveConversationRouteFingerprint(discoveredConversation);
  if (begun) {
    const completed = resultForCompletedOperation(begun.record);
    if (completed) {
      return completed;
    }
  }
  const plugin = resolveOutboundChannelPlugin({
    channel: discoveredConversation.channel,
    cfg: currentConfig,
  });
  let candidatePreparedMessageId = begun?.record.preparedMessageId;
  if (!begun) {
    const prepare = plugin?.outbound?.prepareConversationTurnMessageId;
    if (!prepare) {
      throw new ConversationInputError(
        `Channel ${discoveredConversation.channel} does not support correlated conversation turns; use conversations_send`,
      );
    }
    try {
      candidatePreparedMessageId = prepare({
        cfg: currentConfig,
        to: discoveredConversation.target,
        text: params.message,
        accountId: discoveredConversation.accountId,
        threadId: discoveredConversation.threadId,
      }).trim();
    } catch (error) {
      throw new ConversationInputError(error instanceof Error ? error.message : String(error));
    }
    if (!candidatePreparedMessageId) {
      throw new ConversationInputError(
        `Channel ${discoveredConversation.channel} prepared an empty conversation-turn message id`,
      );
    }
  }
  if (!candidatePreparedMessageId) {
    throw new ConversationInputError(
      `Conversation turn ${params.turnId} is missing its prepared message id`,
    );
  }
  let conversation: BoundConversationRecord;
  if (hasConversationSessionBinding(discoveredConversation)) {
    conversation = discoveredConversation;
  } else {
    const preparedBinding = prepareOutboundSessionBinding(binding);
    const channel = (plugin?.id ?? discoveredConversation.channel) as ChannelId;
    const route = await resolveOutboundSessionRoute({
      cfg: currentConfig,
      channel,
      ...(plugin ? { plugin } : {}),
      agentId: params.agentId,
      accountId: discoveredConversation.accountId,
      target: discoveredConversation.target,
      ...(discoveredConversation.threadId ? { threadId: discoveredConversation.threadId } : {}),
    });
    if (!route) {
      throw new ConversationInputError(
        `Conversation ${discoveredConversation.conversationRef} no longer resolves to a channel route`,
      );
    }
    await bindOutboundSessionEntry(
      {
        cfg: currentConfig,
        channel,
        accountId: discoveredConversation.accountId,
        route,
        sourceSessionKey: params.sourceSessionKey,
        // Replay authority after plugin route resolution at the session-binding commit.
        workerGuard: {
          conversation: {
            conversationRef: discoveredConversation.conversationRef,
            expectedRouteFingerprint: discoveredRouteFingerprint,
          },
          assertCurrent: () => {
            assertConversationDeliveryRouteAuthorized({
              config: readCurrentConfig(),
              agentId: params.agentId,
              conversationRef: discoveredConversation.conversationRef,
              expectedRouteFingerprint: discoveredRouteFingerprint,
              conversation: discoveredConversation,
            });
          },
        },
      },
      preparedBinding,
    );
    const bound = await readConversation(scope, discoveredConversation.conversationRef);
    if (!bound || !hasConversationSessionBinding(bound)) {
      throw new Error(
        `Conversation ${discoveredConversation.conversationRef} could not create its local context binding`,
      );
    }
    conversation = bound;
  }
  const authorizedConfig = readCurrentConfig();
  assertConversationRouteEligibleForAgent({
    config: authorizedConfig,
    agentId: params.agentId,
    conversation,
  });
  const routeFingerprint = resolveConversationRouteFingerprint(conversation);
  const authority = {
    conversationRef: conversation.conversationRef,
    expectedRouteFingerprint: routeFingerprint,
    expectedSessionId: conversation.sessionId,
    expectedSessionKey: conversation.sessionKey,
  };
  const assertCurrent = () => {
    assertConversationDeliveryRouteAuthorized({
      ...authority,
      config: readCurrentConfig(),
      agentId: params.agentId,
      conversation,
    });
  };
  if (!begun) {
    try {
      begun = await beginConversationDeliveryOperation(
        scope,
        {
          operationId: params.turnId,
          operationKind: "turn",
          conversationRef: conversation.conversationRef,
          ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
          message: params.message,
          authority,
          preparedMessageId: candidatePreparedMessageId,
        },
        assertCurrent,
      );
      assertCurrent();
    } catch (error) {
      if (error instanceof ConversationDeliveryInputError) {
        throw new ConversationOperationConflictError(error.message);
      }
      throw error;
    }
    const completed = resultForCompletedOperation(begun.record);
    if (completed) {
      return completed;
    }
  }
  // Another process may have created the operation after our initial read.
  // Its durable reservation owns correlation; never send with our stale candidate.
  const preparedMessageId = begun.record.preparedMessageId;
  if (!preparedMessageId) {
    throw new ConversationInputError(
      `Conversation turn ${params.turnId} is missing its prepared message id`,
    );
  }

  const pending = registerPendingConversationTurn({
    agentId: params.agentId,
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
    const sent = await sendGatewayConversationMessage({
      scope,
      context: {
        agentId: params.agentId,
        ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
        config: authorizedConfig,
        senderIsOwner: params.senderIsOwner,
      },
      conversation,
      message: params.message,
      operationId: pending.id,
      operationKind: "turn",
      operation: begun.record,
      preparedMessageId,
      routeFingerprint,
      authority,
      assertCurrent,
      withDirectAdapterHandoff: (initiate) =>
        withAuthorizedConversationDelivery(
          {
            ...authority,
            config: authorizedConfig,
            readCurrentConfig,
            agentId: params.agentId,
            scope,
          },
          initiate,
        ),
    });
    if (sent.deliveryStatus !== "sent") {
      pending.cancel();
      return resultForCompletedOperation(sent.operation)!;
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
    const delivered = {
      conversationRef: conversation.conversationRef,
      channel: conversation.channel,
      messageId: preparedMessageId,
      correlationPersisted: true,
    };
    return reply ? { status: "replied", ...delivered, reply } : { status: "timeout", ...delivered };
  } catch (error) {
    pending.cancel();
    if (error instanceof ConversationDeliveryRejectedError) {
      throw new ConversationInputError(error.message);
    }
    throw error;
  }
}
