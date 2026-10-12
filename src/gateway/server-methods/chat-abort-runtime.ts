import type { Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { captureExecRequestCancellation } from "../../agents/bash-process-control.js";
import {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunActive,
  resolveActiveEmbeddedRunOwner,
} from "../../agents/embedded-agent-runner/runs.js";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import { killSubagentRunAdmin } from "../../agents/subagents/registry/subagent-control-kill.js";
import { ensureSubagentControllerOwnsRun } from "../../agents/subagents/registry/subagent-control-scope.js";
import type { SubagentRequestSessionOrigin } from "../../agents/subagents/registry/subagent-exec-request-ownership.js";
import {
  getCurrentSubagentRunOwner,
  subagentRuns,
} from "../../agents/subagents/registry/subagent-registry-memory.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  isSubagentRunQueued,
} from "../../agents/subagents/registry/subagent-registry-read.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import { captureSessionWorkRunInterruptions } from "../../sessions/session-lifecycle-admission.js";
import { captureWorkerInferenceForSession, createChatAbortOps } from "../chat-abort-ops.js";
import { abortChatRunById, isChatAbortControllerEntryAbortable } from "../chat-abort.js";
import { abortQueuedChatTurnById } from "../chat-queued-turns.js";
import { resolveChatRunOwnerAgentId } from "../chat-run-owner.js";
import { errorShapeFromError } from "../error-shape.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX } from "../server-shared.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { resolveSessionStoreKey } from "../session-utils.js";
import type { WorkerInferenceCancellation } from "../worker-environments/inference-control-internal.js";
import {
  canRequesterAbortChatRun,
  resolveAuthorizedPreRegisteredRunsForSessionKeys,
  resolveAuthorizedRunsForSessionKeys,
  resolveAuthorizedQueuedTurnsForSession,
  writePreRegisteredAgentAbort,
  writePreRegisteredChatAbort,
} from "./chat-abort-authorization.js";
import { abortControlledSubagents } from "./chat-abort-descendants.js";
import {
  createQueuedCollectorPublication,
  getQueuedCollectorCancellationRunId,
} from "./chat-abort-queued-collector-publication.js";
import type { ChatSessionAbortParams, ChatSessionAbortResult } from "./chat-abort-runtime.types.js";
import {
  abortedPartialPersistenceError,
  captureAbortedPartial,
  deferAbortedPartialPersistence,
  withQueuedCollectorWarning,
  type QueuedCollectorAbortOutcome,
  type AbortedPartialSnapshot,
} from "./chat-aborted-partial.js";
import { persistAbortedPartials } from "./chat-transcript-persistence.js";
import { createSessionAbortPersistence } from "./session-abort-persistence.js";

