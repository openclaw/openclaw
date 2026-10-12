import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  errorShape,
  type ErrorShape,
  type SessionWorkspaceRecoveryRequiredErrorDetails,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  captureEmbeddedRunDrainTarget,
  type EmbeddedRunDrainTarget,
} from "../../agents/embedded-agent-runner/runs.js";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import {
  clearSessionLifecycleQueues,
  hasSessionLifecycleQueueWork,
  type SessionLifecycleQueueTarget,
} from "../../auto-reply/reply/queue/cleanup.js";
import {
  isReplyOperationForSession,
  resolveReplyOperationsForSession,
  waitForReplyOperationOwnerSettlement,
  type ReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import { withTimeout } from "../../infra/fs-safe.js";
import type { AgentWorkAdmissionIdentity } from "../../sessions/session-agent-work-admission.js";
import {
  closeSessionWorkAdmissions,
  startSessionWorkAdmissionInterruption,
  isCompetingSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-lifecycle-admission.js";
import { waitForChatAbortControllerRemoval } from "../chat-abort-lifecycle-internal.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import type { ChatAbortControllerEntry } from "../chat-abort.types.js";
import type { AgentTerminalSessionDrain } from "../terminal/session-manager.types.js";
import {
  getWorkerInferenceSessionControl,
  type AcceptedWorkerInferenceSessionDrain,
  type WorkerInferenceSessionDrain,
} from "../worker-environments/inference-control-internal.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionPlacementRecord,
} from "../worker-environments/placement-store.js";
import { isCurrentWorkerWorkspacePendingResultOwner } from "../worker-environments/placement-workspace-result.js";
import type { WorkerWorkspacePendingResult } from "../worker-environments/placement-workspace-result.types.js";
import {
  prepareSessionWorkerPlacementArchiveCheckAsync,
  prepareSessionWorkerPlacementMutationCheckAsync,
  prepareSessionWorkerPlacementStop,
  readSessionWorkerPlacementAsync,
} from "../worker-environments/session-placement-lifecycle.js";
import { hasGatewaySessionAbortOwner } from "./chat-abort-authorization.js";
import { abortChatRunsForSessionKeyWithPartials } from "./chat-abort-runtime.js";
import type { GatewayRequestContext } from "./types.js";

type LifecyclePlacementService = NonNullable<
  GatewayRequestContext["workerSessionPlacementService"]
> &
  Partial<Pick<WorkerSessionPlacementStore, "waitForTurnClaimRelease">>;

type SessionLifecycleParams = {
  action: "archive" | "delete";
  timeoutMs?: number | null;
  authorize?: () => void;
  beforeCancel?: () => void;
  context: GatewayRequestContext;
  storePath: string;
  sessionKeys: string[];
  sessionId?: string;
  embeddedRun?: EmbeddedRunDrainTarget | null;
  agentId: string;
  sessionKey: string;
  defaultAgentId?: string;
  lifecycleIdentities: string[];
  admissionAgent?: AgentWorkAdmissionIdentity;
};

export type SessionLifecycleDrain = {
  handoffToMutation(): void;
  release(): void;
  hasAuthoritativeWork(): boolean;
};

export class SessionLifecycleWorkspaceRecoveryError extends Error {
  constructor(readonly error: ErrorShape) {
    super(error.message);
  }
}

function hasAuthoritativeSessionWork(
  params: SessionLifecycleParams,
  workerDrain: WorkerInferenceSessionDrain | undefined,
  terminalDrains: readonly AgentTerminalSessionDrain[],
  queueTarget: SessionLifecycleQueueTarget,
  embeddedRun: EmbeddedRunDrainTarget | undefined,
): boolean {
  const sessionId = params.sessionId;
  return (
    isCompetingSessionWorkAdmissionActive(
      params.storePath,
      params.lifecycleIdentities,
      params.admissionAgent,
    ) ||
    resolveReplyOperationsForSession(params).length > 0 ||
    embeddedRun?.isActive() === true ||
    hasSessionLifecycleQueueWork(queueTarget) ||
    hasGatewaySessionAbortOwner(params) ||
    Boolean(
      sessionId &&
      params.context.workerSessionPlacementService?.getMany([sessionId]).get(sessionId)?.turnClaim,
    ) ||
    workerDrain?.hasWork() === true ||
    terminalDrains.some((drain) => drain.hasWork())
  );
}

/** Drain outside mutation locks; retain the closure until the final mutation owns ingress. */
export async function prepareSessionLifecycleDrain(
  params: SessionLifecycleParams,
): Promise<SessionLifecycleDrain> {
  const timeoutMs =
    params.timeoutMs === undefined ? SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS : params.timeoutMs;
  const queueTarget: SessionLifecycleQueueTarget = {
    keys: params.sessionKeys,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
  };
  const workerService = params.context.workerEnvironmentService;
  let embeddedRun = params.embeddedRun ?? undefined;
  let workerDrain: AcceptedWorkerInferenceSessionDrain | undefined;
  let workerDrained: Promise<void> | undefined;
  const terminalDrains: AgentTerminalSessionDrain[] = [];
  let reclaimed: Promise<void> | undefined;
  let admittedWork: Promise<void> | undefined;
  let embeddedAborted = false;
  let replyRuns: ReplyOperation[] = [];
  let controllerTargets: Array<{ runId: string; entry: ChatAbortControllerEntry }> = [];
  let releaseAdmissions = () => {};
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    try {
      for (const drain of terminalDrains) {
        drain.release();
      }
    } finally {
      try {
        workerDrain?.release();
      } finally {
        releaseAdmissions();
        if (params.embeddedRun === undefined) {
          embeddedRun?.release();
        }
      }
    }
  };
  try {
    const prepared = await runExclusiveSessionLifecycleMutation("drain", {
      scope: params.storePath,
      identities: params.lifecycleIdentities,
      run: async () => {
        // Settle preceding mutations before selecting owners, but never await their
        // cancellation completion here: it may need placement and lifecycle recovery.
        params.authorize?.();
        params.beforeCancel?.();
        const workerStop = prepareSessionWorkerPlacementStop(params);
        params.authorize?.();
        releaseAdmissions = closeSessionWorkAdmissions({
          scope: params.storePath,
          identities: params.lifecycleIdentities,
          agent: params.admissionAgent,
          reason: createAgentRunDirectAbortError(),
          assertCurrent: params.authorize,
        });
        params.authorize?.();
        if (params.sessionId) {
          const reservation = getWorkerInferenceSessionControl(workerService)?.reserveSessionDrain(
            params.sessionId,
          );
          try {
            workerDrain = reservation?.accept();
          } catch (error) {
            try {
              reservation?.release();
            } catch (releaseError) {
              if (releaseError !== error) {
                throw new AggregateError([error, releaseError], "Worker drain reservation failed", {
                  cause: releaseError,
                });
              }
            }
            throw error;
          }
          if (workerDrain) {
            workerDrained = workerDrain.drained;
            void workerDrained.catch(() => {});
            workerDrain.start(params.authorize);
          }
          params.authorize?.();
          if (params.context.terminalSessions) {
            for (const sessionKey of new Set([params.sessionKey, ...params.sessionKeys])) {
              const drain = params.context.terminalSessions.beginAgentSessionDrain(
                {
                  kind: "agent",
                  agentSessionKey: sessionKey,
                  agentSessionId: params.sessionId,
                  agentId: params.agentId,
                },
                params.authorize,
              );
              terminalDrains.push(drain);
              void drain.drained.catch(() => {});
            }
          }
        }

        // Capture dispatch custody before cancellation can settle its placement.
        if (workerStop.startBeforeDrain) {
          reclaimed = workerStop.stop();
          void reclaimed.catch(() => {});
        }
        replyRuns = resolveReplyOperationsForSession(params);
        if (params.embeddedRun === undefined && params.sessionId) {
          embeddedRun = captureEmbeddedRunDrainTarget(params.sessionId, params);
        }
        const cancellation = abortChatRunsForSessionKeyWithPartials({
          context: params.context,
          ops: createChatAbortOps(params.context),
          sessionKey: params.sessionKeys[0]!,
          sessionKeyAliases: params.sessionKeys.slice(1),
          sessionId: params.sessionId,
          agentId: params.agentId,
          defaultAgentId: params.defaultAgentId,
          abortOrigin: "rpc",
          stopReason: params.action,
          requester: { isAdmin: true },
          stopEmbeddedRun: params.embeddedRun === undefined ? true : undefined,
          includeProtectedRuns: true,
          assertCurrent: params.authorize,
          onControllerTargets: (targets) => {
            controllerTargets = targets;
          },
          onAuthorizedBeforeEmbeddedAbort: () => {
            const cleared = clearSessionLifecycleQueues({
              ...queueTarget,
              assertCurrent: () => params.authorize?.(),
            });
            let aborted = cleared.followupCleared > 0 || cleared.laneCleared > 0;
            for (const operation of replyRuns) {
              params.authorize?.();
              if (isReplyOperationForSession(params, operation)) {
                aborted = operation.abortByUser() || aborted;
              }
            }
            // Agent deletion captured its exact owner before asynchronous inventory.
            // Ordinary session Stop owns embedded cancellation and its persistence.
            if (params.embeddedRun !== undefined || params.sessionKey === "global") {
              params.authorize?.();
              embeddedAborted = embeddedRun?.abort() === true;
              aborted = embeddedAborted || aborted;
            }
            return aborted;
          },
          onAuthorizedAfterQueuedAbort: ({ aborted }) => {
            embeddedAborted ||= aborted;
            return false;
          },
        });
        // Observe failures immediately while the short mutation releases its queues.
        void cancellation.catch(() => {});
        return { workerStop, cancellation };
      },
    });
    const abortResult = await prepared.cancellation;
    if (abortResult.unauthorized) {
      throw new Error("Session cancellation lost ownership");
    }

    params.authorize?.();
    const placementService: LifecyclePlacementService | undefined =
      params.context.workerSessionPlacementService;
    let placement: WorkerSessionPlacementRecord | undefined;
    if (params.sessionId) {
      const preparedPlacement = await placementService?.prepareRuntimeRefresh?.(params.sessionId);
      let pending: WorkerWorkspacePendingResult | undefined;
      try {
        pending = preparedPlacement
          ? preparedPlacement.pendingResult
          : (await placementService?.listPendingWorkspaceResultsAsync?.(params.sessionId))?.[0];
        placement = preparedPlacement
          ? preparedPlacement.placement
          : await readSessionWorkerPlacementAsync(params);
        params.authorize?.();
        preparedPlacement?.assertCurrent();
      } finally {
        preparedPlacement?.release();
      }
      if (
        pending &&
        pending.workspaceAcceptedAtMs === null &&
        isCurrentWorkerWorkspacePendingResultOwner(placement, pending) &&
        params.context.workerPlacementRunnerAvailabilityReader?.read(placement)?.status ===
          "offline"
      ) {
        const details: SessionWorkspaceRecoveryRequiredErrorDetails = {
          code: GatewayErrorDetailCodes.SESSION_WORKSPACE_RECOVERY_REQUIRED,
          cause: "device_offline",
          recoveryAction: "continue_on_gateway",
          sessionId: params.sessionId,
          source: {
            generation: placement.generation,
            environmentId: placement.environmentId,
            ownerEpoch: placement.activeOwnerEpoch,
          },
        };
        throw new SessionLifecycleWorkspaceRecoveryError(
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `Session ${params.sessionKey} has an unrecovered workspace result on an offline device. Reconnect the device to preserve its workspace, or use Continue on Gateway and accept that unsynced files may be lost.`,
            { details, retryable: false },
          ),
        );
      }
    }
    params.authorize?.();
    admittedWork = startSessionWorkAdmissionInterruption({
      scope: params.storePath,
      identities: params.lifecycleIdentities,
      agent: params.admissionAgent,
      assertCurrent: params.authorize,
    }).released;
    void admittedWork.catch(() => {});
    const replyWork = Promise.all(
      replyRuns.map((operation) => waitForReplyOperationOwnerSettlement(operation, timeoutMs)),
    ).then((results) => results.every(Boolean));
    const embeddedWork = embeddedRun?.waitForEnd(timeoutMs) ?? Promise.resolve(true);
    const placementWork = placement?.turnClaim
      ? placementService?.waitForTurnClaimRelease
        ? placementService
            .waitForTurnClaimRelease(params.sessionId!, { timeoutMs: timeoutMs ?? undefined })
            .then(() => true)
        : Promise.resolve(false)
      : Promise.resolve(true);
    const waitForDrain = (work: Promise<void> | undefined, label: string) =>
      work
        ? (timeoutMs === null ? work : withTimeout(work, timeoutMs, label)).then(() => true)
        : Promise.resolve(true);
    const workerWork = waitForDrain(workerDrained, "worker inference lifecycle drain");
    const terminalWork = Promise.all(
      terminalDrains.map((drain) => waitForDrain(drain.drained, "agent terminal lifecycle drain")),
    ).then((results) => results.every(Boolean));
    const drains = await Promise.all([
      waitForChatAbortControllerRemoval({
        entries: params.context.chatAbortControllers,
        targets: controllerTargets,
        timeoutMs,
      }),
      replyWork,
      embeddedWork,
      placementWork,
      workerWork,
      terminalWork,
    ]);
    if (!drains.every(Boolean)) {
      throw new Error("Session work is still active after the lifecycle drain");
    }
    // Failed placements keep cleanup custody without delaying archive visibility.
    // Other placements and destructive deletion still require safe reclaim.
    await (reclaimed ?? prepared.workerStop.stop());
    // Provider settlement keeps its placement custody. Admission settlement follows
    // reclaim, including for local sessions.
    await waitForDrain(admittedWork, "session work admission lifecycle drain");
    const placementTarget = { context: params.context, sessionId: params.sessionId };
    const assertPlacementCurrent =
      params.action === "archive"
        ? (await prepareSessionWorkerPlacementArchiveCheckAsync(placementTarget)).assertCurrent
        : await prepareSessionWorkerPlacementMutationCheckAsync(placementTarget);
    return {
      // Only the caller's active mutation may replace this mutex-free ingress lease.
      handoffToMutation: () => releaseAdmissions(),
      release,
      hasAuthoritativeWork: () => {
        try {
          assertPlacementCurrent();
        } catch {
          return true;
        }
        return hasAuthoritativeSessionWork(
          params,
          workerDrain,
          terminalDrains,
          queueTarget,
          embeddedRun,
        );
      },
    };
  } catch (error) {
    // Accepted worker writes retain cleanup custody even after a caller timeout.
    // Only agent deletion additionally joins unbounded local runtime settlement.
    const settled = await Promise.allSettled([
      reclaimed,
      workerDrained,
      ...(timeoutMs === null
        ? [
            ...terminalDrains.map((drain) => drain.drained),
            admittedWork,
            embeddedAborted ? embeddedRun?.waitForEnd(null) : undefined,
            ...replyRuns
              .filter((operation) => operation.abortSignal.aborted)
              .map((operation) => waitForReplyOperationOwnerSettlement(operation, null)),
            waitForChatAbortControllerRemoval({
              entries: params.context.chatAbortControllers,
              targets: controllerTargets.filter(({ entry }) => entry.controller.signal.aborted),
              timeoutMs: null,
            }),
          ]
        : []),
    ]);
    const failures = new Set([
      error,
      ...settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    ]);
    try {
      release();
    } catch (releaseError) {
      failures.add(releaseError);
    }
    if (failures.size > 1) {
      throw new AggregateError([...failures], "Session lifecycle and settlement failed", {
        cause: error,
      });
    }
    throw error;
  }
}
