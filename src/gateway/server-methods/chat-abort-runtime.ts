import type { Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { killSubagentRunAdmin } from "../../agents/subagents/registry/subagent-control-kill.js";
import {
  ensureSubagentControllerOwnsRun,
  listControlledSubagentRunsForTurn,
} from "../../agents/subagents/registry/subagent-control-scope.js";
import {
  killAllControlledSubagentRuns,
  resolveSubagentController,
} from "../../agents/subagents/registry/subagent-control.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  isSubagentRunQueued,
} from "../../agents/subagents/registry/subagent-registry-read.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../../tasks/detached-task-runtime-contract.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import {
  abortChatRunById,
  isChatAbortControllerEntryAbortable,
  type ChatAbortControllerEntry,
  type ChatAbortOps,
} from "../chat-abort.js";
import { abortQueuedChatTurnById } from "../chat-queued-turns.js";
// Cancellation orchestration across active, queued, pending, and worker runs.
import { resolveChatRunOwnerAgentId } from "../chat-run-owner.js";
import { errorShapeFromError } from "../error-shape.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX } from "../server-shared.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { resolveSessionStoreKey } from "../session-utils.js";
import {
  captureWorkerInferenceCancellation,
  type WorkerInferenceCancellation,
} from "../worker-environments/inference-control-internal.js";
import {
  canRequesterAbortChatRun,
  resolveAuthorizedPreRegisteredRunsForSessionKeys,
  resolveAuthorizedRunsForSessionKeys,
  resolveAuthorizedQueuedTurnsForSession,
  writePreRegisteredAgentAbort,
  writePreRegisteredChatAbort,
  type ChatAbortRequester,
} from "./chat-abort-authorization.js";
import {
  abortedPartialPersistenceError,
  captureAbortedPartial,
  deferAbortedPartialPersistence,
  withAbortedPartialPersistenceWarning,
  type AbortedPartialSnapshot,
  type ChatAbortOrigin,
  type ChatAbortSessionSnapshot,
} from "./chat-aborted-partial.js";
import {
  normalizeOptionalChatText as normalizeOptionalText,
  normalizeUnknownChatText as normalizeUnknownText,
} from "./chat-text-normalization.js";
import { persistAbortedPartials } from "./chat-transcript-persistence.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestContext } from "./types.js";

