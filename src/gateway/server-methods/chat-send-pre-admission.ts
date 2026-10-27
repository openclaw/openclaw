import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import { isSessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { getRpcSourceForGateway } from "../../sessions/session-controller.rpc-sources.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { readQueuedChatInputAdmission } from "../queued-chat-input-admission.js";
import { chatAbortMarkerTimestampMs } from "../server-chat-state.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import {
  buildAbortedChatSendPayload,
  readPreRegisteredRun,
  resolveChatAbortRequester,
} from "./chat-abort-authorization.js";
import { descendantAbortError } from "./chat-abort-descendants.js";
import { abortChatRunsForSessionKeyWithPartials } from "./chat-abort-runtime.js";
import {
  abortedPartialPersistenceError,
  withAbortedPartialPersistenceWarning,
} from "./chat-aborted-partial.js";
import { assertExpectedLeafActiveAsync } from "./chat-send-active-leaf.js";
import {
  respondChatSendAdmissionError,
  respondChatSessionRoutingChanged,
} from "./chat-send-admission-errors.js";
import { prepareGoalChatSendRetry } from "./chat-send-goal-retry.js";
import type { ChatSendPreAdmissionParams } from "./chat-send-pre-admission.types.js";
import { inspectGoalChatSendRetry, readChatSendDedupeResponse } from "./chat-send-reservation.js";
import {
  compareChatSendSubmittedInput,
  readChatSendRetryComparison,
  type ChatSendRetryComparison,
} from "./chat-send-retry-comparison.js";

type ChatSendRetryParams = Pick<
  ChatSendPreAdmissionParams,
  "assertCurrent" | "assertCurrentAsync" | "withCurrent" | "respond"
> & {
  request: Pick<
    ChatSendPreAdmissionParams["request"],
    "goalOperation" | "requestIdentity" | "rawMessage" | "mentions" | "workContext"
  >;
  session: Pick<
    ChatSendPreAdmissionParams["session"],
    "clientRunId" | "pendingChatSendKey" | "entry" | "agentId" | "sessionKey" | "storePath"
  >;
  context: Pick<
    ChatSendPreAdmissionParams["context"],
    "dedupe" | "chatRunState" | "resolveGatewayContext"
  >;
};

export function resolveChatSendRequestConflict(
  { request, session, context }: Omit<ChatSendRetryParams, "respond">,
  comparison?: ChatSendRetryComparison,
  ownPendingAttemptId?: string,
) {
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
  const ownPendingAttempt =
    ownPendingAttemptId !== undefined &&
    readPreRegisteredRun({
      key: session.pendingChatSendKey,
      entry: entries[1],
    })?.payload.attemptId === ownPendingAttemptId;
  const retryEntries = ownPendingAttempt ? entries.slice(0, 1) : entries;
  if (
    !comparison &&
    request.requestIdentity !== undefined &&
    retryEntries.some((entry) => entry?.requestIdentity === request.requestIdentity)
  ) {
    return undefined;
  }
  const knownRetry =
    comparison?.submitted !== undefined ||
    retryEntries.some(Boolean) ||
    context.chatRunState.hasAbortMarker(session.clientRunId) ||
    (!ownPendingAttempt &&
      getRpcSourceForGateway(session.clientRunId, context.resolveGatewayContext));
  if (!knownRetry) {
    return undefined;
  }
  const mismatch = compareChatSendSubmittedInput(request, session, comparison);
  return mismatch ? conflict(mismatch === "unverifiable") : undefined;
}

export function prepareChatSendRetryComparison(
  params: Omit<ChatSendRetryParams, "respond">,
  ownPendingAttemptId?: string,
): Promise<ChatSendRetryComparison> | undefined {
  try {
    resolveChatSendRequestConflict(params, undefined, ownPendingAttemptId);
    return undefined;
  } catch (error) {
    if (!isSessionTranscriptProjectionUnavailableError(error)) {
      throw error;
    }
    return readChatSendRetryComparison(params.session);
  }
}

/** Consume current authority in one synchronous frame after any required worker preparation. */
export async function consumeChatSendCurrent<T>(
  params: Pick<ChatSendPreAdmissionParams, "assertCurrent" | "assertCurrentAsync" | "withCurrent">,
  consume: () => T,
): Promise<T> {
  const invoke = () => {
    params.assertCurrent?.();
    return consume();
  };
  if (params.withCurrent) {
    return params.withCurrent(invoke);
  }
  if (params.assertCurrentAsync) {
    await params.assertCurrentAsync();
  }
  return invoke();
}

