import { isDeepStrictEqual } from "node:util";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { isMainSessionRecoveryReconciliationCandidate } from "../../agents/main-session-recovery/main-session-recovery-state.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import {
  lookupSessionGoalOperation,
  SessionGoalOperationError,
} from "../../config/sessions/goals-operations.js";
import { SESSION_ROUTING_CHANGED_ERROR_REASON } from "../../config/sessions/main-session.js";
import {
  loadExactSessionEntryCandidates,
  readSessionSubmittedInput,
} from "../../config/sessions/session-accessor.js";
import { isSessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { chatAbortMarkerTimestampMs } from "../server-chat-state.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX, type DedupeEntry } from "../server-shared.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { loadSessionEntry, resolveGatewaySessionStoreTarget } from "../session-utils.js";
import { resolveSessionWorkerPlacementContext } from "../session-worker-placement-context.js";
import { formatForLog } from "../ws-log.js";
import {
  buildAbortedChatSendPayload,
  readPreRegisteredRun,
  resolveChatAbortRequester,
} from "./chat-abort-authorization.js";
import {
  abortChatRunsForSessionKeyWithPartials,
  descendantAbortError,
} from "./chat-abort-runtime.js";
import {
  abortedPartialPersistenceError,
  withAbortedPartialPersistenceWarning,
} from "./chat-aborted-partial.js";
import { hasRestartRecoveryTerminalRun, resolveDurableChatClaim } from "./chat-restart-recovery.js";
import {
  ACTIVE_LEAF_CHANGED_ERROR_REASON,
  assertExpectedLeafActive,
} from "./chat-send-active-leaf.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import {
  captureAdmittedChatSendSessionSettings,
  SESSION_SETTINGS_CHANGED_ERROR_REASON,
} from "./chat-send-session-settings.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { resolveChatSendStopOwnerScope } from "./chat-send-stop-owner-scope.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function respondChatSessionRoutingChanged(respond: GatewayRequestHandlerOptions["respond"]) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "session routing changed; review and retry", {
      details: { reason: SESSION_ROUTING_CHANGED_ERROR_REASON },
    }),
  );
}

export function respondChatSendAdmissionError(
  error: unknown,
  respond: GatewayRequestHandlerOptions["respond"],
): void {
  if (error instanceof Error && error.message === "goal-session-busy") {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "This session still has active or queued work. Wait for it to finish, then retry the Goal.",
        { retryable: true, details: { reason: "goal-session-busy" } },
      ),
    );
    return;
  }
  if (error instanceof Error && error.message === SESSION_ROUTING_CHANGED_ERROR_REASON) {
    respondChatSessionRoutingChanged(respond);
    return;
  }
  if (error instanceof Error && error.message === ACTIVE_LEAF_CHANGED_ERROR_REASON) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "active branch changed; review and retry", {
        details: { reason: ACTIVE_LEAF_CHANGED_ERROR_REASON },
      }),
    );
    return;
  }
  if (error instanceof Error && error.message === SESSION_SETTINGS_CHANGED_ERROR_REASON) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Session settings changed before send. Retry.", {
        details: { reason: SESSION_SETTINGS_CHANGED_ERROR_REASON },
      }),
    );
    return;
  }
  if (isSessionTranscriptProjectionUnavailableError(error)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "session transcript is rebuilding; retry shortly", {
        details: { method: "chat.send" },
        retryable: true,
        retryAfterMs: 250,
      }),
    );
    return;
  }
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(error)));
}

type ChatSendPreAdmissionParams = {
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  respond: GatewayRequestHandlerOptions["respond"];
  context: GatewayRequestHandlerOptions["context"];
  client: GatewayRequestHandlerOptions["client"];
  assertCurrent?: () => void;
};

type ChatSendRetryParams = {
  assertCurrent?: () => void;
  request: Pick<
    NormalizedChatSendRequest,
    "goalOperation" | "requestIdentity" | "rawMessage" | "mentions" | "workContext"
  >;
  session: Pick<
    PreparedChatSendSession,
    | "clientRunId"
    | "pendingChatSendKey"
    | "entry"
    | "restartSafeRequest"
    | "agentId"
    | "sessionKey"
    | "storePath"
  >;
  context: Pick<
    GatewayRequestHandlerOptions["context"],
    "dedupe" | "chatRunState" | "chatAbortControllers" | "chatQueuedTurns"
  >;
  respond: GatewayRequestHandlerOptions["respond"];
};