export async function abortControlledSubagents(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  requesterTurnRunId?: string;
  assertCurrent?: () => void;
  beforeKill?: Parameters<typeof killAllControlledSubagentRuns>[0]["beforeKill"];
}) {
  const controller = resolveSubagentController({
    cfg: params.cfg,
    agentSessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  const runs = listControlledSubagentRunsForTurn(controller, params.requesterTurnRunId);
  if (runs.length === 0) {
    await params.beforeKill?.();
    return undefined;
  }
  return killAllControlledSubagentRuns({
    cfg: params.cfg,
    controller,
    runs,
    suppressTaskDelivery: true,
    assertCurrent: params.assertCurrent,
    beforeKill: params.beforeKill,
  });
}

export function descendantAbortError(
  result: Awaited<ReturnType<typeof abortControlledSubagents>> | undefined,
  subject: "Parent run" | "Session",
) {
  return result && result.status !== "ok"
    ? errorShape(
        ErrorCodes.UNAVAILABLE,
        `${subject} stopped, but descendant cancellation was incomplete: ${result.error}`,
      )
    : undefined;
}

type QueuedCollectorAbortOutcome = Result<
  { aborted: boolean; runIds: string[]; warning?: string },
  ErrorShape
>;

function withQueuedCollectorWarning(
  outcome: QueuedCollectorAbortOutcome,
  warning: string,
): QueuedCollectorAbortOutcome {
  return outcome.ok
    ? { ok: true, value: { ...outcome.value, warning } }
    : { ok: false, error: withAbortedPartialPersistenceWarning(outcome.error, warning) };
}

/** Queued collectors retain scheduler ownership while Gateway admission is still pending. */
export function abortQueuedCollectorSession(
  params: Omit<ChatSessionAbortParams, "ops"> & { runId?: string },
): Promise<QueuedCollectorAbortOutcome> | undefined {
  const entry = getLatestLiveSubagentRunByChildSessionKey(params.sessionKey);
  if (
    !entry ||
    !isSubagentRunQueued(entry) ||
    params.excludeRunIds?.has(entry.runId) ||
    (params.runId && entry.runId !== params.runId)
  ) {
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
    if (entry.execution.status === "queued" && !isSubagentRunQueued(entry)) {
      throw new Error("Queued collector reservation changed; retry Stop.");
    }
    const ownershipError = ensureSubagentControllerOwnsRun({ cfg, controller, entry });
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
    let sessionAbort:
      | Result<
          {
            plan: ReturnType<typeof prepareChatSessionAbort>;
            result: ChatSessionAbortResult;
          },
          ErrorShape
        >
      | undefined;
    let outcome: QueuedCollectorAbortOutcome = {
      ok: false,
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        "Queued collector cancellation was not published; retry Stop.",
      ),
    };
    try {
      assertCurrent();
      const projection = getSessionRowProjection(params.context);
      if (projection) {
        do {
          await projection.ensureMaterialized();
        } while (projection.needsMaterialization);
      }
      assertCurrent();
      const agentId = resolveChatRunOwnerAgentId({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        defaultAgentId: params.defaultAgentId,
      });
      const captured = agentId
        ? projection?.capture({ agentId, key: params.sessionKey })
        : undefined;
      await killSubagentRunAdmin(
        {
          cfg,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          expectedRunId: entry.runId,
          expectedGeneration: entry.generation,
          expectedOwnerKey: entry.requesterSessionKey,
          onResult: (result) => {
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
            if (selected && !selected.plan.canCascade) {
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
            const aborted =
              result.found &&
              result.killed &&
              result.targetState?.state === "terminal" &&
              result.targetState.task.status === "cancelled" &&
              result.targetState.task.error === SUBAGENT_KILL_TASK_ERROR;
            // Publish while the kill owner still holds the exact session incarnation,
            // never after an awaited result can be overtaken by its replacement.
            if (aborted) {
              emitSessionsChanged(
                params.context,
                {
                  sessionKey: params.sessionKey,
                  agentId: params.agentId,
                  sessionId: params.sessionId,
                  reason: "abort",
                },
                { preparedPublication: true },
              );
            }
            outcome = {
              ok: true,
              value: {
                aborted: aborted || selected?.result.aborted === true,
                runIds: [
                  ...new Set([
                    ...(aborted ? [result.runId] : []),
                    ...(selected?.result.runIds ?? []),
                  ]),
                ],
              },
            };
          },
        },
        {
          assertCurrent,
          preparePublication: {
            needsPreparation: () => projection?.needsMaterialization === true,
            prepare: async () => {
              await projection?.ensureMaterialized();
              if (captured && !projection?.isCurrent(captured)) {
                throw new Error(
                  "Queued collector session changed before cancellation publication; retry Stop.",
                );
              }
            },
          },
          beforeSessionKill: () => {
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
              value: { plan, result: plan.result },
            };
            plan.abort();
            return plan.canCascade;
          },
        },
      );
    } catch (error) {
      outcome = {
        ok: false,
        error: errorShapeFromError(ErrorCodes.INVALID_REQUEST, error),
      };
    } finally {
      // Gateway cancellation already consumed these buffers. Preserve their snapshots
      // after later owner failures; the transcript writer still fences the session.
      if (sessionAbort?.ok) {
        try {
          const warning = await sessionAbort.value.plan.finish(sessionAbort.value.result);
          if (warning) {
            outcome = withQueuedCollectorWarning(outcome, warning);
          }
        } catch (error) {
          if (outcome.ok) {
            outcome = {
              ok: false,
              error: errorShapeFromError(ErrorCodes.INVALID_REQUEST, error),
            };
          } else {
            params.context.logGateway.warn(
              "chat.abort could not persist captured output after cancellation was rejected",
            );
          }
        }
      }
    }
    return outcome;
  })();
}

export function captureWorkerInferenceForSession(params: {
  context: GatewayRequestContext;
  sessionId?: string;
  runId?: string;
}): WorkerInferenceCancellation | undefined {
  const sessionId = normalizeOptionalText(params.sessionId);
  if (!sessionId) {
    return undefined;
  }
  return captureWorkerInferenceCancellation(
    params.context.workerEnvironmentService,
    sessionId,
    params.runId,
  );
}

