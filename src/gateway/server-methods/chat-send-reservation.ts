import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { SessionGoalOperationError } from "../../config/sessions/goals-operations.js";
import { getRpcSourceForGateway } from "../../sessions/session-controller.rpc-sources.js";
import { resolveChatRunExpiresAtMs } from "../chat-abort.js";
import type { DedupeEntry } from "../server-shared.js";
import { readPreRegisteredRun, writePreRegisteredChatAbort } from "./chat-abort-authorization.js";
import type { prepareGoalChatSendRetry } from "./chat-send-goal-retry.js";
import type { ChatSendPreAdmissionParams } from "./chat-send-pre-admission.types.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import { chatSendRequestConflictError } from "./chat-send-retry-comparison.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Bind pending reservation and acceptance updates to one captured chat-send attempt. */
export function createPendingChatSendReservationAccess(params: {
  context: GatewayRequestHandlerOptions["context"];
  client: GatewayRequestHandlerOptions["client"];
  attemptId: string;
  requestIdentity?: string;
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
}) {
  const { pendingChatSendKey: key, clientRunId: runId } = params.session;
  // Reservation facts stay fixed while retry and placement preparation await.
  const { now, sessionKey, backingSessionId, rawSessionKey, selectedAgent, timeoutMs } =
    params.session;
  const { turnKind } = params.request;
  const read = () =>
    readPreRegisteredRun({
      key,
      entry: params.context.dedupe.get(key),
    });
  return {
    read,
    abort: (stopReason: string) =>
      writePreRegisteredChatAbort({
        context: params.context,
        runId,
        stopReason,
        attemptId: params.attemptId,
        requestIdentity: params.requestIdentity,
      }),
    reserve: () => {
      const { context, request, attemptId } = params;
      context.dedupe.set(key, {
        ts: now,
        ok: true,
        requestIdentity: params.requestIdentity,
        payload: {
          runId,
          attemptId,
          status: "accepted",
          sessionKey,
          ...(backingSessionId ? { sessionId: backingSessionId } : {}),
          ...(rawSessionKey === sessionKey ? {} : { sessionKeyAliases: [rawSessionKey] }),
          ...(selectedAgent.agentId ? { agentId: selectedAgent.agentId } : {}),
          ownerConnId: normalizeOptionalString(params.client?.connId),
          ownerDeviceId: normalizeOptionalString(params.client?.connect?.device?.id),
          expiresAtMs: resolveChatRunExpiresAtMs({
            now,
            timeoutMs,
          }),
          turnKind,
          ...(request.goalOperation
            ? { goalFingerprint: request.goalOperation.requestFingerprint }
            : {}),
        },
      });
    },
    clear: () => {
      const pending = read();
      if (
        pending?.runId === runId &&
        normalizeOptionalString(pending.payload.attemptId) === params.attemptId
      ) {
        params.context.dedupe.delete(key);
      }
    },
    markInputAccepted: () => {
      const accepted = params.context.dedupe.get("chat:" + runId);
      if (
        accepted?.ok !== true ||
        accepted.requestIdentity !== params.requestIdentity ||
        accepted.payload !== undefined ||
        accepted.error !== undefined
      ) {
        throw new Error("Chat input acceptance marker changed before acknowledgment");
      }
      accepted.effectAccepted = true;
    },
  };
}

/** A retained request identity is not an ACK; only response-bearing rows may replay. */
export function readChatSendDedupeResponse(
  dedupe: Map<string, DedupeEntry>,
  runId: string,
): DedupeEntry | undefined {
  const entry = dedupe.get(`chat:${runId}`);
  return entry?.ok && entry.payload === undefined && entry.error === undefined ? undefined : entry;
}

/** Consume prepared receipts and current RAM ownership without yielding before reservation. */
export function inspectGoalChatSendRetry({
  request,
  session,
  respond,
  context,
  assertCurrent,
  prepared,
}: ChatSendPreAdmissionParams & {
  prepared: Awaited<ReturnType<typeof prepareGoalChatSendRetry>>;
}) {
  assertCurrent?.();
  const { clientRunId, pendingChatSendKey } = session;
  if (!request.goalOperation) {
    return { kind: "new" } as const;
  }
  try {
    const receipt = prepared?.receipt;
    if (receipt instanceof SessionGoalOperationError) {
      throw receipt;
    }
    if (receipt) {
      return { kind: "replay", receipt } as const;
    }
    const pending = readPreRegisteredRun({
      key: pendingChatSendKey,
      entry: context.dedupe.get(pendingChatSendKey),
    });
    const retainedIdentity = context.dedupe.get(`chat:${clientRunId}`)?.requestIdentity;
    const submitted = prepared?.comparison?.submitted;
    const submittedIdentity = submitted?.["__openclaw"]?.chatRequestIdentity;
    // Goal custody retains its operation fingerprint; ordinary input retains the
    // transcript's message fingerprint after the pending reservation is cleared.
    const retainedGoalIdentity =
      retainedIdentity !== undefined &&
      typeof submittedIdentity === "string" &&
      retainedIdentity !== submittedIdentity;
    if (submitted && !pending?.payload.goalFingerprint && !retainedGoalIdentity) {
      respond(false, undefined, chatSendRequestConflictError());
      return { kind: "settled" } as const;
    }
    const identityConflict =
      retainedIdentity !== undefined &&
      retainedIdentity !== request.goalOperation.requestFingerprint;
    const cachedResponse = readChatSendDedupeResponse(context.dedupe, clientRunId);
    // A completed admission may publish after the worker's receipt snapshot.
    const newlyPublishedResponse =
      retainedIdentity === request.goalOperation.requestFingerprint &&
      cachedResponse !== undefined &&
      cachedResponse !== prepared?.dedupe;
    if (
      !identityConflict &&
      (pending?.payload.goalFingerprint === request.goalOperation.requestFingerprint ||
        newlyPublishedResponse ||
        (!pending && getRpcSourceForGateway(clientRunId, context.resolveGatewayContext)))
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
      identityConflict ||
      pending ||
      cachedResponse ||
      context.chatRunState.hasAbortMarker(clientRunId) ||
      getRpcSourceForGateway(clientRunId, context.resolveGatewayContext)
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
