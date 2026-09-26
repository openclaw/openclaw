import { createHash } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  type ConversationSendParams,
  validateConversationListParams,
  validateConversationSendParams,
  validateConversationTurnCancelParams,
  validateConversationTurnParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { cancelPendingConversationTurn } from "../../sessions/conversation-turns.js";
import {
  ConversationInputError,
  ConversationOperationConflictError,
} from "../conversation-errors.js";
import { runGatewayConversationList } from "../conversation-list.js";
import { runGatewayConversationSend } from "../conversation-send.js";
import { runGatewayConversationTurn } from "../conversation-turn.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { formatForLog } from "../ws-log.js";
import {
  cacheGatewayDedupeResult,
  resolveGatewayInflightRequest,
  runGatewayInflightWork,
  type GatewayInflightResult,
} from "./inflight.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

function isAuthenticatedOwner(client: GatewayClient | null): boolean {
  // These RPCs require operator.admin. Derive owner status from the admitted
  // socket anyway so no future schema field can self-assert channel authority.
  return client?.connect?.scopes?.includes(ADMIN_SCOPE) === true;
}

function validateConversationSourceSession(params: {
  config: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
  agentId: string;
  sourceSessionKey?: string;
  respond: RespondFn;
}): boolean {
  if (!params.sourceSessionKey) {
    return true;
  }
  const parsed = parseAgentSessionKey(params.sourceSessionKey);
  if (parsed) {
    if (normalizeAgentId(parsed.agentId) === normalizeAgentId(params.agentId)) {
      return true;
    }
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `agent "${params.agentId}" does not match session key agent "${parsed.agentId}"`,
      ),
    );
    return false;
  }
  const owner = resolveRequestedSessionAgentId(
    params.config,
    params.sourceSessionKey,
    params.agentId,
  );
  if (owner.ok) {
    return true;
  }
  params.respond(false, undefined, owner.error);
  return false;
}

function conversationOperationKey(params: {
  method: "send" | "turn";
  agentId: string;
  operationId: string;
}): string {
  // Delivery state is agent-scoped, so Gateway replay and in-flight joins must
  // use the same namespace. Otherwise equal client operation IDs cross agents.
  return `conversations.${params.method}:${JSON.stringify([params.agentId, params.operationId])}`;
}

function bindConversationOperationIdentity(
  context: GatewayRequestContext,
  request: {
    method: "send" | "turn";
    operationId: string;
    agentId: string;
    sourceSessionKey?: string;
    conversationRef: string;
    message: string;
    timeoutMs?: number;
  },
): string | null {
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        request.agentId,
        request.sourceSessionKey ?? null,
        request.conversationRef,
        request.message,
        request.timeoutMs ?? null,
      ]),
    )
    .digest("hex");
  const operationKey = conversationOperationKey(request);
  const identityKey = `${operationKey}:identity`;
  const completed = context.dedupe.get(operationKey);
  if (completed && completed.requestIdentity !== identity) {
    return null;
  }
  const prior = context.dedupe.get(identityKey);
  if (prior) {
    if (!prior.ok || prior.requestIdentity !== identity) {
      return null;
    }
    context.dedupe.set(identityKey, { ...prior, ts: Date.now() });
    return identity;
  }
  // Share the Gateway's bounded, TTL-pruned dedupe store so identity claims
  // cover in-flight work without creating another unbounded lifecycle.
  context.dedupe.set(identityKey, { ts: Date.now(), ok: true, requestIdentity: identity });
  return identity;
}

function releaseConversationOperationIdentity(params: {
  context: GatewayRequestContext;
  operationKey: string;
  requestIdentity: string;
}): void {
  const identityKey = `${params.operationKey}:identity`;
  if (params.context.dedupe.get(identityKey)?.requestIdentity === params.requestIdentity) {
    params.context.dedupe.delete(identityKey);
  }
}