type ChatSessionAbortParams = {
  context: GatewayRequestContext;
  ops: ChatAbortOps;
  sessionKey: string;
  sessionKeyAliases?: string[];
  agentId?: string;
  sessionId?: string;
  /** Supplied only by narrow admission, from its original materialized target. */
  requiredSessionId?: string;
  session?: ChatAbortSessionSnapshot;
  defaultAgentId?: string;
  abortOrigin: ChatAbortOrigin;
  stopReason?: string;
  requester: ChatAbortRequester;
  assertCurrent?: () => void;
  preserveSideRuns?: boolean;
  cascadeDescendants?: true;
  /** Exact lifecycle owners may include hidden and side runs for this one session. */
  includeProtectedRuns?: boolean;
  excludeRunIds?: ReadonlySet<string>;
  /** Captures exact registrations before cancellation can remove them. */
  onControllerTargets?: (
    targets: Array<{ runId: string; entry: ChatAbortControllerEntry }>,
  ) => void;
  /** Internal session-wide cleanup after exact resolution and all matching owner checks. */
  onAuthorizedAfterQueuedAbort?: () => boolean;
  /** Runs after authorized synchronous abort, before terminal/partial persistence can yield. */
  onCancellationStarted?: () => void;
};

type ChatSessionAbortResult = {
  aborted: boolean;
  runIds: string[];
  unauthorized: boolean;
  error?: ErrorShape;
  warning?: string;
  descendants?: Awaited<ReturnType<typeof abortControlledSubagents>>;
};

