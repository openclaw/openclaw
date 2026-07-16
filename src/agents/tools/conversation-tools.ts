/** Agent tools for addressing external conversations independently from local model sessions. */
import crypto from "node:crypto";
import { Type } from "typebox";
import type { ConversationTurnResult } from "../../../packages/gateway-protocol/src/schema/agent.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  listConversations,
  resolveConversation,
  type ConversationRecord,
  type ConversationRegistryScope,
} from "../../config/sessions/conversation-registry.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import {
  recordConversationDelivery,
  sendConversationMessage,
  type ConversationDeliveryDeps,
} from "../../infra/outbound/conversation-delivery.js";
import { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../harness/hook-helpers.js";
import { optionalPositiveIntegerSchema } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readPositiveIntegerParam,
  readStringParam,
  ToolAuthorizationError,
  ToolInputError,
} from "./common.js";

const CONVERSATION_REF_PATTERN = /^conv_[a-f0-9]{32}$/u;

const ConversationsListSchema = Type.Object(
  {
    channel: Type.Optional(Type.String({ minLength: 1 })),
    limit: optionalPositiveIntegerSchema(),
  },
  { additionalProperties: false },
);

const ConversationsSendSchema = Type.Object(
  {
    conversationRef: Type.String({ pattern: CONVERSATION_REF_PATTERN.source }),
    message: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const ConversationsTurnSchema = Type.Object(
  {
    conversationRef: Type.String({ pattern: CONVERSATION_REF_PATTERN.source }),
    message: Type.String({ minLength: 1 }),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
  },
  { additionalProperties: false },
);

type ConversationToolOptions = {
  agentId?: string;
  agentSessionId?: string;
  agentSessionKey?: string;
  config?: OpenClawConfig;
  senderIsOwner?: boolean;
};

type ConversationToolDeps = ConversationDeliveryDeps & {
  callGateway: typeof callGateway;
  listConversations: typeof listConversations;
  resolveConversation: typeof resolveConversation;
};

const defaultDeps: ConversationToolDeps = {
  appendAssistantMessage: appendAssistantMessageToSessionTranscript,
  beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
  callGateway,
  listConversations,
  resolveConversation,
  runMessageAction,
};

function resolveToolAgentId(options: ConversationToolOptions): string {
  return options.agentId ?? resolveAgentIdFromSessionKey(options.agentSessionKey);
}

function resolveConversationScope(options: ConversationToolOptions): ConversationRegistryScope {
  const agentId = resolveToolAgentId(options);
  const configuredStore = options.config?.session?.store;
  return {
    agentId,
    ...(configuredStore ? { storePath: resolveStorePath(configuredStore, { agentId }) } : {}),
  };
}

function requireOwner(options: ConversationToolOptions): void {
  if (options.senderIsOwner === false) {
    throw new ToolAuthorizationError("Conversation tools require owner access");
  }
}

function readConversationRef(value: string): string {
  const conversationRef = value.trim().toLowerCase();
  if (!CONVERSATION_REF_PATTERN.test(conversationRef)) {
    throw new ToolInputError(`Invalid conversationRef: ${value}`);
  }
  return conversationRef;
}

function requireConversation(params: {
  deps: ConversationToolDeps;
  options: ConversationToolOptions;
  conversationRef: string;
}): ConversationRecord {
  const conversationRef = readConversationRef(params.conversationRef);
  const conversation = params.deps.resolveConversation(
    resolveConversationScope(params.options),
    conversationRef,
  );
  if (!conversation) {
    throw new ToolInputError(
      `Conversation not found: ${params.conversationRef} (use conversations_list)`,
    );
  }
  return conversation;
}

function presentConversation(conversation: ConversationRecord) {
  return {
    conversationRef: conversation.conversationRef,
    channel: conversation.channel,
    accountId: conversation.accountId,
    kind: conversation.kind,
    target: conversation.target,
    ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
    ...(conversation.label ? { label: conversation.label } : {}),
    firstSeenAt: conversation.firstSeenAt,
    lastSeenAt: conversation.lastSeenAt,
  };
}

/** Lists opaque, exact external addresses owned by the active agent. */
export function createConversationsListTool(
  options: ConversationToolOptions = {},
  deps: ConversationToolDeps = defaultDeps,
): AnyAgentTool {
  return {
    label: "Conversations",
    name: "conversations_list",
    displaySummary: "List exact external conversation addresses.",
    description:
      "List external conversations as stable conversationRef values. Sessions hold local model context; conversationRef selects an exact external channel destination.",
    parameters: ConversationsListSchema,
    execute: async (_toolCallId, args) => {
      requireOwner(options);
      const params = args as Record<string, unknown>;
      const limit = Math.min(readPositiveIntegerParam(params, "limit") ?? 50, 100);
      const channel = readStringParam(params, "channel");
      return jsonResult({
        conversations: deps
          .listConversations(resolveConversationScope(options), {
            limit,
            ...(channel ? { channel } : {}),
          })
          .map(presentConversation),
      });
    },
  };
}

/** Sends directly to one external conversation without invoking its backing local session. */
export function createConversationsSendTool(
  options: ConversationToolOptions = {},
  deps: ConversationToolDeps = defaultDeps,
): AnyAgentTool {
  return {
    label: "Conversation Send",
    name: "conversations_send",
    displaySummary: "Send to an exact external conversation.",
    description:
      "Send directly through a conversationRef from conversations_list. This performs channel delivery; it does not run the local agent in the backing session.",
    parameters: ConversationsSendSchema,
    execute: async (_toolCallId, args, signal) => {
      requireOwner(options);
      const params = args as Record<string, unknown>;
      const conversation = requireConversation({
        deps,
        options,
        conversationRef: readStringParam(params, "conversationRef", { required: true }),
      });
      const message = readStringParam(params, "message", { required: true });
      const turnId = crypto.randomUUID();
      const config = options.config ?? getRuntimeConfig();
      const context = {
        agentId: resolveToolAgentId(options),
        ...(options.agentSessionId ? { sourceSessionId: options.agentSessionId } : {}),
        ...(options.agentSessionKey ? { sourceSessionKey: options.agentSessionKey } : {}),
        config,
        ...(options.senderIsOwner !== undefined ? { senderIsOwner: options.senderIsOwner } : {}),
      };
      const sent = await sendConversationMessage({
        deps,
        context,
        conversation,
        message,
        turnId,
        signal,
      });
      const correlationPersisted = await recordConversationDelivery({
        deps,
        context,
        conversation,
        message,
        ...(sent.deliveredMessage ? { deliveredMessage: sent.deliveredMessage } : {}),
        turnId,
        outboundMessageId: sent.messageId,
      });
      return jsonResult({
        status: "sent",
        conversationRef: conversation.conversationRef,
        channel: conversation.channel,
        ...(sent.messageId ? { messageId: sent.messageId } : {}),
        correlationPersisted,
      });
    },
  };
}

/** Sends and consumes one correlated peer reply inline, preserving both sides in the transcript. */
export function createConversationsTurnTool(
  options: ConversationToolOptions = {},
  deps: ConversationToolDeps = defaultDeps,
): AnyAgentTool {
  return {
    label: "Conversation Turn",
    name: "conversations_turn",
    displaySummary: "Send and wait for the correlated peer reply.",
    description:
      "Send through a conversationRef and wait for its correlated inbound reply. The reply returns here instead of starting a second local agent turn; unsolicited messages still start normal turns.",
    parameters: ConversationsTurnSchema,
    execute: async (_toolCallId, args, signal) => {
      requireOwner(options);
      const params = args as Record<string, unknown>;
      const conversationRef = readConversationRef(
        readStringParam(params, "conversationRef", { required: true }),
      );
      const message = readStringParam(params, "message", { required: true });
      const timeoutSeconds = readPositiveIntegerParam(params, "timeoutSeconds") ?? 30;
      const timeoutMs = timeoutSeconds * 1_000;
      const turnId = crypto.randomUUID();
      const result = await deps.callGateway<ConversationTurnResult>({
        method: "conversations.turn",
        params: {
          agentId: resolveToolAgentId(options),
          ...(options.agentSessionId ? { sourceSessionId: options.agentSessionId } : {}),
          ...(options.agentSessionKey ? { sourceSessionKey: options.agentSessionKey } : {}),
          turnId,
          conversationRef,
          message,
          timeoutMs,
        },
        ...(options.config ? { config: options.config } : {}),
        timeoutMs: timeoutMs + 20_000,
        ...(signal ? { signal } : {}),
        onSignalAbort: async (request) => {
          await request("conversations.turn.cancel", { turnId }, { timeoutMs: 5_000 });
        },
      });
      return jsonResult(result);
    },
  };
}
