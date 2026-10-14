import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { captureExecRequestCancellation } from "../../agents/bash-process-control.js";
import {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunActive,
  resolveActiveEmbeddedRunOwner,
} from "../../agents/embedded-agent-runner/runs.js";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import type { SubagentRequestSessionOrigin } from "../../agents/subagents/registry/subagent-exec-request-ownership.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { captureSessionWorkRunInterruptions } from "../../sessions/session-lifecycle-admission.js";
import { abortChatRunById } from "../chat-abort.js";
import { abortQueuedChatTurnById } from "../chat-queued-turns.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX } from "../server-shared.js";
import type { WorkerInferenceCancellation } from "../worker-environments/inference-control-internal.js";
import {
  canRequesterAbortChatRun,
  resolveAuthorizedPreRegisteredRunsForSessionKeys,
  resolveAuthorizedRunsForSessionKeys,
  resolveAuthorizedQueuedTurnsForSession,
  writePreRegisteredAgentAbort,
  writePreRegisteredChatAbort,
} from "./chat-abort-authorization.js";
import type { ChatSessionAbortParams, ChatSessionAbortResult } from "./chat-abort-runtime.types.js";
import {
  ABORTED_PARTIAL_PERSISTENCE_WARNING,
  abortedPartialPersistenceError,
  captureAbortedPartial,
  deferAbortedPartialPersistence,
  type AbortedPartialSnapshot,
} from "./chat-aborted-partial.js";
import { persistAbortedPartials } from "./chat-transcript-persistence.js";
import { createSessionAbortPersistence } from "./session-abort-persistence.js";