async function respondPreparedChatSendRetry(
  params: ChatSendRetryParams,
  readRecordedInput = false,
): Promise<boolean> {
  try {
    const pending =
      prepareChatSendRetryComparison(params) ??
      (readRecordedInput ? readChatSendRetryComparison(params.session) : undefined);
    const comparison = pending ? await pending : undefined;
    return await consumeChatSendCurrent(params, () => respondChatSendRetry(params, comparison));
  } catch (error) {
    if (!isSessionTranscriptProjectionUnavailableError(error)) {
      throw error;
    }
    respondChatSendAdmissionError(error, params.respond);
    return true;
  }
}

/** Consume prepared comparison and current RAM ownership without yielding before reservation. */
export function respondChatSendRetry(
  params: ChatSendRetryParams,
  comparison?: ChatSendRetryComparison,
): boolean {
  params.assertCurrent?.();
  const { session, context, respond } = params;
  const { clientRunId, pendingChatSendKey } = session;
  const conflict = resolveChatSendRequestConflict(params, comparison);
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
  const accepted = context.dedupe.get(`chat:${clientRunId}`);
  const inputAccepted = accepted?.effectAccepted === true;
  const pending = readPreRegisteredRun({
    key: pendingChatSendKey,
    entry: context.dedupe.get(pendingChatSendKey),
  });
  const preparing = pending || getRpcSourceForGateway(clientRunId, context.resolveGatewayContext);
  if (inputAccepted || (preparing && comparison?.submitted)) {
    respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
      cached: true,
      runId: clientRunId,
    });
    return true;
  }
  if (preparing) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "Chat input is being admitted; retry the same request.", {
        retryable: true,
      }),
    );
    return true;
  }
  if (comparison?.submitted) {
    const queued = readQueuedChatInputAdmission(clientRunId)?.target;
    if (
      comparison.source === "pending" &&
      queued?.agentId === session.agentId &&
      queued.storePath === session.storePath &&
      queued.sessionKey === session.sessionKey &&
      queued.sessionId === session.entry?.sessionId
    ) {
      // A gracefully retained queued input re-enters ordinary admission before it can run.
      return false;
    }
    // RAM reservations cover concurrent sends before their durable input exists.
    // A crash before either record leaves the original key available for retry.
    const payload = {
      runId: clientRunId,
      status: "ok" as const,
      ...(comparison.messageSeq !== undefined ? { messageSeq: comparison.messageSeq } : {}),
    };
    respond(true, payload, undefined, { cached: true, runId: clientRunId });
    return true;
  }
  return false;
}

