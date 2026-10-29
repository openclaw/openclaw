import { Check } from "typebox/value";
import {
  ErrorCodes,
  errorShape,
  validateProgressCardGetParams,
  validateProgressCardPutParams,
  validateProgressCardRefreshParams,
  type ProgressCard,
  type ProgressCardGetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  captureMemoryExactSessionReader,
  assertMemoryExactReadSource,
} from "../../config/sessions/session-accessor.memory-exact-read.js";
import { prepareSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { sameSessionTranscriptStorePath } from "../../config/sessions/transcript-store-identity.js";
import {
  captureSessionTranscriptStorageEnvironment,
  sameSessionTranscriptStorageEnvironment,
} from "../../config/sessions/transcript-target-binding.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import {
  normalizeProgressCardInput,
  ProgressCardInputError,
} from "../../session-cards/progress-card-input.js";
import {
  ProgressReconcileParamsSchema,
  normalizeProgressWorkIntent,
} from "../../session-cards/progress-card-work-intent.js";
import { captureGatewaySessionStoreScope } from "../board-store.js";
import { progressCardStore } from "../progress-card-store.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { sessionObserverScopeKey } from "../session-observer-model.js";
import { resolveRequestedSessionStoreTarget } from "../session-store-key.js";
import { retainSessionScopedRead } from "./session-scoped-read.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function resolveProgressCardSession(
  params: ProgressCardGetParams,
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
): { sessionKey: string; agentId: string; scopeKey: string } | undefined {
  const cfg = context.getRuntimeConfig();
  const requested = resolveRequestedSessionStoreTarget(cfg, params.sessionKey, params.agentId);
  if (!requested.ok) {
    respond(false, undefined, requested.error);
    return undefined;
  }
  const { sessionKey, agentId } = requested.value;
  return {
    sessionKey,
    agentId,
    scopeKey: sessionObserverScopeKey(sessionKey, agentId),
  };
}

function projectProgressCard(card: ProgressCard | null, scopeKey: string): ProgressCard | null {
  // Wire identities distinguish owners; SQLite cards reference the canonical session row.
  return card ? { ...card, sessionKey: scopeKey } : null;
}