/** Resolve once at the cancellation boundary; persist captured partials only after Stop. */
function prepareChatSessionAbort(
  params: ChatSessionAbortParams,
  workerCancellation: WorkerInferenceCancellation | undefined,
  selectedRunId?: string,
) {
  const sessionKeys = [params.sessionKey, ...(params.sessionKeyAliases ?? [])];
  const queuedPlan = resolveAuthorizedQueuedTurnsForSession({
    context: params.context,
    sessionKeys,
    sessionId: params.sessionId,
    requiredSessionId: params.requiredSessionId,
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
    excludeRunIds: params.excludeRunIds,
  });
  const {
    authorizedRuns,
    matchedRunIds: matchedActiveRunIds,
    hasUnauthorizedRuns: hasUnauthorizedActiveRuns,
    hasUnauthorizedProtectedRuns: hasUnauthorizedProtectedActiveRuns,
    hasProtectedRuns: hasProtectedActiveRuns,
  } = resolveAuthorizedRunsForSessionKeys({
    chatAbortControllers: params.context.chatAbortControllers,
    sessionKeys,
    sessionIds: [params.sessionId],
    requiredSessionId: params.requiredSessionId,
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
    preserveSideRuns: params.preserveSideRuns,
    includeProtectedRuns: params.includeProtectedRuns,
    excludeRunIds: params.excludeRunIds,
  });
  const resolvePendingRuns = (keyPrefix: string) =>
    resolveAuthorizedPreRegisteredRunsForSessionKeys({
      context: params.context,
      sessionKeys,
      requiredSessionId: params.requiredSessionId,
      agentId: params.agentId,
      defaultAgentId: params.defaultAgentId,
      requester: params.requester,
      keyPrefix,
      preserveSideRuns: params.preserveSideRuns,
      includeProtectedRuns: params.includeProtectedRuns,
      excludeRunIds: params.excludeRunIds,
    });
  const pendingAgent = resolvePendingRuns("agent:");
  const pendingChat = resolvePendingRuns(PENDING_CHAT_SEND_DEDUPE_PREFIX);
  const pendingPlans = [pendingAgent, pendingChat];
  const hasAuthorizedGatewayRuns =
    authorizedRuns.length > 0 ||
    queuedPlan.authorized.length > 0 ||
    pendingPlans.some((plan) => plan.authorizedRuns.length > 0);
  const isLifecycleAbort = Boolean(
    params.cascadeDescendants || params.onAuthorizedAfterQueuedAbort,
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
    hasUnauthorizedActiveRuns ||
    queuedPlan.hasUnauthorizedRuns ||
    pendingPlans.some((plan) => plan.hasUnauthorizedRuns) ||
    (hasWorkerRun && !hasControllerRepresentedWorkerRun && !params.requester.isAdmin);
  const hasProtectedLifecycleRuns =
    hasProtectedActiveRuns || pendingPlans.some((plan) => plan.hasProtectedRuns);
  const hasUnauthorizedProtectedOwner =
    hasUnauthorizedProtectedActiveRuns ||
    pendingPlans.some((plan) => plan.hasUnauthorizedProtectedRuns);
  const hasUnauthorizedLifecycleOwner = isLifecycleAbort && hasUnauthorizedProtectedOwner;
  const canRunLifecycleCleanup = !hasUnauthorizedOwner && !hasProtectedLifecycleRuns;
  // Keep ordinary chat.abort's admin worker behavior; only the injected broad
  // lifecycle path must preserve hidden or explicitly preserved Gateway runs.
  const canCancelWorkerSession = !isLifecycleAbort || !hasProtectedLifecycleRuns;
  let snapshots: AbortedPartialSnapshot[] = [];
  // Reentrant cancellation can revoke the next effect. Keep committed outcomes
  // available to the partial-persistence owner even when abort() then throws.
  const result: ChatSessionAbortResult = { aborted: false, runIds: [], unauthorized: false };
  const recordRun = (runId: string) => {
    result.aborted = true;
    if (!result.runIds.includes(runId)) {
      result.runIds.push(runId);
    }
  };
  const abortAdditional = () => {
    if (canRunLifecycleCleanup && params.onAuthorizedAfterQueuedAbort) {
      params.assertCurrent?.();
      result.aborted = params.onAuthorizedAfterQueuedAbort() || result.aborted;
    }
  };
  const abortAuthorizedRuns = () => {
    params.assertCurrent?.();
    params.onControllerTargets?.(authorizedRuns);
    if (!hasAuthorizedGatewayRuns) {
      // The injected lifecycle callback must not turn a persisted session id into
      // a bypass around a matching connection or protected run owner.
      if (hasUnauthorizedOwner || hasUnauthorizedLifecycleOwner) {
        result.unauthorized = true;
        return result;
      }
      // With no owned Gateway run, the exact persisted session is the boundary,
      // matching sessions.steer's operator.write behavior for ownerless work.
      abortAdditional();
      if (!hasWorkerRun || !params.requester.isAdmin || !canCancelWorkerSession) {
        return result;
      }
      params.assertCurrent?.();
      workerCancellation?.cancel({ assertCurrent: params.assertCurrent, onCancelled: recordRun });
      return result;
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
    for (const { runId, sessionKey, payload } of pendingAgent.authorizedRuns) {
      params.assertCurrent?.();
      if (
        writePreRegisteredAgentAbort({
          context: params.context,
          runId,
          sessionKey,
          payload,
          expectedPayload: payload,
          stopReason,
          endedAt,
        })
      ) {
        recordRun(runId);
      }
    }
    for (const { runId, payload } of pendingChat.authorizedRuns) {
      params.assertCurrent?.();
      if (
        writePreRegisteredChatAbort({
          context: params.context,
          runId,
          stopReason,
          endedAt,
          attemptId: normalizeUnknownText(payload.attemptId),
          expectedPayload: payload,
        })
      ) {
        recordRun(runId);
      }
    }
    if (params.requester.isAdmin && canCancelWorkerSession) {
      params.assertCurrent?.();
      workerCancellation?.cancel({ assertCurrent: params.assertCurrent, onCancelled: recordRun });
    }
    return result;
  };
  const hasOtherWork =
    matchedActiveRunIds.some((runId) => runId !== selectedRunId) ||
    queuedPlan.matchedRunIds.some((runId) => runId !== selectedRunId) ||
    pendingPlans.some((plan) => plan.matchedRunIds.some((runId) => runId !== selectedRunId)) ||
    (hasWorkerRun && (!selectedRunId || !workerCancellation?.runIds.includes(selectedRunId)));
  return {
    canCascade: canRunLifecycleCleanup && !hasUnauthorizedLifecycleOwner,
    hasOtherWork,
    result,
    abort: abortAuthorizedRuns,
    async finish(outcome: Pick<ChatSessionAbortResult, "aborted" | "runIds">) {
      let warning: string | undefined;
      if (outcome.aborted && snapshots.length > 0) {
        const abortedRunIds = new Set(outcome.runIds);
        warning = await persistAbortedPartials({
          context: params.context,
          snapshots: snapshots.filter((snapshot) => abortedRunIds.has(snapshot.runId)),
        });
      }
      if (params.session && !params.session.ok) {
        throw params.session.error;
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
  let result = plan.result;
  let descendants: Awaited<ReturnType<typeof abortControlledSubagents>>;
  let failure: { error: unknown } | undefined;
  try {
    if (params.cascadeDescendants && plan.canCascade) {
      descendants = await abortControlledSubagents({
        cfg: params.session?.ok ? params.session.value.cfg : params.context.getRuntimeConfig(),
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        assertCurrent: params.assertCurrent,
        beforeKill: () => {
          result = plan.abort();
          return true;
        },
      });
    } else {
      result = plan.abort();
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
    warning = await plan.finish(result);
  } catch (error) {
    if (!failure) {
      throw error;
    }
    params.context.logGateway.warn(
      "chat.abort could not persist captured output after cancellation was rejected",
    );
  }
  if (failure) {
    throw abortedPartialPersistenceError(failure.error, warning);
  }
  return {
    ...result,
    aborted: result.aborted || Boolean(descendants?.killed),
    descendants,
    ...(warning ? { warning } : {}),
  };
}