/** A retained request identity is not an ACK; only response-bearing rows may replay. */
export function readChatSendDedupeResponse(
  dedupe: Map<string, DedupeEntry>,
  runId: string,
): DedupeEntry | undefined {
  const entry = dedupe.get(`chat:${runId}`);
  return entry?.requestIdentity &&
    entry.ok &&
    entry.payload === undefined &&
    entry.error === undefined
    ? undefined
    : entry;
}

export function resolveChatSendRequestConflict({
  request,
  session,
  context,
}: Omit<ChatSendRetryParams, "respond">) {
  if (request.goalOperation) {
    return undefined;
  }
  const entries = [
    context.dedupe.get(`chat:${session.clientRunId}`),
    context.dedupe.get(session.pendingChatSendKey),
  ];
  const conflict = (unverifiable = false) =>
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      unverifiable
        ? "The previous mention selections cannot be verified. Check the conversation history and use a new message ID to send again."
        : "This message ID was already used for different input. Check the conversation history and use a new message ID to send again.",
      { details: { reason: "chat-request-conflict" } },
    );
  if (
    entries.some(
      (entry) =>
        entry?.requestIdentity !== undefined && entry.requestIdentity !== request.requestIdentity,
    )
  ) {
    return conflict();
  }
  const sameDurableSource =
    session.entry?.restartRecoveryDeliverySourceRunId === session.clientRunId;
  const storedFingerprint = sameDurableSource
    ? session.entry?.restartRecoveryDeliveryRequestFingerprint
    : undefined;
  if (storedFingerprint !== undefined) {
    return storedFingerprint === session.restartSafeRequest?.fingerprint ? undefined : conflict();
  }
  if (
    sameDurableSource &&
    (request.mentions?.length || request.workContext) &&
    !session.restartSafeRequest
  ) {
    return conflict(true);
  }
  if (entries.some((entry) => entry?.requestIdentity === request.requestIdentity)) {
    return undefined;
  }
  const knownRetry =
    entries.some(Boolean) ||
    sameDurableSource ||
    hasRestartRecoveryTerminalRun(session.entry, session.clientRunId) ||
    context.chatRunState.hasAbortMarker(session.clientRunId) ||
    context.chatAbortControllers.has(session.clientRunId) ||
    context.chatQueuedTurns?.has(session.clientRunId);
  if (!knownRetry) {
    return undefined;
  }
  // Terminal tombstones outlive the RAM fingerprint. Read the exact submitted source,
  // including collected inputs, never infer mention identity from aggregate history.
  const submitted = session.entry?.sessionId
    ? readSessionSubmittedInput(
        {
          agentId: session.agentId,
          sessionId: session.entry.sessionId,
          sessionKey: session.sessionKey,
          storePath: session.storePath,
        },
        `${session.clientRunId}:user`,
      )
    : undefined;
  if (!submitted) {
    return request.mentions?.length || request.workContext ? conflict(true) : undefined;
  }
  const storedMentions = submitted["__openclaw"]?.humanMentions;
  const storedContext = submitted["__openclaw"]?.workContext;
  if (
    !request.mentions?.length &&
    !storedMentions?.length &&
    !request.workContext &&
    !storedContext
  ) {
    return undefined;
  }
  const storedText =
    extractTextFromChatContent(submitted.content, {
      joinWith: "\n",
      normalizeText: (text) => text,
    }) ?? "";
  return storedText !== request.rawMessage ||
    !isDeepStrictEqual(storedMentions ?? [], request.mentions ?? []) ||
    !isDeepStrictEqual(storedContext, request.workContext)
    ? conflict()
    : undefined;
}

