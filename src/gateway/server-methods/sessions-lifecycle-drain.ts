import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  errorShape,
  type ErrorShape,
  type SessionWorkspaceRecoveryRequiredErrorDetails,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunInProgress,
  waitForEmbeddedAgentRunEnd,
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
} from "../../auto-reply/reply/reply-run-registry.js";
import { withTimeout } from "../../infra/fs-safe.js";
import {
  closeSessionWorkAdmissions,
  startSessionWorkAdmissionInterruption,
  isCompetingSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-lifecycle-admission.js";
import { waitForChatAbortControllerRemoval } from "../chat-abort-lifecycle-internal.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import type { AgentTerminalSessionDrain } from "../terminal/session-manager.types.js";
import {
  getWorkerInferenceSessionControl,
  type AcceptedWorkerInferenceSessionDrain,
  type WorkerInferenceSessionDrain,
} from "../worker-environments/inference-control-internal.js";
import type { WorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { isCurrentWorkerWorkspacePendingResultOwner } from "../worker-environments/placement-workspace-result.js";
import {
  prepareSessionWorkerPlacementArchiveCheckAsync,
  prepareSessionWorkerPlacementMutationCheckAsync,
  prepareSessionWorkerPlacementStop,
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
  authorize?: () => void;
  beforeCancel?: () => void;
  context: GatewayRequestContext;
  storePath: string;
  sessionKeys: string[];
  sessionId?: string;
  agentId: string;
  sessionKey: string;
  defaultAgentId?: string;
  lifecycleIdentities: string[];
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
  terminalDrain: AgentTerminalSessionDrain | undefined,
  queueTarget: SessionLifecycleQueueTarget,
): boolean {
  const sessionId = params.sessionId;
  return (
    isCompetingSessionWorkAdmissionActive(params.storePath, params.lifecycleIdentities) ||
    resolveReplyOperationsForSession(params).length > 0 ||
    Boolean(sessionId && isEmbeddedAgentRunInProgress(sessionId)) ||
    hasSessionLifecycleQueueWork(queueTarget) ||
    hasGatewaySessionAbortOwner({
      context: params.context,
      sessionKeys: params.sessionKeys,
      sessionId,
      agentId: params.agentId,
      defaultAgentId: params.defaultAgentId,
    }) ||
    Boolean(
      sessionId &&
      params.context.workerSessionPlacementService?.getMany([sessionId]).get(sessionId)?.turnClaim,
    ) ||
    workerDrain?.hasWork() === true ||
    terminalDrain?.hasWork() === true
  );
}

/** Drain outside mutation locks; retain the closure until the final mutation owns ingress. */
export async function prepareSessionLifecycleDrain(
  params: SessionLifecycleParams,
): Promise<SessionLifecycleDrain> {
  const timeoutMs = SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS;
  const queueTarget: SessionLifecycleQueueTarget = {
    keys: params.sessionKeys,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
  };
  const workerService = params.context.workerEnvironmentService;
  let workerDrain: AcceptedWorkerInferenceSessionDrain | undefined;
  let workerDrained: Promise<void> | undefined;
  let terminalDrain: AgentTerminalSessionDrain | undefined;
  let reclaimed: Promise<void> | undefined;
  let releaseAdmissions = () => {};
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    try {
      terminalDrain?.release();
    } finally {
      try {
        workerDrain?.release();
      } finally {
        releaseAdmissions();
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
        releaseAdmissions = closeSessionWorkAdmissions({
          scope: params.storePath,
          identities: params.lifecycleIdentities,
          reason: createAgentRunDirectAbortError(),
        });
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
            workerDrain.start();
          }
          terminalDrain = params.context.terminalSessions?.beginAgentSessionDrain({
            kind: "agent",
            agentSessionKey: params.sessionKey,
            agentSessionId: params.sessionId,
            agentId: params.agentId,
          });
        }

        // Capture dispatch custody before cancellation can settle its placement.
        if (workerStop.startBeforeDrain) {
          reclaimed = workerStop.stop();
          void reclaimed.catch(() => {});
        }
        let controllerDrain = Promise.resolve(true);
        const replyRuns = resolveReplyOperationsForSession(params);
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
          includeProtectedRuns: true,
          onControllerTargets: (targets) => {
            controllerDrain = waitForChatAbortControllerRemoval({
              entries: params.context.chatAbortControllers,
              targets,
              timeoutMs,
            });
          },
          onAuthorizedAfterQueuedAbort: () => {
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
            if (params.sessionId) {
              aborted = abortEmbeddedAgentRun(params.sessionId) || aborted;
            }
            return aborted;
          },
        });
        // Observe failures immediately while the short mutation releases its queues.
        void cancellation.catch(() => {});
        return { workerStop, cancellation, controllerDrain, replyRuns };
      },
    });
    const abortResult = await prepared.cancellation;
    if (abortResult.unauthorized) {
      throw new Error("Session cancellation lost ownership");
    }

    params.authorize?.();
    if (params.sessionId) {
      const placements = params.context.workerSessionPlacementService;
      const pending = (await placements?.listPendingWorkspaceResultsAsync?.(params.sessionId))?.[0];
      params.authorize?.();
      const placement = placements?.getMany([params.sessionId]).get(params.sessionId);
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
    const { released: admittedWork } = startSessionWorkAdmissionInterruption({
      scope: params.storePath,
      identities: params.lifecycleIdentities,
    });
    const replyWork = Promise.all(
      prepared.replyRuns.map((operation) =>
        waitForReplyOperationOwnerSettlement(operation, timeoutMs),
      ),
    ).then((results) => results.every(Boolean));
    const embeddedWork = params.sessionId
      ? waitForEmbeddedAgentRunEnd(params.sessionId, timeoutMs)
      : Promise.resolve(true);
    const placementService: LifecyclePlacementService | undefined =
      params.context.workerSessionPlacementService;
    const placement = params.sessionId
      ? placementService?.getMany([params.sessionId]).get(params.sessionId)
      : undefined;
    const placementWork = placement?.turnClaim
      ? placementService?.waitForTurnClaimRelease
        ? placementService
            .waitForTurnClaimRelease(params.sessionId!, { timeoutMs })
            .then(() => true)
        : Promise.resolve(false)
      : Promise.resolve(true);
    const waitForDrain = (work: Promise<void> | undefined, label: string) =>
      work ? withTimeout(work, timeoutMs, label).then(() => true) : Promise.resolve(true);
    const workerWork = waitForDrain(workerDrained, "worker inference lifecycle drain");
    const terminalWork = waitForDrain(terminalDrain?.drained, "agent terminal lifecycle drain");
    const drains = await Promise.all([
      prepared.controllerDrain,
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
    // Provider settlement keeps its placement custody and deadline. Only after reclaim
    // finishes does the ordinary admission bound apply, including for local sessions.
    await withTimeout(admittedWork, timeoutMs, "session work admission lifecycle drain");
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
        return hasAuthoritativeSessionWork(params, workerDrain, terminalDrain, queueTarget);
      },
    };
  } catch (error) {
    await reclaimed?.catch(() => {});
    if (workerDrained) {
      // Every failure after acceptance retains raw settlement outside the mutex,
      // including a timeout of the caller's wait or a later authority refusal.
      const failures = new Set([error]);
      const [settled] = await Promise.allSettled([workerDrained]);
      if (settled.status === "rejected") {
        failures.add(settled.reason);
      }
      try {
        release();
      } catch (releaseError) {
        failures.add(releaseError);
      }
      if (failures.size > 1) {
        throw new AggregateError([...failures], "Session lifecycle and worker settlement failed", {
          cause: error,
        });
      }
      throw error;
    }
    release();
    throw error;
  }
}
