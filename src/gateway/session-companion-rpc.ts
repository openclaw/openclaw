import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  GatewayErrorDetailCodes,
  validateSessionsCompanionAskParams,
  validateSessionsCompanionResetParams,
  validateSessionsCompanionStateParams,
  type SessionsCompanionAskParams,
  type SessionsCompanionResetParams,
  type SessionsCompanionStateParams,
} from "../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";
import { SessionCompanionAskError } from "./session-companion-ask.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { hiddenSessionNotFound } from "./session-sharing-policy.js";
import { prepareSessionSharing, resolveSessionSharingTarget } from "./session-sharing.js";
import { resolveSessionStoreKey } from "./session-store-key.js";

function resolveCompanionTarget(
  params: { sessionKey: string; agentId?: string | undefined },
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
) {
  const cfg = context.getRuntimeConfig();
  const requested = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);
  if (!requested.ok) {
    return requested;
  }
  return {
    ok: true as const,
    agentId: requested.agentId,
    sessionKey: resolveSessionStoreKey({
      cfg,
      sessionKey: params.sessionKey,
      storeAgentId: requested.agentId,
    }),
  };
}

function companionTargetIsVisible(
  target: { sessionKey: string; agentId: string },
  client: Parameters<GatewayRequestHandlers[string]>[0]["client"],
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
): boolean {
  if (client?.connId && context.isConnectionActive?.(client.connId) === false) {
    return false;
  }
  const cfg = context.getRuntimeConfig();
  const sharingTarget = resolveSessionSharingTarget({
    cfg,
    sessionKey: target.sessionKey,
    agentId: target.agentId,
  });
  if (!sharingTarget) {
    // A roles boundary requires a persisted ownership record; solo gateways
    // retain the companion service's existing missing-session handling.
    return cfg.gateway?.roles === undefined;
  }
  const entryFilter = prepareSessionSharing({ client, cfg }).entryFilter;
  return entryFilter?.(sharingTarget.storeKey, sharingTarget.entry) !== false;
}

export const sessionCompanionHandlers: GatewayRequestHandlers = {
  "sessions.companion.ask": async ({ params, respond, client, context, signal }) => {
    if (!validateSessionsCompanionAskParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.companion.ask params: ${formatValidationErrors(validateSessionsCompanionAskParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, agentId, question } = params as SessionsCompanionAskParams;
    if (!question.trim()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "question must contain non-whitespace text"),
      );
      return;
    }
    if (!client?.connId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, "Side chat questions require a connected client."),
      );
      return;
    }
    if (!context.sessionCompanion) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Side chat is unavailable."));
      return;
    }
    const target = resolveCompanionTarget({ sessionKey, agentId }, context);
    if (!target.ok) {
      respond(false, undefined, target.error);
      return;
    }
    if (!companionTargetIsVisible(target, client, context)) {
      respond(false, undefined, hiddenSessionNotFound(target.sessionKey));
      return;
    }
    try {
      const result = await context.sessionCompanion.ask({
        sessionKey: target.sessionKey,
        agentId: target.agentId,
        question,
        connId: client.connId,
        authorize: () => companionTargetIsVisible(target, client, context),
        ...(signal ? { signal } : {}),
      });
      respond(true, result);
    } catch (error) {
      if (!(error instanceof SessionCompanionAskError)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "Side chat could not answer right now."),
        );
        return;
      }
      if (error.reason === "busy") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, error.message, {
            details: { code: GatewayErrorDetailCodes.SESSION_COMPANION_BUSY },
            retryable: true,
          }),
        );
        return;
      }
      const retryable = error.reason === "rate-limited" || error.reason === "context-unavailable";
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, error.message, {
          details: { reason: error.reason },
          retryable,
          ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
        }),
      );
    }
  },
  "sessions.companion.state": ({ params, respond, client, context }) => {
    if (!validateSessionsCompanionStateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.companion.state params: ${formatValidationErrors(validateSessionsCompanionStateParams.errors)}`,
        ),
      );
      return;
    }
    if (!context.sessionCompanion) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Side chat is unavailable."));
      return;
    }
    const { sessionKey, agentId } = params as SessionsCompanionStateParams;
    const target = resolveCompanionTarget({ sessionKey, agentId }, context);
    if (!target.ok) {
      respond(false, undefined, target.error);
      return;
    }
    if (!companionTargetIsVisible(target, client, context)) {
      respond(false, undefined, hiddenSessionNotFound(target.sessionKey));
      return;
    }
    respond(
      true,
      context.sessionCompanion.state({
        agentId: target.agentId,
        sessionKey: target.sessionKey,
      }),
    );
  },

  "sessions.companion.reset": ({ params, respond, context }) => {
    if (!validateSessionsCompanionResetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.companion.reset params: ${formatValidationErrors(validateSessionsCompanionResetParams.errors)}`,
        ),
      );
      return;
    }
    if (!context.sessionCompanion) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Side chat is unavailable."));
      return;
    }
    const { sessionKey, agentId } = params as SessionsCompanionResetParams;
    const target = resolveCompanionTarget({ sessionKey, agentId }, context);
    if (!target.ok) {
      respond(false, undefined, target.error);
      return;
    }
    context.sessionCompanion.reset({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
    });
    respond(true, { ok: true });
  },
};