/** Settle stop/retry/dedupe cases before reserving lifecycle admission. */
export async function runChatSendPreAdmission(
  params: ChatSendPreAdmissionParams,
): Promise<boolean> {
  const { request, session, respond, context, client } = params;
  const { stopCommand } = request;
  const {
    cfg,
    entry,
    sessionKey,
    rawSessionKey,
    selectedAgent,
    clientRunId,
    storePath,
    sessionRoutingChanged,
  } = session;

  const consumeNewDispatchDecision = () => {
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
  };
  const consumeInitialDecision = () => {
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
    if (!request.goalOperation) {
      try {
        const handled = respondChatSendRetry(params);
        if (handled) {
          return false;
        }
      } catch (error) {
        if (!isSessionTranscriptProjectionUnavailableError(error)) {
          throw error;
        }
        // Missing comparison facts are prepared below, then consumed with fresh authority.
      }
    }
    return true;
  };
  // Stop owns its current-authority checks and typed cancellation errors below.
  if (
    !(stopCommand
      ? consumeInitialDecision()
      : await consumeChatSendCurrent(params, consumeInitialDecision))
  ) {
    return false;
  }

  if (request.goalOperation) {
    const prepared = await prepareGoalChatSendRetry(params);
    const retry = await consumeChatSendCurrent(params, () =>
      inspectGoalChatSendRetry({ ...params, prepared }),
    );
    if (retry.kind === "settled") {
      return false;
    }
    if (retry.kind === "replay") {
      respond(true, { ...retry.receipt, replayed: true }, undefined, {
        cached: true,
        runId: clientRunId,
      });
      return false;
    }
  }

  if (stopCommand) {
    const stopRequester = resolveChatAbortRequester(client);

    const stopStorePath = session.readSource?.path ?? storePath;
    const guard: { failure?: { error: unknown } } = {};
    const assertCurrent = () => {
      if (guard.failure) {
        throw guard.failure.error;
      }
      try {
        params.assertCurrent?.();
      } catch (error) {
        guard.failure = { error };
        throw error;
      }
    };
    const beforeAbort = async () => {
      try {
        if (request.p.queueMode !== "steer" && session.expectedLeafEntryId !== undefined) {
          await assertExpectedLeafActiveAsync(
            {
              canonicalKey: sessionKey,
              storePath: stopStorePath,
              entry,
            },
            session.agentId,
            session.expectedLeafEntryId,
            session.requestedSessionId,
          );
        }
        assertCurrent();
      } catch (error) {
        guard.failure = { error };
        throw error;
      }
    };
    let res: Awaited<ReturnType<typeof abortChatRunsForSessionKeyWithPartials>>;
    try {
      if (await respondPreparedChatSendRetry(params, true)) {
        return false;
      }
      if (sessionRoutingChanged(cfg)) {
        respondChatSessionRoutingChanged(respond);
        return false;
      }
      assertCurrent();
      res = await abortChatRunsForSessionKeyWithPartials({
        context,
        ops: createChatAbortOps(context),
        sessionKey,
        sessionKeyAliases: sessionKey === rawSessionKey ? undefined : [rawSessionKey],
        agentId: selectedAgent.agentId,
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
        defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(cfg, sessionKey),
        abortOrigin: "stop-command",
        stopReason: "stop",
        requester: stopRequester,
        stopSource: "channel-user",
        // The controller keeps the selected store locator; persistence uses its physical DB.
        controllerTargets: [
          captureSessionTarget({
            storeScope: storePath,
            sessionKey,
            aliases: [rawSessionKey],
            agentId: selectedAgent.agentId,
            incarnation: entry?.sessionId,
          }),
        ],
        hookContext: {
          sessionKey,
          sessionEntry: entry,
          sessionId: entry?.sessionId,
          commandSource: "gateway:chat.send",
          senderId: stopRequester.deviceId ?? stopRequester.connId,
        },
        assertCurrent,
        beforeAbort,
        cascadeDescendants: true,
      });
      // A stale child refusal can precede beforeAbort; the request's leaf error wins.
      if (!guard.failure && (res.error || (res.descendants && res.descendants.status !== "ok"))) {
        try {
          await beforeAbort();
        } catch (error) {
          throw abortedPartialPersistenceError(error, res.warning);
        }
      }
      try {
        // Descendant cancellation can aggregate a later authority or leaf failure.
        assertCurrent();
      } catch (error) {
        throw abortedPartialPersistenceError(error, res.warning);
      }
    } catch (error) {
      const admissionError = guard.failure ? guard.failure.error : error;
      // Settlement retains the warning-bearing persistence failure as its cause.
      const reportedError =
        guard.failure && error instanceof AggregateError && error.cause instanceof Error
          ? error.cause
          : error;
      if (admissionError instanceof SessionMutationAuthorizationChangedError) {
        throw reportedError instanceof SessionMutationAuthorizationChangedError
          ? reportedError
          : new SessionMutationAuthorizationChangedError({
              ...admissionError.error,
              message:
                reportedError instanceof Error ? reportedError.message : admissionError.message,
            });
      }
      respondChatSendAdmissionError(admissionError, (ok, payload, failure) => {
        // Classify the original admission error without discarding an attached save warning.
        respond(
          ok,
          payload,
          failure && reportedError instanceof Error && reportedError.cause === admissionError
            ? { ...failure, message: reportedError.message }
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

  // A completed input can outlive its RAM receipt; compare stored bytes before
  // admitting its ID as fresh work, without adopting the old input's custody.
  if (!request.goalOperation && (await respondPreparedChatSendRetry(params, true))) {
    return false;
  }

  return consumeChatSendCurrent(params, consumeNewDispatchDecision);
}
