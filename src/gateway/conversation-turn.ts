import type { ConversationTurnResult } from "../../packages/gateway-protocol/src/schema/agent.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../agents/harness/hook-helpers.js";
import {
  resolveConversation,
  type ConversationRegistryScope,
} from "../config/sessions/conversation-registry.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOutboundChannelPlugin } from "../infra/outbound/channel-resolution.js";
import {
  recordConversationDelivery,
  sendConversationMessage,
  type ConversationDeliveryDeps,
} from "../infra/outbound/conversation-delivery.js";
import { runMessageAction } from "../infra/outbound/message-action-runner.js";
import { registerPendingConversationTurn } from "../sessions/conversation-turns.js";

export class ConversationTurnInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationTurnInputError";
  }
}

type ConversationTurnDeps = ConversationDeliveryDeps & {
  loadSessionEntry: typeof loadSessionEntry;
  registerPendingConversationTurn: typeof registerPendingConversationTurn;
  resolveConversation: typeof resolveConversation;
  resolveOutboundChannelPlugin: typeof resolveOutboundChannelPlugin;
};

const defaultDeps: ConversationTurnDeps = {
  appendAssistantMessage: appendAssistantMessageToSessionTranscript,
  beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
  loadSessionEntry,
  registerPendingConversationTurn,
  resolveConversation,
  resolveOutboundChannelPlugin,
  runMessageAction,
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

/** Owns correlation, delivery, and waiting inside the Gateway process that receives Reef ingress. */
export async function runGatewayConversationTurn(
  params: {
    config: OpenClawConfig;
    agentId: string;
    sourceSessionId?: string;
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
  const prepare = deps.resolveOutboundChannelPlugin({
    channel: conversation.channel,
    cfg: params.config,
  })?.outbound?.prepareConversationTurnMessageId;
  if (!prepare) {
    throw new ConversationTurnInputError(
      `Channel ${conversation.channel} does not support correlated conversation turns; use conversations_send`,
    );
  }
  let preparedMessageId: string;
  try {
    preparedMessageId = prepare({
      cfg: params.config,
      to: conversation.target,
      text: params.message,
      accountId: conversation.accountId,
      threadId: conversation.threadId,
    }).trim();
  } catch (error) {
    throw new ConversationTurnInputError(error instanceof Error ? error.message : String(error));
  }
  if (!preparedMessageId) {
    throw new ConversationTurnInputError(
      `Channel ${conversation.channel} prepared an empty conversation-turn message id`,
    );
  }

  const sourceSessionId =
    params.sourceSessionId ??
    (params.sourceSessionKey
      ? deps.loadSessionEntry({
          ...scope,
          sessionKey: params.sourceSessionKey,
          readConsistency: "latest",
        })?.sessionId
      : undefined);

  const pending = deps.registerPendingConversationTurn({
    id: params.turnId,
    conversationRef: conversation.conversationRef,
    sessionId: conversation.sessionId,
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
    timeoutMs: params.timeoutMs,
  });
  // Correlation must exist before recipient-visible I/O; a fast peer can reply
  // while the transport send promise is still resolving.
  pending.setOutboundMessageId(preparedMessageId);
  try {
    const context = {
      agentId: params.agentId,
      ...(sourceSessionId ? { sourceSessionId } : {}),
      ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
      config: params.config,
      senderIsOwner: true,
    };
    const sent = await sendConversationMessage({
      deps,
      context,
      conversation,
      message: params.message,
      turnId: pending.id,
      preparedMessageId,
      gatewayOwnedDelivery: true,
    });
    const correlationPersisted = await recordConversationDelivery({
      deps,
      context,
      conversation,
      message: params.message,
      ...(sent.deliveredMessage ? { deliveredMessage: sent.deliveredMessage } : {}),
      turnId: pending.id,
      outboundMessageId: sent.messageId,
    });
    const exactMessageId = sent.messageId === preparedMessageId;
    if (!correlationPersisted || !exactMessageId) {
      pending.cancel();
      return {
        status: "sent",
        conversationRef: conversation.conversationRef,
        channel: conversation.channel,
        ...(sent.messageId ? { messageId: sent.messageId } : {}),
        correlationPersisted,
        error: !correlationPersisted
          ? "Delivery succeeded, but its outbound context was not persisted; reply correlation was disabled."
          : "Channel delivery did not preserve its prepared message id; reply correlation was disabled.",
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
          correlationPersisted,
          reply,
        }
      : {
          status: "timeout",
          conversationRef: conversation.conversationRef,
          channel: conversation.channel,
          messageId: preparedMessageId,
          correlationPersisted,
        };
  } catch (error) {
    pending.cancel();
    throw error;
  }
}
