import { createHash } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateConversationTurnCancelParams,
  validateConversationTurnParams,
  type ConversationTurnCancelParams,
  type ConversationTurnParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { cancelPendingConversationTurn } from "../../sessions/conversation-turns.js";
import { ConversationTurnInputError, runGatewayConversationTurn } from "../conversation-turn.js";
import { resolveGatewayPluginConfig } from "../runtime-plugin-config.js";
import { formatForLog } from "../ws-log.js";
import {
  cacheGatewayDedupeResult,
  resolveGatewayInflightRequest,
  runGatewayInflightWork,
  type GatewayInflightResult,
} from "./inflight.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

type ConversationHandlerDeps = {
  cancelConversationTurn: typeof cancelPendingConversationTurn;
  runConversationTurn: typeof runGatewayConversationTurn;
};

function bindConversationTurnIdentity(
  context: GatewayRequestContext,
  request: ConversationTurnParams,
): string | null {
  // timeoutMs is only the caller's wait budget; effectful input binds the id.
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        request.agentId,
        request.sourceSessionKey ?? null,
        request.conversationRef,
        request.message,
      ]),
    )
    .digest("hex");
  const identityKey = `conversations.turn-identity:${request.turnId}`;
  const completed = context.dedupe.get(`conversations.turn:${request.turnId}`);
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

export function createConversationHandlers(
  deps: ConversationHandlerDeps = {
    cancelConversationTurn: cancelPendingConversationTurn,
    runConversationTurn: runGatewayConversationTurn,
  },
): GatewayRequestHandlers {
  return {
    "conversations.turn.cancel": ({ params, respond }) => {
      if (!validateConversationTurnCancelParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid conversations.turn.cancel params: ${formatValidationErrors(validateConversationTurnCancelParams.errors)}`,
          ),
        );
        return;
      }
      const request = params as ConversationTurnCancelParams;
      respond(true, { cancelled: deps.cancelConversationTurn(request.turnId) }, undefined);
    },
    "conversations.turn": async ({ params, respond, context }) => {
      if (!validateConversationTurnParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid conversations.turn params: ${formatValidationErrors(validateConversationTurnParams.errors)}`,
          ),
        );
        return;
      }
      const request = params as ConversationTurnParams;
      const requestIdentity = bindConversationTurnIdentity(context, request);
      if (!requestIdentity) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `conversation turn ${request.turnId} was already used with different input`,
          ),
        );
        return;
      }
      const inflight = resolveGatewayInflightRequest({
        context,
        dedupeKey: `conversations.turn:${request.turnId}`,
        idempotencyKey: request.turnId,
        respond,
      });
      if (inflight.kind === "handled") {
        await inflight.done;
        return;
      }
      const { dedupeKey, inflightMap } = inflight;
      const work = (async (): Promise<GatewayInflightResult> => {
        try {
          const payload = await deps.runConversationTurn({
            config: resolveGatewayPluginConfig({ config: context.getRuntimeConfig() }),
            agentId: request.agentId,
            ...(request.sourceSessionKey ? { sourceSessionKey: request.sourceSessionKey } : {}),
            turnId: request.turnId,
            conversationRef: request.conversationRef,
            message: request.message,
            timeoutMs: request.timeoutMs,
          });
          const result: GatewayInflightResult = {
            ok: true,
            payload,
            meta: { channel: payload.channel },
          };
          cacheGatewayDedupeResult({ context, dedupeKey, requestIdentity, result });
          return result;
        } catch (cause) {
          const isTerminalInputError = cause instanceof ConversationTurnInputError;
          const error = errorShape(
            isTerminalInputError ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
            cause instanceof Error ? cause.message : String(cause),
          );
          const result: GatewayInflightResult = {
            ok: false,
            error,
            meta: { error: formatForLog(cause) },
          };
          if (isTerminalInputError) {
            cacheGatewayDedupeResult({ context, dedupeKey, requestIdentity, result });
          }
          return result;
        }
      })();
      await runGatewayInflightWork({ inflightMap, dedupeKey, work, respond });
    },
  };
}

export const conversationHandlers = createConversationHandlers();