/** Resolve once at the cancellation boundary; persist captured partials only after Stop. */
export function prepareChatSessionAbort(
  params: ChatSessionAbortParams,
  workerCancellation: WorkerInferenceCancellation | undefined,
  selectedRunId?: string,
) {
  const sessionKeys = [params.sessionKey, ...(params.sessionKeyAliases ?? [])];
  const ownerScope = {
    sessionKeys,
    requiredSessionId: params.requiredSessionId,
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
  };
  const acceptsRequest: SubagentRequestSessionOrigin["acceptsRequest"] = (identity) =>
    canRequesterAbortChatRun(identity, params.requester) &&
    (params.includeProtectedRuns === true ||
      (identity.controlUiVisible !== false &&
        !(params.preserveSideRuns && identity.turnKind === "btw")));
  const commands = captureExecRequestCancellation(
    {
      sessionKey: params.sessionKey,
      sessionId: params.requiredSessionId ?? params.sessionId,
      agentId: params.agentId,
    },
    acceptsRequest,
  );
  const session = params.session?.ok ? params.session.value : undefined;
  const persistedSessionId = session?.entry?.sessionId ?? params.sessionId;
  const capturedEmbeddedRun =
    !params.runId && persistedSessionId
      ? resolveActiveEmbeddedRunOwner(persistedSessionId)
      : undefined;
  const sessionEmbeddedRun =
    params.requiredSessionId === undefined ||
    (capturedEmbeddedRun?.sessionId === params.requiredSessionId &&
      capturedEmbeddedRun.sessionKey !== undefined &&
      sessionKeys.includes(capturedEmbeddedRun.sessionKey))
      ? capturedEmbeddedRun
      : undefined;
  const embeddedController = sessionEmbeddedRun
    ? params.context.chatAbortControllers.get(sessionEmbeddedRun.runId)
    : undefined;
  const canCaptureAdmittedRuns =
    params.stopEmbeddedRun && !params.runId && params.sessionKey !== "global";
  const admittedRuns =
    canCaptureAdmittedRuns && persistedSessionId && session?.storePath
      ? captureSessionWorkRunInterruptions({
          scope: session.storePath,
          identities: [...sessionKeys, persistedSessionId],
          accept: (run) =>
            run.sessionKey !== undefined &&
            sessionKeys.includes(run.sessionKey) &&
            (!run.agentId || !params.agentId || run.agentId === params.agentId) &&
            run.sessionId === (params.requiredSessionId ?? persistedSessionId) &&
            run.runId !== sessionEmbeddedRun?.runId &&
            !params.context.chatAbortControllers.has(run.runId) &&
            acceptsRequest(run),
        })
      : [];
  const persistSessionAbort = createSessionAbortPersistence({
    sessionKey: session?.canonicalKey ?? params.sessionKey,
    agentId: session?.agentId ?? params.agentId,
    lifecycleRevision: session?.entry?.lifecycleRevision,
    startedAt: session?.entry?.startedAt,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    stopReason: params.stopReason,
    assertCurrent: params.assertCurrent,
  });
  const sessionOrigin: SubagentRequestSessionOrigin | undefined =
    session?.entry &&
    (params.requiredSessionId === undefined ||
      session.entry.sessionId === params.requiredSessionId) &&
    (params.sessionId === undefined || session.entry.sessionId === params.sessionId)
      ? {
          target: {
            agentId: session.agentId,
            storePath: session.storePath,
            sessionKey: session.canonicalKey,
            sessionId: session.entry.sessionId,
            lifecycleRevision: session.entry.lifecycleRevision ?? null,
          },
          acceptsRequest,
        }
      : undefined;
  const queuedPlan = resolveAuthorizedQueuedTurnsForSession({
    ...ownerScope,
    context: params.context,
    sessionId: params.sessionId,
  });
  const activePlan = resolveAuthorizedRunsForSessionKeys({
    ...ownerScope,
    chatAbortControllers: params.context.chatAbortControllers,
    sessionIds: [params.sessionId],
    preserveSideRuns: params.preserveSideRuns,
    includeProtectedRuns: params.includeProtectedRuns,
  });
  const resolvePendingRuns = (keyPrefix: string) =>
    resolveAuthorizedPreRegisteredRunsForSessionKeys({
      ...ownerScope,
      context: params.context,
      keyPrefix,
      preserveSideRuns: params.preserveSideRuns,
      includeProtectedRuns: params.includeProtectedRuns,
    });
  const pendingAgent = resolvePendingRuns("agent:");
  const pendingChat = resolvePendingRuns(PENDING_CHAT_SEND_DEDUPE_PREFIX);
  const runPlans = [activePlan, pendingAgent, pendingChat];
  const { authorizedRuns, matchedRunIds: matchedActiveRunIds } = activePlan;
  const hasAuthorizedGatewayRuns =
    queuedPlan.authorized.length > 0 || runPlans.some((plan) => plan.authorizedRuns.length > 0);
  const isLifecycleAbort = Boolean(
    params.cascadeDescendants ||
    params.onAuthorizedAfterQueuedAbort ||
    params.onAuthorizedBeforeEmbeddedAbort,
  );
  const hasWorkerRun = Boolean(
    (!hasAuthorizedGatewayRuns || isLifecycleAbort) && workerCancellation?.runIds.length,
  );
  // The worker manager admits at most one active inference per session, and a
  // worker-backed turn shares its controller's runId. One exact match therefore
  // represents the only worker owner instead of inventing a second owner.
  const hasControllerRepresentedWorkerRun =
    hasWorkerRun && matchedActiveRunIds.some((runId) => workerCancellation?.runIds.includes(runId));
  const hasUnauthorizedOwner =
    queuedPlan.hasUnauthorizedRuns ||
    runPlans.some((plan) => plan.hasUnauthorizedRuns) ||
    (hasWorkerRun && !hasControllerRepresentedWorkerRun && !params.requester.isAdmin);
  const hasProtectedLifecycleRuns = runPlans.some((plan) => plan.hasProtectedRuns);
  const hasUnauthorizedProtectedOwner = runPlans.some((plan) => plan.hasUnauthorizedProtectedRuns);
  const hasUnauthorizedLifecycleOwner = isLifecycleAbort && hasUnauthorizedProtectedOwner;
  const canRunLifecycleCleanup = !hasUnauthorizedOwner && !hasProtectedLifecycleRuns;
  // Keep ordinary chat.abort's admin worker behavior; only the injected broad
  // lifecycle path must preserve hidden or explicitly preserved Gateway runs.
  const canCancelWorkerSession = !isLifecycleAbort || !hasProtectedLifecycleRuns;
  let snapshots: AbortedPartialSnapshot[] = [];
  let partialSnapshotUnavailable = false;
  let workerCancellationPersistence: Promise<string[]> | undefined;
  let embeddedAbortPersistence: Promise<void> | undefined;
  const admittedAbortPersistence: Promise<void>[] = [];
  // Reentrant cancellation can revoke the next effect. Keep committed outcomes
  // available to the partial-persistence owner even when abort() then throws.
  const result: ChatSessionAbortResult = { aborted: false, runIds: [], unauthorized: false };
  const recordRun = (runId: string) => {
    result.aborted = true;
    if (!result.runIds.includes(runId)) {
      result.runIds.push(runId);
    }
  };
  const cancelWorker = () => {
    workerCancellationPersistence = workerCancellation?.cancel({
      assertCurrent: params.assertCurrent,
      onCancelled: recordRun,
    });
    // The synchronous abort owner must return before persistence settles. Observe
    // rejection now, but finish() still joins the original operation and its cause.
    void workerCancellationPersistence?.catch(() => undefined);
  };
  const abortAdditional = () => {
    if (!canRunLifecycleCleanup) {
      return;
    }
    const wasActive = Boolean(persistedSessionId && isEmbeddedAgentRunActive(persistedSessionId));
    params.assertCurrent?.();
    const embeddedAborted = Boolean(
      params.stopEmbeddedRun &&
      !params.runId &&
      persistedSessionId &&
      params.sessionKey !== "global" &&
      !embeddedController &&
      (sessionEmbeddedRun
        ? sessionEmbeddedRun.abort()
        : params.requiredSessionId === undefined && abortEmbeddedAgentRun(persistedSessionId)),
    );
    if (embeddedAborted) {
      result.aborted = true;
      if (sessionEmbeddedRun) {
        recordRun(sessionEmbeddedRun.runId);
        embeddedAbortPersistence = persistSessionAbort(sessionEmbeddedRun);
        void embeddedAbortPersistence.catch(() => undefined);
      }
    }
    for (const admitted of admittedRuns) {
      params.assertCurrent?.();
      const { runId, sessionId } = admitted.run;
      if (
        !sessionId ||
        params.context.chatAbortControllers.has(runId) ||
        runId === sessionEmbeddedRun?.runId
      ) {
        continue;
      }
      if (admitted.interrupt(createAgentRunDirectAbortError())) {
        recordRun(runId);
        const persistence = persistSessionAbort({ runId, sessionId, startedAtMs: undefined });
        void persistence.catch(() => undefined);
        admittedAbortPersistence.push(persistence);
      }
    }
    params.assertCurrent?.();
    result.aborted =
      params.onAuthorizedAfterQueuedAbort?.({
        capturedRunId: sessionEmbeddedRun?.runId,
        controller: embeddedController,
        wasActive,
        aborted: embeddedAborted,
      }) || result.aborted;
  };
  const abortAuthorizedRuns = () => {
    params.assertCurrent?.();
    params.onControllerTargets?.(authorizedRuns);
    // The injected lifecycle callback must not turn a persisted session id into
    // a bypass around a matching connection or protected run owner.
    if (!hasAuthorizedGatewayRuns && (hasUnauthorizedOwner || hasUnauthorizedLifecycleOwner)) {
      result.unauthorized = true;
      return;
    }
    snapshots = authorizedRuns.flatMap(({ runId, entry }) => {
      const text = params.context.chatRunState.resolveBuffer(runId, { final: true }).text;
      if (!text?.trim()) {
        return [];
      }
      if (!params.session) {
        // A rowless run has no captured incarnation; never append its text to a later reset.
        partialSnapshotUnavailable = true;
        params.context.logGateway.warn(
          "chat.abort transcript metadata unavailable; buffered reply was not saved",
        );
        return [];
      }
      return [
        captureAbortedPartial({
          runId,
          sessionKey: params.sessionKey,
          sessionId: entry.sessionId,
          text,
          abortOrigin: params.abortOrigin,
          resolveTerminalProducer: entry.resolveTerminalProducer,
          session: params.session,
        }),
      ];
    });
    // Abort queued owners before any active-work signal can promote a successor.
    // Keep them first in the response to preserve the established runIds ordering.
    for (const { runId, sessionKey, sessionId, agentId, entry } of queuedPlan.authorized) {
      params.assertCurrent?.();
      if (
        params.context.chatQueuedTurns.get(runId) !== entry ||
        entry.sessionKey !== sessionKey ||
        entry.sessionId !== sessionId ||
        entry.agentId !== agentId
      ) {
        continue;
      }
      if (
        abortQueuedChatTurnById(params.context.chatQueuedTurns, {
          runId,
          sessionKey,
          stopReason: params.stopReason,
        }).aborted
      ) {
        recordRun(runId);
      }
    }
    // Hidden and preserved side runs must also block broad cleanup: authorization
    // alone must not let the callback abort work intentionally excluded above.
    if (canRunLifecycleCleanup) {
      params.assertCurrent?.();
      result.aborted = params.onAuthorizedBeforeEmbeddedAbort?.() || result.aborted;
    }
    for (const { runId, sessionKey, sessionId, agentId, entry } of authorizedRuns) {
      params.assertCurrent?.();
      if (
        params.context.chatAbortControllers.get(runId) !== entry ||
        entry.sessionKey !== sessionKey ||
        entry.sessionId !== sessionId ||
        entry.agentId !== agentId
      ) {
        continue;
      }
      const res = abortChatRunById(params.ops, {
        runId,
        sessionKey,
        stopReason: params.stopReason,
        onAbortCommitted: () => {
          recordRun(runId);
          deferAbortedPartialPersistence(
            snapshots.find((snapshot) => snapshot.runId === runId),
            params.context,
          );
        },
      });
      if (res.aborted) {
        recordRun(runId);
      }
    }
    // Secondary cancellation must not retire reply abortability before its chat terminal.
    params.assertCurrent?.();
    if (commands.cancel()) {
      result.aborted = true;
    }
    abortAdditional();
    const endedAt = Date.now();
    const stopReason = params.stopReason ?? "rpc";
    for (const [kind, plan] of [
      ["agent", pendingAgent],
      ["chat", pendingChat],
    ] as const) {
      for (const run of plan.authorizedRuns) {
        const { runId, sessionKey, payload } = run;
        params.assertCurrent?.();
        const abort = {
          context: params.context,
          runId,
          stopReason,
          endedAt,
          expectedPayload: payload,
        };
        const written =
          kind === "agent"
            ? writePreRegisteredAgentAbort({ ...abort, sessionKey, payload })
            : writePreRegisteredChatAbort({
                ...abort,
                attemptId: normalizeOptionalString(payload.attemptId),
              });
        if (written) {
          recordRun(runId);
        }
      }
    }
    if (
      (hasAuthorizedGatewayRuns || hasWorkerRun) &&
      params.requester.isAdmin &&
      canCancelWorkerSession
    ) {
      params.assertCurrent?.();
      cancelWorker();
    }
  };
  const hasOtherWork =
    [activePlan, queuedPlan, pendingAgent, pendingChat].some((plan) =>
      plan.matchedRunIds.some((runId) => runId !== selectedRunId),
    ) ||
    (hasWorkerRun && (!selectedRunId || !workerCancellation?.runIds.includes(selectedRunId)));
  return {
    canCascade: canRunLifecycleCleanup && !hasUnauthorizedLifecycleOwner,
    acceptsRequest,
    commands,
    sessionOrigin,
    hasOtherWork,
    result,
    abort: abortAuthorizedRuns,
    async finish() {
      const abortedRunIds = new Set(result.runIds);
      const [worker, partial, exec, embedded, ...admitted] = await Promise.allSettled([
        workerCancellationPersistence,
        result.aborted && snapshots.length > 0
          ? persistAbortedPartials({
              context: params.context,
              snapshots: snapshots.filter((snapshot) => abortedRunIds.has(snapshot.runId)),
            })
          : undefined,
        commands.settle(),
        embeddedAbortPersistence,
        ...admittedAbortPersistence,
      ]);
      // A captured session failure can also surface through partial persistence.
      const failures = new Set<unknown>();
      for (const settled of [worker, partial, exec, embedded, ...admitted]) {
        if (settled.status === "rejected") {
          failures.add(settled.reason);
        }
      }
      if (params.session && !params.session.ok) {
        failures.add(params.session.error);
      }
      const warning =
        (partial.status === "fulfilled" ? partial.value : undefined) ??
        (partialSnapshotUnavailable ? ABORTED_PARTIAL_PERSISTENCE_WARNING : undefined);
      if (failures.size > 0) {
        const errors = [...failures];
        throw abortedPartialPersistenceError(
          errors.length === 1
            ? errors[0]
            : new AggregateError(errors, "Chat cancellation persistence failed"),
          warning,
        );
      }
      return warning;
    },
  };
}
