import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
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
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

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
  if (request.sourceSessionKey) {
    const parsed = parseAgentSessionKey(request.sourceSessionKey);
    if (parsed) {
      if (normalizeAgentId(parsed.agentId) !== normalizeAgentId(request.agentId)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `agent "${request.agentId}" does not match session key agent "${parsed.agentId}"`,
          ),
        );
        return;
      }
    } else {
      const owner = resolveRequestedSessionAgentId(
        config,
        request.sourceSessionKey,
        request.agentId,
      );
      if (!owner.ok) {
        respond(false, undefined, owner.error);
        return;
      }
    }
  }
  // Gateway replay and durable delivery share the agent-scoped operation namespace.
  const operationKey = `conversations.${request.method}:${JSON.stringify([request.agentId, request.operationId])}`;
  const identityKey = `${operationKey}:identity`;
  const requestIdentity = sha256Hex(
    JSON.stringify([
      request.agentId,
      request.sourceSessionKey ?? null,
      request.conversationRef,
      request.message,
      request.method === "turn" ? request.timeoutMs : null,
    ]),
  );
  const completed = context.dedupe.get(operationKey);
  const prior = context.dedupe.get(identityKey);
  if (
    (completed && completed.requestIdentity !== requestIdentity) ||
    (prior && (!prior.ok || prior.requestIdentity !== requestIdentity))
  ) {
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
  // The bounded, TTL-pruned dedupe store also retains in-flight identity claims.
  context.dedupe.set(
    identityKey,
    prior ? { ...prior, ts: Date.now() } : { ts: Date.now(), ok: true, requestIdentity },
  );
  const inflight = resolveGatewayInflightRequest({
    context,
    dedupeKey: operationKey,
    idempotencyKey: request.operationId,
    respond,
  });
  if (inflight.kind === "handled") {
    await inflight.done;
    return;
  }
  const { dedupeKey, inflightMap } = inflight;
  let releaseRequestIdentity = false;
  const work = (async (): Promise<GatewayInflightResult> => {
    try {
      const command = {
        config,
        readCurrentConfig,
        agentId: request.agentId,
        senderIsOwner: client?.connect?.scopes?.includes(ADMIN_SCOPE) === true,
        ...(request.sourceSessionKey ? { sourceSessionKey: request.sourceSessionKey } : {}),
        conversationRef: request.conversationRef,
        message: request.message,
      };
      const payload = await (request.method === "send"
        ? runGatewayConversationSend({ ...command, operationId: request.operationId })
        : runGatewayConversationTurn({
            ...command,
            turnId: request.operationId,
            timeoutMs: request.timeoutMs,
          }));
      const result: GatewayInflightResult = {
        ok: true,
        payload,
        meta: { channel: payload.channel },
      };
      cacheGatewayDedupeResult({ context, dedupeKey, requestIdentity, result });
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
        cacheGatewayDedupeResult({ context, dedupeKey, requestIdentity, result });
      }
      return result;
    }
  })();
  try {
    await runGatewayInflightWork({ inflightMap, dedupeKey, work, respond });
  } finally {
    if (
      releaseRequestIdentity &&
      context.dedupe.get(identityKey)?.requestIdentity === requestIdentity
    ) {
      // Release conflicting speculative claims only after in-flight joins drain.
      context.dedupe.delete(identityKey);
    }
  }
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