/** Recheck at each admission yield before accepting a cached or concurrent request. */
export function respondChatSendRetry(params: ChatSendRetryParams): boolean {
  params.assertCurrent?.();
  const { session, context, respond } = params;
  const { clientRunId, pendingChatSendKey } = session;
  const conflict = resolveChatSendRequestConflict(params);
  if (conflict) {
    respond(false, undefined, conflict);
    return true;
  }
  const cached = readChatSendDedupeResponse(context.dedupe, clientRunId);
  if (cached) {
    respond(cached.ok, cached.payload, cached.error, { cached: true });
    return true;
  }
  const abortMarker = context.chatRunState.runs.get(clientRunId)?.abortMarker;
  if (abortMarker !== undefined) {
    const abortedAt = chatAbortMarkerTimestampMs(abortMarker);
    const payload = buildAbortedChatSendPayload({ runId: clientRunId, endedAt: abortedAt });
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `chat:${clientRunId}`,
      entry: { ts: abortedAt, ok: true, payload },
    });
    respond(true, payload, undefined, { cached: true, runId: clientRunId });
    return true;
  }
  const pending = readPreRegisteredRun({
    key: pendingChatSendKey,
    entry: context.dedupe.get(pendingChatSendKey),
    keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
  });
  if (
    pending ||
    context.chatAbortControllers.has(clientRunId) ||
    context.chatQueuedTurns?.has(clientRunId)
  ) {
    respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
      cached: true,
      runId: clientRunId,
    });
    return true;
  }
  return false;
}

/** Recheck synchronously at reservation: recovery lookups can yield to a competing request. */
export function inspectGoalChatSendRetry({
  request,
  session,
  respond,
  context,
  durableClaimAccepted,
  assertCurrent,
}: ChatSendPreAdmissionParams & { durableClaimAccepted?: boolean }) {
  assertCurrent?.();
  const { sessionKey, storePath, entry, clientRunId, pendingChatSendKey } = session;
  if (!request.goalOperation) {
    return { kind: "new" } as const;
  }
  try {
    const receipt = lookupSessionGoalOperation({
      sessionKey,
      storePath,
      agentId: session.agentId,
      expectedSessionId: entry?.sessionId ?? session.backingSessionId ?? clientRunId,
      operation: request.goalOperation,
    });
    if (receipt) {
      return { kind: "replay", receipt } as const;
    }
    const pending = readPreRegisteredRun({
      key: pendingChatSendKey,
      entry: context.dedupe.get(pendingChatSendKey),
      keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
    });
    if (
      pending?.payload.goalFingerprint === request.goalOperation.requestFingerprint ||
      (!pending && !durableClaimAccepted && context.chatAbortControllers.has(clientRunId))
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Goal is being admitted; retry the same request.", {
          retryable: true,
        }),
      );
      return { kind: "settled" } as const;
    }
    if (
      pending ||
      durableClaimAccepted ||
      context.dedupe.has(`chat:${clientRunId}`) ||
      context.chatRunState.hasAbortMarker(clientRunId) ||
      context.chatAbortControllers.has(clientRunId) ||
      context.chatQueuedTurns?.has(clientRunId)
    ) {
      throw new SessionGoalOperationError(
        "operation-conflict",
        "Goal operation ID is already used by another request.",
      );
    }
    return { kind: "new" } as const;
  } catch (error) {
    if (!(error instanceof SessionGoalOperationError)) {
      throw error;
    }
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
        details: { reason: `goal-${error.code}` },
      }),
    );
    return { kind: "settled" } as const;
  }
}