export const progressCardHandlers: GatewayRequestHandlers = {
  "progressCard.reconcileWork": async (invocation) => {
    const { params, client, respond, context, sessionMutationAuthorization } = invocation;
    const caller = client?.internal?.agentToolCaller;
    const custody = caller?.progressWork;
    const admitted = sessionMutationAuthorization?.admittedTarget;
    if (
      !client?.internal?.syntheticClient ||
      !caller?.assertCurrent ||
      !custody?.target ||
      !invocation.sessionMutationCommitGuard ||
      !admitted
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, "Retained work requires guarded host tool custody"),
      );
      return;
    }
    if (!Check(ProgressReconcileParamsSchema, params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Invalid retained work parameters"),
      );
      return;
    }
    const session = resolveProgressCardSession(params, context, respond);
    if (!session) {
      return;
    }
    if (
      caller.agentId !== session.agentId ||
      caller.sessionKey !== session.sessionKey ||
      custody.owner.agentId !== session.agentId ||
      custody.owner.sessionKey !== session.sessionKey ||
      custody.owner.sessionId !== admitted.sessionId ||
      admitted.agentId !== session.agentId ||
      admitted.sessionKey !== session.sessionKey
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, "Retained work caller does not own this incarnation"),
      );
      return;
    }
    const assertCurrent = () => {
      invocation.signal?.throwIfAborted();
      invocation.sessionMutationCommitGuard!();
      caller.assertCurrent!();
      sessionMutationAuthorization!.assertCurrent();
    };
    try {
      const input = normalizeProgressCardInput({ markdown: params.markdown, plan: params.plan });
      const intent = normalizeProgressWorkIntent(params.work);
      assertCurrent();
      // Native acceptance keeps the original physical requester even if current
      // configuration routes an identical session incarnation to another store.
      const selected = captureGatewaySessionStoreScope(session.sessionKey, session.agentId);
      const env = captureSessionTranscriptStorageEnvironment(process.env);
      if (!sameSessionTranscriptStorageEnvironment(custody.target.env, env)) {
        throw new Error("Retained work storage environment changed");
      }
      if (isIncognitoSessionKey(session.sessionKey)) {
        const original = captureMemoryExactSessionReader(custody.target, assertCurrent);
        const current = captureMemoryExactSessionReader({ ...selected, env }, assertCurrent);
        if (!original?.source || !current?.source) {
          throw new Error("Retained memory owner unavailable");
        }
        original.assertCurrent();
        current.assertCurrent();
        assertMemoryExactReadSource(original.source, current.source);
      } else {
        const original = await prepareSqliteTargetFromSessionStorePath(
          custody.target.storePath,
          custody.target,
          invocation.signal,
        );
        const current = await prepareSqliteTargetFromSessionStorePath(
          selected.storePath,
          { ...selected, env },
          invocation.signal,
        );
        if (!sameSessionTranscriptStorePath(original.path, current.path)) {
          throw new Error("Retained work physical requester changed");
        }
      }
      assertCurrent();
      const { target: _target, ...managedWork } = custody;
      const result = await progressCardStore.put(
        session.sessionKey,
        { ...input, managedWork: { ...managedWork, intent }, assertCurrent },
        session.agentId,
      );
      assertCurrent();
      context.broadcast(
        "progressCard.changed",
        { sessionKey: session.scopeKey, revision: result.card?.revision ?? null },
        { sessionKeys: [session.sessionKey], agentId: session.agentId },
      );
      respond(
        true,
        {
          card: projectProgressCard(result.card, session.scopeKey),
          work: result.work ? { kind: "retained", state: result.work } : { kind: "none" },
        },
        undefined,
      );
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      respond(
        false,
        undefined,
        errorShape(
          error instanceof ProgressCardInputError
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
          String(error),
        ),
      );
    }
  },
  "progressCard.refresh": async (invocation) => {
    const { params, respond, context, sessionMutationAuthorization } = invocation;
    if (
      !assertValidParams(params, validateProgressCardRefreshParams, "progressCard.refresh", respond)
    ) {
      return;
    }
    const session = resolveProgressCardSession(params, context, respond);
    if (!session) {
      return;
    }
    const readCard = async () => {
      sessionMutationAuthorization?.assertCurrent();
      const card = await progressCardStore.get(session.sessionKey, session.agentId);
      sessionMutationAuthorization?.assertCurrent();
      return card;
    };
    const card = await readCard();
    if (!card) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "There is no progress card to refresh."),
      );
      return;
    }
    const { requestProgressCardRefresh } = await import("./progress-card-refresh.js");
    invocation.sessionMutationCommitGuard?.();
    sessionMutationAuthorization?.assertCurrent();
    await requestProgressCardRefresh(invocation, session, card, params.idempotencyKey, readCard);
  },
  "progressCard.get": async (options) => {
    const { params, respond, context, sessionMutationAuthorization } = options;
    if (!assertValidParams(params, validateProgressCardGetParams, "progressCard.get", respond)) {
      return;
    }
    const session = resolveProgressCardSession(params, context, respond);
    if (!session) {
      return;
    }
    // Lazy handler preparation can outlive the session authorized by the router.
    sessionMutationAuthorization?.assertCurrent();
    const read = await retainSessionScopedRead(options, session.sessionKey, session.agentId);
    try {
      const card = await progressCardStore.get(session.sessionKey, session.agentId);
      sessionMutationAuthorization?.assertCurrent();
      read?.assertCurrent();
      respond(true, { card: projectProgressCard(card, session.scopeKey) }, undefined);
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
    } finally {
      read?.release();
    }
  },
  "progressCard.put": async (invocation) => {
    const { params, respond, context, sessionMutationAuthorization } = invocation;
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
    const assertCurrent = () => {
      invocation.signal?.throwIfAborted();
      invocation.sessionMutationCommitGuard?.();
      sessionMutationAuthorization?.assertCurrent();
    };
    try {
      const result = await progressCardStore.put(
        session.sessionKey,
        {
          ...input,
          expectedRevision: params.expectedRevision,
          assertCurrent,
        },
        session.agentId,
      );
      assertCurrent();
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
