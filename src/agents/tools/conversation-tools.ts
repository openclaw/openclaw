import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { Type } from "typebox";
// Keep Gateway wire schemas as the single owner so Code Mode never advertises a divergent shape.
import {
  ConversationListResultSchema,
  ConversationSendResultSchema,
  ConversationTurnResultSchema,
  type ConversationListResult,
  type ConversationSendResult,
  type ConversationTurnResult,
} from "../../../packages/gateway-protocol/src/schema/agent.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { optionalPositiveIntegerSchema } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readPositiveIntegerParam,
  readToolStringParam,
  ToolAuthorizationError,
  ToolInputError,
} from "./common.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";

const CONVERSATION_REF_PATTERN = /^conv_[a-f0-9]{32}$/u;

const ConversationsListSchema = Type.Object(
  {
    channel: Type.Optional(Type.String({ minLength: 1 })),
    query: Type.Optional(Type.String({ minLength: 1 })),
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
    ...ConversationsSendSchema.properties,
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

function resolveToolAgentId(options: ConversationToolOptions): string {
  return options.agentId ?? resolveAgentIdFromSessionKey(options.agentSessionKey);
}

function requireOwner(options: ConversationToolOptions): void {
  if (options.senderIsOwner === false) {
    throw new ToolAuthorizationError("Conversation tools require owner access");
  }
}

function conversationMessageExecutor(
  action: "send" | "turn",
  options: ConversationToolOptions,
): AnyAgentTool["execute"] {
  return async (toolCallId, args, signal) => {
    requireOwner(options);
    const params = args as Record<string, unknown>;
    const value = readToolStringParam(params, "conversationRef", { required: true });
    const conversationRef = value.toLowerCase();
    if (!CONVERSATION_REF_PATTERN.test(conversationRef)) {
      throw new ToolInputError(`Invalid conversationRef: ${value}`);
    }
    const message = readToolStringParam(params, "message", { required: true });
    const timeoutMs =
      action === "turn" ? (readPositiveIntegerParam(params, "timeoutSeconds") ?? 30) * 1_000 : 0;
    const agentId = resolveToolAgentId(options);
    const identity = [
      agentId,
      options.agentSessionId ?? "",
      options.agentSessionKey ?? "",
      `conversations_${action}`,
      toolCallId,
      conversationRef,
    ].join("\u0000");
    const operationId = `convop_${sha256Hex(identity).slice(0, 32)}`;
    const request: Parameters<AgentToolGatewayRequestCaller>[0] = {
      method: `conversations.${action}`,
      params: {
        agentId,
        ...(options.agentSessionKey ? { sourceSessionKey: options.agentSessionKey } : {}),
        ...(action === "turn" ? { turnId: operationId } : { operationId }),
        conversationRef,
        message,
        ...(action === "turn" ? { timeoutMs } : {}),
      },
      ...(options.config ? { config: options.config } : {}),
      ...(signal ? { signal } : {}),
    };
    if (action === "turn") {
      request.timeoutMs = timeoutMs + 20_000;
      request.onSignalAbort = async (cancel) => {
        await cancel(
          "conversations.turn.cancel",
          { agentId, turnId: operationId },
          { timeoutMs: 5_000 },
        );
      };
    }
    return jsonResult(
      await callAgentToolGatewayRequest<ConversationSendResult | ConversationTurnResult>(request),
    );
  };
}

export function createConversationsListTool(options: ConversationToolOptions = {}): AnyAgentTool {
  return {
    label: "Conversations",
    name: "conversations_list",
    displaySummary: "List exact external conversation addresses.",
    description:
      "List external conversations as stable conversationRef values. Sessions hold local model context; conversationRef selects an exact external channel destination.",
    parameters: ConversationsListSchema,
    outputSchema: ConversationListResultSchema,
    execute: async (_toolCallId, args) => {
      requireOwner(options);
      const params = args as Record<string, unknown>;
      const limit = Math.min(readPositiveIntegerParam(params, "limit") ?? 50, 100);
      const channel = readToolStringParam(params, "channel");
      const query = readToolStringParam(params, "query");
      const result = await callAgentToolGatewayRequest<ConversationListResult>({
        method: "conversations.list",
        params: {
          agentId: resolveToolAgentId(options),
          limit,
          ...(channel ? { channel } : {}),
          ...(query ? { query } : {}),
        },
        ...(options.config ? { config: options.config } : {}),
      });
      return jsonResult(result);
    },
  };
}

export function createConversationsSendTool(options: ConversationToolOptions = {}): AnyAgentTool {
  return {
    label: "Conversation Send",
    name: "conversations_send",
    displaySummary: "Send to an exact external conversation.",
    description:
      "Send directly through a conversationRef. This performs channel delivery; it does not run the local agent in the backing session.",
    parameters: ConversationsSendSchema,
    outputSchema: ConversationSendResultSchema,
    execute: conversationMessageExecutor("send", options),
  };
}

export function createConversationsTurnTool(options: ConversationToolOptions = {}): AnyAgentTool {
  return {
    label: "Conversation Turn",
    name: "conversations_turn",
    displaySummary: "Send and wait for the correlated peer reply.",
    description:
      "Send through a conversationRef and wait for its correlated inbound reply. The reply returns here instead of starting a second local agent turn; unsolicited messages still start normal turns.",
    parameters: ConversationsTurnSchema,
    outputSchema: ConversationTurnResultSchema,
    execute: conversationMessageExecutor("turn", options),
  };
}