/** Settle stop/retry/dedupe cases before reserving lifecycle admission. */
export async function runChatSendPreAdmission(
  params: ChatSendPreAdmissionParams,
): Promise<boolean> {
  params.assertCurrent?.();
  const { request, session, respond, context, client } = params;
  const { stopCommand } = request;
  const {
    cfg,
    entry,
    sessionKey,
    rawSessionKey,
    sessionLoadKey,
    selectedAgent,
    clientRunId,
    sessionLoadOptions,
    storePath,
    legacyKey,
    sessionRoutingChanged,
  } = session;

  const sendPolicy = resolveSendPolicy({
    cfg,
    entry,
    sessionKey,
    channel: sessionDeliveryChannel(entry),
    chatType: entry?.chatType,
  });
  if (sendPolicy === "deny") {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
    );
    return false;
  }

  if (request.goalOperation) {
    const retry = inspectGoalChatSendRetry(params);
    if (retry.kind === "settled") {
      return false;
    }
    if (retry.kind === "replay") {
      // Let the existing recovery owner wake an interrupted admission before replaying its
      // original result. A receipt never creates another Goal or another human turn.
      const claim = await resolveDurableChatClaim({
        canonicalSessionKey: sessionKey,
        cfg,
        clientRunId,
        entry,
        persistedSessionKey: legacyKey ?? sessionKey,
        reloadEntry: () => loadSessionEntry(sessionLoadKey, sessionLoadOptions).entry,
        storePath,
        recoveryRuntime: context.recoveryRuntime,
        warn: (message) => context.logGateway.warn(message),
      });
      params.assertCurrent?.();
      if (claim.kind === "pending" || claim.kind === "rejected") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, claim.message, {
            retryable: claim.kind === "pending",
          }),
        );
      } else {
        respond(true, { ...retry.receipt, replayed: true }, undefined, {
          cached: true,
          runId: clientRunId,
        });
      }
      return false;
    }
  }

  if (stopCommand) {
    if (sessionRoutingChanged(cfg)) {
      respondChatSessionRoutingChanged(respond);
      return false;
    }
    const stopOwnerScope = resolveChatSendStopOwnerScope({
      cfg,
      selectedAgentId: selectedAgent.agentId,
      sessionKey,
    });
    const stopStorePath = session.readSource?.path ?? storePath;
    const guard: { failure?: { error: unknown } } = {};
    const assertCurrent = () => {
      if (guard.failure) {
        throw guard.failure.error;
      }
      try {
        params.assertCurrent?.();
        if (request.p.queueMode !== "steer" && session.expectedLeafEntryId !== undefined) {
          assertExpectedLeafActive(
            {
              canonicalKey: sessionKey,
              storePath: stopStorePath,
              entry: loadExactSessionEntryCandidates({
                ...(session.readSource
                  ? { readSource: session.readSource }
                  : { storePath: stopStorePath, agentId: session.agentId }),
                sessionKeys: [sessionKey],
                readOnly: true,
              })[0]?.entry,
            },
            session.agentId,
            session.expectedLeafEntryId,
            session.requestedSessionId,
          );
        }
      } catch (error) {
        guard.failure = { error };
        throw error;
      }
    };
    let res: Awaited<ReturnType<typeof abortChatRunsForSessionKeyWithPartials>>;
    try {
      assertCurrent();
      res = await abortChatRunsForSessionKeyWithPartials({
        context,
        ops: createChatAbortOps(context),
        sessionKey,
        sessionKeyAliases: sessionKey === rawSessionKey ? undefined : [rawSessionKey],
        agentId: stopOwnerScope.agentId,
        sessionId: entry?.sessionId,
        session: {
          ok: true,
          value: {
            cfg,
            storePath: stopStorePath,
            entry,
            canonicalKey: sessionKey,
            agentId: session.agentId,
          },
        },
        defaultAgentId: stopOwnerScope.defaultAgentId,
        abortOrigin: "stop-command",
        stopReason: "stop",
        requester: resolveChatAbortRequester(client),
        assertCurrent,
        cascadeDescendants: true,
      });
      // Descendant cancellation aggregates errors; preserve the admission reason.
      if (guard.failure) {
        throw abortedPartialPersistenceError(guard.failure.error, res.warning);
      }
    } catch (error) {
      const admissionError = guard.failure ? guard.failure.error : error;
      if (admissionError instanceof SessionMutationAuthorizationChangedError) {
        throw error instanceof SessionMutationAuthorizationChangedError ? error : admissionError;
      }
      respondChatSendAdmissionError(admissionError, (ok, payload, failure) => {
        // Classify the original admission error without discarding an attached save warning.
        respond(
          ok,
          payload,
          failure && error instanceof Error && error.cause === admissionError
            ? { ...failure, message: error.message }
            : failure,
        );
      });
      return false;
    }
    const error = res.unauthorized
      ? errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized")
      : (res.error ?? descendantAbortError(res.descendants, "Session"));
    if (error) {
      respond(false, undefined, withAbortedPartialPersistenceWarning(error, res.warning));
      return false;
    }
    respond(true, {
      ok: true,
      aborted: res.aborted,
      runIds: res.runIds,
      ...(res.warning ? { warning: res.warning } : {}),
    });
    return false;
  }

  if (respondChatSendRetry(params)) {
    return false;
  }

  // Same-ID retries must enter durable recovery after reconciliation, before admission
  // can mistake the restored claim for an already dispatched turn.
  let durableEntry = entry;
  if (entry && isMainSessionRecoveryReconciliationCandidate(entry)) {
    const { reconcileOrphanedGatewaySessionRecovery } =
      await import("../session-recovery-service.js");
    try {
      const recoveryEntry = loadSessionEntry(sessionLoadKey, sessionLoadOptions).entry;
      if (recoveryEntry) {
        await reconcileOrphanedGatewaySessionRecovery({
          cfg,
          target: resolveGatewaySessionStoreTarget({
            cfg,
            key: sessionKey,
            agentId: session.agentId,
          }),
          entry: recoveryEntry,
          authorizedPluginId: client?.internal?.pluginRuntimeOwnerId,
          commitGuard: () => {
            params.assertCurrent?.();
            if (sessionRoutingChanged(context.getRuntimeConfig())) {
              throw new Error(SESSION_ROUTING_CHANGED_ERROR_REASON);
            }
            const current = loadSessionEntry(sessionLoadKey, sessionLoadOptions);
            const conflict = resolveChatSendRequestConflict({
              ...params,
              session: { ...session, entry: current.entry },
            });
            if (conflict) {
              throw new Error(conflict.message);
            }
            const workStartError = resolveSessionWorkStartError(sessionKey, current.entry, {
              allowPendingWorkspace: true,
              providerReviewAcknowledgment: request.providerReviewAcknowledgment,
              runId: session.clientRunId,
              expectedSessionId: session.requestedSessionId ?? session.backingSessionId,
            });
            if (workStartError) {
              throw new Error(workStartError);
            }
            if (request.p.queueMode !== "steer" && session.expectedLeafEntryId !== undefined) {
              assertExpectedLeafActive(
                current,
                session.agentId,
                session.expectedLeafEntryId,
                session.requestedSessionId,
              );
            }
            captureAdmittedChatSendSessionSettings({
              commit: false,
              entry: current.entry,
              expectedPermissionMode: request.p.expectedPermissionMode,
              expectedToolOverrides: request.p.expectedToolOverrides,
            });
          },
          workerPlacementContext: resolveSessionWorkerPlacementContext(context),
        });
      }
      durableEntry = loadSessionEntry(sessionLoadKey, sessionLoadOptions).entry;
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      respondChatSendAdmissionError(error, respond);
      return false;
    }
    params.assertCurrent?.();
  }

  const durableClaim = await resolveDurableChatClaim({
    canonicalSessionKey: sessionKey,
    cfg,
    clientRunId,
    entry: durableEntry,
    persistedSessionKey: legacyKey ?? sessionKey,
    reloadEntry: () => loadSessionEntry(sessionLoadKey, sessionLoadOptions).entry,
    storePath,
    recoveryRuntime: context.recoveryRuntime,
    warn: (message) =>
      context.logGateway.warn(`failed to retry durable chat recovery ${clientRunId}: ${message}`),
  });
  params.assertCurrent?.();
  const retrySession = {
    ...session,
    entry:
      durableClaim.kind === "continue"
        ? durableClaim.entry
        : loadSessionEntry(sessionLoadKey, sessionLoadOptions).entry,
  };
  if (respondChatSendRetry({ ...params, session: retrySession })) {
    return false;
  }
  if (durableClaim.kind === "pending" || durableClaim.kind === "rejected") {
    respond(
      false,
      undefined,
      errorShape(
        durableClaim.kind === "pending" || durableClaim.unavailable
          ? ErrorCodes.UNAVAILABLE
          : ErrorCodes.INVALID_REQUEST,
        durableClaim.message,
        { retryable: durableClaim.kind === "pending" },
      ),
    );
    return false;
  }
  if (durableClaim.kind === "accepted") {
    if (request.goalOperation) {
      const retry = inspectGoalChatSendRetry({ ...params, durableClaimAccepted: true });
      if (retry.kind === "replay") {
        respond(true, { ...retry.receipt, replayed: true }, undefined, {
          cached: true,
          runId: clientRunId,
        });
      }
      return false;
    }
    // An active source claim or terminal tombstone proves the durable turn
    // was already accepted. Retire the outbox without dispatching twice.
    respond(true, { runId: clientRunId, status: "ok" as const }, undefined, {
      cached: true,
      runId: clientRunId,
    });
    return false;
  }

  // Cached/in-flight retries stay bound to their original target. Gate only a new dispatch.
  if (sessionRoutingChanged(cfg)) {
    respondChatSessionRoutingChanged(respond);
    return false;
  }
  const archivedSessionError = resolveSessionWorkStartError(sessionKey, entry, {
    allowPendingWorkspace: true,
    providerReviewAcknowledgment: request.providerReviewAcknowledgment,
    runId: clientRunId,
  });
  if (archivedSessionError) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, archivedSessionError));
    return false;
  }
  return true;
}