async function runConversationOperation(params: {
  context: GatewayRequestContext;
  respond: RespondFn;
  dedupeKey: string;
  operationId: string;
  requestIdentity: string;
  execute: () => Promise<{ channel: string }>;
}): Promise<void> {
  const inflight = resolveGatewayInflightRequest({
    context: params.context,
    dedupeKey: params.dedupeKey,
    idempotencyKey: params.operationId,
    respond: params.respond,
  });
  if (inflight.kind === "handled") {
    await inflight.done;
    return;
  }
  const { dedupeKey, inflightMap } = inflight;
  let releaseRequestIdentity = false;
  const work = (async (): Promise<GatewayInflightResult> => {
    try {
      const payload = await params.execute();
      const result: GatewayInflightResult = {
        ok: true,
        payload,
        meta: { channel: payload.channel },
      };
      cacheGatewayDedupeResult({
        context: params.context,
        dedupeKey,
        requestIdentity: params.requestIdentity,
        result,
      });
      return result;
    } catch (cause) {
      const isTerminalInputError = cause instanceof ConversationInputError;
      const isOperationConflict = cause instanceof ConversationOperationConflictError;
      const error = errorShape(
        isTerminalInputError ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
        cause instanceof Error ? cause.message : String(cause),
      );
      const result: GatewayInflightResult = {
        ok: false,
        error,
        meta: { error: formatForLog(cause) },
      };
      if (isOperationConflict) {
        releaseRequestIdentity = true;
      } else if (isTerminalInputError) {
        cacheGatewayDedupeResult({
          context: params.context,
          dedupeKey,
          requestIdentity: params.requestIdentity,
          result,
        });
      }
      return result;
    }
  })();
  try {
    await runGatewayInflightWork({ inflightMap, dedupeKey, work, respond: params.respond });
  } finally {
    if (releaseRequestIdentity) {
      // The durable row belongs to another request. Release this speculative
      // claim after in-flight joins drain so its authoritative identity can retry.
      releaseConversationOperationIdentity({
        context: params.context,
        operationKey: dedupeKey,
        requestIdentity: params.requestIdentity,
      });
    }
  }
}

async function handleConversationWrite(
  {
    context,
    client,
    respond,
  }: Pick<GatewayRequestHandlerOptions, "context" | "client" | "respond">,
  request: ConversationSendParams & ({ method: "send" } | { method: "turn"; timeoutMs: number }),
): Promise<void> {
  const readCurrentConfig = () => context.getRuntimeConfig();
  const config = readCurrentConfig();
  if (!validateConversationSourceSession({ ...request, config, respond })) {
    return;
  }
  const requestIdentity = bindConversationOperationIdentity(context, request);
  if (!requestIdentity) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `conversation ${request.method} ${request.operationId} was already used with different input`,
      ),
    );
    return;
  }
  await runConversationOperation({
    context,
    dedupeKey: conversationOperationKey(request),
    operationId: request.operationId,
    requestIdentity,
    respond,
    execute: () => {
      const command = {
        config,
        readCurrentConfig,
        agentId: request.agentId,
        senderIsOwner: isAuthenticatedOwner(client),
        ...(request.sourceSessionKey ? { sourceSessionKey: request.sourceSessionKey } : {}),
        conversationRef: request.conversationRef,
        message: request.message,
      };
      return request.method === "send"
        ? runGatewayConversationSend({ ...command, operationId: request.operationId })
        : runGatewayConversationTurn({
            ...command,
            turnId: request.operationId,
            timeoutMs: request.timeoutMs,
          });
    },
  });
}

export const conversationHandlers: GatewayRequestHandlers = {
  "conversations.list": defineValidatedGatewayMethod(
    "conversations.list",
    validateConversationListParams,
    async ({ params: request, respond, context }) => {
      const readCurrentConfig = () => context.getRuntimeConfig();
      try {
        respond(
          true,
          await runGatewayConversationList({
            config: readCurrentConfig(),
            readCurrentConfig,
            agentId: request.agentId,
            ...(request.channel ? { channel: request.channel } : {}),
            ...(request.query ? { query: request.query } : {}),
            limit: request.limit ?? 50,
          }),
          undefined,
        );
      } catch (cause) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            cause instanceof Error ? cause.message : String(cause),
          ),
        );
      }
    },
  ),
  "conversations.send": defineValidatedGatewayMethod(
    "conversations.send",
    validateConversationSendParams,
    (options) => handleConversationWrite(options, { ...options.params, method: "send" }),
  ),
  "conversations.turn.cancel": defineValidatedGatewayMethod(
    "conversations.turn.cancel",
    validateConversationTurnCancelParams,
    ({ params: request, respond }) => {
      respond(
        true,
        {
          cancelled: cancelPendingConversationTurn({
            agentId: request.agentId,
            id: request.turnId,
          }),
        },
        undefined,
      );
    },
  ),
  "conversations.turn": defineValidatedGatewayMethod(
    "conversations.turn",
    validateConversationTurnParams,
    (options) =>
      handleConversationWrite(options, {
        ...options.params,
        operationId: options.params.turnId,
        method: "turn",
      }),
  ),
};
