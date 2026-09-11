import {
  ErrorCodes,
  errorShape,
  validateProgressCardGetParams,
  validateProgressCardPutParams,
  type ProgressCard,
  type ProgressCardGetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  normalizeProgressCardInput,
  ProgressCardInputError,
} from "../../session-cards/progress-card-input.js";
import { progressCardStore, type ProgressCardStore } from "../progress-card-store.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { sessionObserverScopeKey } from "../session-observer-model.js";
import {
  resolveRequestedSessionAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import { resolveSessionStoreKey } from "../session-store-key.js";
import { loadSessionEntry } from "../session-utils.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

type ProgressCardSession = { sessionKey: string; agentId: string; scopeKey: string };

export type ProgressCardRunActivity = (params: {
  context: GatewayRequestContext;
  requestedKey: string;
  session: ProgressCardSession;
}) => boolean;

/** Fails closed: an unreadable session keeps its unfinished checklist protected. */
const hasActiveProgressCardRun: ProgressCardRunActivity = ({ context, requestedKey, session }) => {
  let sessionId: string | undefined;
  try {
    sessionId = loadSessionEntry(session.sessionKey, { agentId: session.agentId }).entry?.sessionId;
  } catch {
    return true;
  }
  return resolveVisibleActiveSessionRunState({
    context,
    requestedKey,
    canonicalKey: session.sessionKey,
    ...(sessionId ? { sessionId } : {}),
    agentId: session.agentId,
    defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(
      context.getRuntimeConfig(),
      session.sessionKey,
    ),
  }).active;
};

function resolveProgressCardSession(
  params: ProgressCardGetParams,
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
): ProgressCardSession | undefined {
  const cfg = context.getRuntimeConfig();
  const requested = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);
  if (!requested.ok) {
    respond(false, undefined, requested.error);
    return undefined;
  }
  const canonicalKey = resolveSessionStoreKey({
    cfg,
    sessionKey: params.sessionKey,
    storeAgentId: requested.agentId,
  });
  return {
    sessionKey: canonicalKey,
    agentId: requested.agentId,
    scopeKey: sessionObserverScopeKey(canonicalKey, requested.agentId),
  };
}

function projectProgressCard(card: ProgressCard | null, scopeKey: string): ProgressCard | null {
  // Wire identities distinguish owners; SQLite cards reference the canonical session row.
  return card ? { ...card, sessionKey: scopeKey } : null;
}

export function createProgressCardHandlers(
  store: ProgressCardStore = progressCardStore,
  hasActiveRun: ProgressCardRunActivity = hasActiveProgressCardRun,
): GatewayRequestHandlers {
  return {
    "progressCard.get": async ({ params, respond, context, sessionMutationAuthorization }) => {
      if (!assertValidParams(params, validateProgressCardGetParams, "progressCard.get", respond)) {
        return;
      }
      const session = resolveProgressCardSession(params, context, respond);
      if (!session) {
        return;
      }
      // Lazy handler preparation can outlive the session authorized by the router.
      sessionMutationAuthorization?.assertCurrent();
      try {
        const card = await store.get(session.sessionKey, session.agentId);
        sessionMutationAuthorization?.assertCurrent();
        respond(true, { card: projectProgressCard(card, session.scopeKey) }, undefined);
      } catch (error) {
        if (error instanceof SessionMutationAuthorizationChangedError) {
          throw error;
        }
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
    },
    "progressCard.put": async ({ params, respond, context, sessionMutationAuthorization }) => {
      if (!assertValidParams(params, validateProgressCardPutParams, "progressCard.put", respond)) {
        return;
      }
      let input;
      try {
        input = normalizeProgressCardInput({ markdown: params.markdown, plan: params.plan });
      } catch (error) {
        if (!(error instanceof ProgressCardInputError)) {
          throw error;
        }
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
      if (params.expectedRevision !== undefined && (input.markdown || input.steps?.length)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "expectedRevision is only valid when clearing a card",
          ),
        );
        return;
      }
      const session = resolveProgressCardSession(params, context, respond);
      if (!session) {
        return;
      }
      sessionMutationAuthorization?.assertCurrent();
      try {
        // Durable progress can outlive an interrupted run. An unfinished checklist is
        // dismissible once no run owns the session; the revision check rejects a clear
        // that races a newer write.
        const allowIncomplete =
          params.expectedRevision !== undefined &&
          !hasActiveRun({ context, requestedKey: params.sessionKey, session });
        const result = await store.put(
          session.sessionKey,
          {
            ...input,
            expectedRevision: params.expectedRevision,
            ...(allowIncomplete ? { allowIncomplete } : {}),
            ...(sessionMutationAuthorization
              ? { assertCurrent: sessionMutationAuthorization.assertCurrent }
              : {}),
          },
          session.agentId,
        );
        sessionMutationAuthorization?.assertCurrent();
        if (params.expectedRevision === undefined || result.card === null) {
          context.broadcast(
            "progressCard.changed",
            {
              sessionKey: session.scopeKey,
              revision: result.card?.revision ?? null,
            },
            { sessionKeys: [session.sessionKey], agentId: session.agentId },
          );
        }
        respond(true, { card: projectProgressCard(result.card, session.scopeKey) }, undefined);
      } catch (error) {
        if (error instanceof SessionMutationAuthorizationChangedError) {
          throw error;
        }
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
    },
  };
}

export const progressCardHandlers = createProgressCardHandlers();