/** Queued collectors retain scheduler ownership while Gateway admission is still pending. */
export function abortQueuedCollectorSession(
  params: Omit<ChatSessionAbortParams, "ops">,
): Promise<QueuedCollectorAbortOutcome> | undefined {
  const entry = getLatestLiveSubagentRunByChildSessionKey(
    params.sessionKey,
    undefined,
    params.agentId,
  );
  if (!entry || !isSubagentRunQueued(entry) || (params.runId && entry.runId !== params.runId)) {
    return undefined;
  }
  const workerCancellation = captureWorkerInferenceForSession({
    context: params.context,
    sessionId: params.sessionId,
  });
  const cfg = params.session?.ok ? params.session.value.cfg : params.context.getRuntimeConfig();
  const parentRunId = entry.requesterTurnRunId;
  const parentRun = parentRunId ? params.context.chatAbortControllers.get(parentRunId) : undefined;
  const parentKey = entry.controllerSessionKey?.trim() || entry.requesterSessionKey;
  const controller = {
    controllerSessionKey: parentKey,
    controllerAgentId: resolveChatRunOwnerAgentId({
      sessionKey: parentKey,
      defaultAgentId: entry.requesterAgentId,
    }),
  };
  // Preserve the actual parent admission's authority through awaited kill work;
  // visibility and operator.write alone do not own an unstarted child.
  const assertCurrent = () => {
    params.assertCurrent?.();
    const current = getCurrentSubagentRunOwner(subagentRuns, entry);
    if (!current || (current.execution.status === "queued" && !isSubagentRunQueued(current))) {
      throw new Error("Queued collector reservation changed; retry Stop.");
    }
    const ownershipError = ensureSubagentControllerOwnsRun({ cfg, controller, entry: current });
    if (ownershipError) {
      throw new Error(ownershipError);
    }
    if (params.requester.isAdmin) {
      return;
    }
    if (
      !parentRunId ||
      !parentRun ||
      params.context.chatAbortControllers.get(parentRunId) !== parentRun ||
      !isChatAbortControllerEntryAbortable(parentRun) ||
      !parentRun.lifecycleGeneration ||
      !isAgentEventLifecycleGenerationCurrent(parentRun.lifecycleGeneration) ||
      parentRun.projectSessionActive === false ||
      resolveSessionStoreKey({
        cfg,
        sessionKey: parentRun.sessionKey,
        storeAgentId: controller.controllerAgentId,
      }) !== parentKey ||
      resolveChatRunOwnerAgentId({
        agentId: parentRun.agentId,
        sessionKey: parentRun.sessionKey,
      }) !== controller.controllerAgentId ||
      !canRequesterAbortChatRun(parentRun, params.requester, { requireOwnerMatch: true })
    ) {
      throw new Error(
        "Unauthorized queued collector Stop; use its active parent requester connection or an administrator.",
      );
    }
  };
  return (async () => {
    let sessionAbort: Result<ReturnType<typeof prepareChatSessionAbort>, ErrorShape> | undefined;
    let outcome: QueuedCollectorAbortOutcome = {
      ok: false,
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        "Queued collector cancellation was not published; retry Stop.",
      ),
    };
    let failure: { error: unknown } | undefined;
    try {
      assertCurrent();
      const projection = getSessionRowProjection(params.context);
      if (projection) {
        do {
          await projection.ensureMaterialized();
        } while (projection.needsMaterialization);
      }
      assertCurrent();
      const publication = createQueuedCollectorPublication({
        context: params.context,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        sessionId: params.sessionId,
        defaultAgentId: params.defaultAgentId,
        projection,
        canPublish: () =>
          !sessionAbort ||
          (sessionAbort.ok &&
            !sessionAbort.value.result.unauthorized &&
            sessionAbort.value.canCascade),
      });
      await killSubagentRunAdmin(
        {
          cfg,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          expectedRunId: entry.runId,
          expectedGeneration: entry.generation,
          expectedOwnerKey: entry.requesterSessionKey,
          onResult: (result) => {
            publication.publishSnapshot(result, true);
            if (sessionAbort && !sessionAbort.ok) {
              outcome = sessionAbort;
              return;
            }
            const selected = sessionAbort?.value;
            if (selected?.result.unauthorized) {
              outcome = {
                ok: false,
                error: errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"),
              };
              return;
            }
            if (result.found && result.error) {
              outcome = { ok: false, error: errorShape(ErrorCodes.UNAVAILABLE, result.error) };
              return;
            }
            if (selected && !selected.canCascade) {
              // Other owned runs may have stopped, but this collector remains eligible.
              outcome = {
                ok: false,
                error: errorShape(
                  ErrorCodes.UNAVAILABLE,
                  "Queued collector was not stopped; other session work was preserved. Wait for it to finish or cancel it through its owner, then retry.",
                ),
              };
              return;
            }
            const cancelledRunId = getQueuedCollectorCancellationRunId(result);
            const aborted = cancelledRunId !== undefined;
            outcome = {
              ok: true,
              value: {
                aborted: aborted || selected?.result.aborted === true,
                runIds: uniqueStrings([
                  ...(aborted ? [cancelledRunId] : []),
                  ...(selected?.result.runIds ?? []),
                ]),
              },
            };
          },
        },
        {
          assertCurrent,
          preparePublication: publication,
          beforeSessionKill: async () => {
            await params.beforeAbort?.();
            assertCurrent();
            // Resolve Gateway owners under the kill runtime's session fence.
            // Signal them only after this collector's FIFO reservation is held.
            const plan = prepareChatSessionAbort(
              {
                ...params,
                ops: createChatAbortOps(params.context),
                cascadeDescendants: true,
                includeProtectedRuns: params.runId ? true : params.includeProtectedRuns,
              },
              workerCancellation,
              entry.runId,
            );
            if (params.runId && plan.hasOtherWork) {
              sessionAbort = {
                ok: false,
                error: errorShape(
                  ErrorCodes.UNAVAILABLE,
                  "Other work is active in this child session; use a full-session Stop without runId.",
                ),
              };
              return false;
            }
            sessionAbort = {
              ok: true,
              value: plan,
            };
            plan.abort();
            return plan.canCascade;
          },
        },
      );
    } catch (error) {
      failure = { error };
      outcome = {
        ok: false,
        error: errorShapeFromError(ErrorCodes.INVALID_REQUEST, error),
      };
    }
    // Gateway cancellation already consumed these buffers. Preserve their snapshots
    // after later owner failures; the transcript writer still fences the session.
    if (sessionAbort?.ok) {
      try {
        const warning = await sessionAbort.value.finish();
        if (warning) {
          outcome = withQueuedCollectorWarning(outcome, warning);
        }
      } catch (error) {
        if (outcome.ok) {
          throw error;
        }
        throw new AggregateError(
          [failure?.error ?? outcome.error, error],
          "Queued collector cancellation and persistence failed",
          { cause: error },
        );
      }
    }
    return outcome;
  })();
}

/** Resolve once at the cancellation boundary; persist captured partials only after Stop. */
function prepareChatSessionAbort(
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
    params.assertCurrent?.();
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
    params.assertCurrent?.();
    result.aborted = params.onAuthorizedBeforeEmbeddedAbort?.() || result.aborted;
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
    if (!hasAuthorizedGatewayRuns) {
      // The injected lifecycle callback must not turn a persisted session id into
      // a bypass around a matching connection or protected run owner.
      if (hasUnauthorizedOwner || hasUnauthorizedLifecycleOwner) {
        result.unauthorized = true;
        return;
      }
      params.assertCurrent?.();
      if (commands.cancel()) {
        result.aborted = true;
      }
      // With no owned Gateway run, the exact persisted session is the boundary,
      // matching sessions.steer's operator.write behavior for ownerless work.
      abortAdditional();
      if (!hasWorkerRun || !params.requester.isAdmin || !canCancelWorkerSession) {
        return;
      }
      cancelWorker();
      return;
    }
    snapshots = authorizedRuns.flatMap(({ runId, entry }) => {
      const text = params.context.chatRunState.resolveBuffer(runId, { final: true }).text;
      return text?.trim()
        ? [
            captureAbortedPartial({
              runId,
              sessionKey: params.sessionKey,
              sessionId: entry.sessionId,
              agentId: entry.agentId ?? params.agentId,
              text,
              abortOrigin: params.abortOrigin,
              resolveTerminalProducer: entry.resolveTerminalProducer,
              session: params.session,
            }),
          ]
        : [];
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
    abortAdditional();
    params.assertCurrent?.();
    if (commands.cancel()) {
      result.aborted = true;
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
    if (params.requester.isAdmin && canCancelWorkerSession) {
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
      const failures = new Set<unknown>(
        [worker, partial, exec, embedded, ...admitted].flatMap((settled) =>
          settled.status === "rejected" ? [settled.reason] : [],
        ),
      );
      if (params.session && !params.session.ok) {
        failures.add(params.session.error);
      }
      const warning = partial.status === "fulfilled" ? partial.value : undefined;
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

export async function abortChatRunsForSessionKeyWithPartials(
  params: ChatSessionAbortParams,
): Promise<ChatSessionAbortResult> {
  if (params.cascadeDescendants) {
    const queuedAbort = abortQueuedCollectorSession(params);
    if (queuedAbort) {
      const result = await queuedAbort;
      return result.ok
        ? { ...result.value, unauthorized: false }
        : { aborted: false, runIds: [], unauthorized: false, error: result.error };
    }
  }
  const plan = prepareChatSessionAbort(params, captureWorkerInferenceForSession(params));
  const result = plan.result;
  let descendants: Awaited<ReturnType<typeof abortControlledSubagents>>;
  let failure: { error: unknown } | undefined;
  try {
    if (params.cascadeDescendants && plan.canCascade) {
      descendants = await abortControlledSubagents({
        cfg: params.session?.ok ? params.session.value.cfg : params.context.getRuntimeConfig(),
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        sessionId: params.sessionId,
        execCancellation: plan.commands,
        sessionOrigin: plan.sessionOrigin,
        assertCurrent: params.assertCurrent,
        beforeKill: async () => {
          await params.beforeAbort?.();
          plan.abort();
          return true;
        },
      });
    } else {
      await params.beforeAbort?.();
      plan.abort();
    }
    if (!result.unauthorized && !result.error) {
      params.assertCurrent?.();
      params.onCancellationStarted?.();
    }
  } catch (error) {
    failure = { error };
  }
  // Cancellation consumed these buffers before awaited descendant work could fail.
  let warning: string | undefined;
  try {
    warning = await plan.finish();
  } catch (error) {
    if (!failure) {
      throw error;
    }
    throw new AggregateError([failure.error, error], "Chat cancellation and persistence failed", {
      cause: error,
    });
  }
  if (failure) {
    throw abortedPartialPersistenceError(failure.error, warning);
  }
  return {
    ...result,
    aborted:
      result.aborted ||
      Boolean(descendants?.killed || descendants?.continuationRetired || descendants?.execAborted),
    descendants,
    ...(warning ? { warning } : {}),
  };
}
