import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  errorShape,
  type ErrorShape,
  type SessionWorkspaceRecoveryRequiredErrorDetails,
} from "../../../packages/gateway-protocol/src/index.js";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import { withTimeout } from "../../infra/fs-safe.js";
import {
  captureSessionTarget,
  closeSessionControllerAdmission,
  hasSessionControllerQueuedWork,
  isCompetingSessionControllerWorkActive,
  runSessionMutation,
  startSessionControllerInterruption,
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-controller.lifecycle.js";
import { waitForReplyOperationOwnerSettlement } from "../../sessions/session-controller.settlement.js";
import { waitForChatAbortControllerRemoval } from "../chat-abort-lifecycle-internal.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
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
import { isCurrentWorkerWorkspacePendingResultOwner } from "../worker-environments/placement-workspace-result-owner.js";
import type { WorkerWorkspacePendingResult } from "../worker-environments/placement-workspace-result.types.js";
import {
  prepareSessionWorkerPlacementArchiveCheckAsync,
  prepareSessionWorkerPlacementMutationCheckAsync,
  prepareSessionWorkerPlacementStop,
  readSessionWorkerPlacementAsync,
} from "../worker-environments/session-placement-lifecycle.js";
import { hasGatewaySessionAbortOwner } from "./chat-abort-authorization.js";
import { abortChatRunsForSessionKeyWithPartials } from "./chat-abort-runtime.js";
import type { ChatAbortSessionSnapshot } from "./chat-aborted-partial.js";
import type { GatewayRequestContext } from "./types.js";

type SessionLifecycleParams = {
  action: "archive" | "delete";
  authorize?: () => void;
  beforeCancel?: () => void | Promise<void>;
  onPrepared?: () => void;
  context: GatewayRequestContext;
  storePath: string;
  sessionKeys: string[];
  sessionId?: string;
  session?: ChatAbortSessionSnapshot;
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
  terminalDrains: readonly AgentTerminalSessionDrain[],
): boolean {
  const sessionId = params.sessionId;
  return (
    isCompetingSessionControllerWorkActive(
      params.storePath,
      params.lifecycleIdentities,
      params.agentId,
    ) ||
    hasSessionControllerQueuedWork(params.storePath, params.lifecycleIdentities, params.agentId) ||
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
  const timeoutMs = SESSION_CONTROLLER_DRAIN_TIMEOUT_MS;
  const target = captureSessionTarget({
    storeScope: params.storePath,
    sessionKey: params.sessionKey,
    aliases: params.lifecycleIdentities,
    agentId: params.agentId,
    incarnation: params.sessionId,
  });
  const workerService = params.context.workerEnvironmentService;
  let workerDrain: AcceptedWorkerInferenceSessionDrain | undefined;
  let workerDrained: Promise<void> | undefined;
  const terminalDrains: AgentTerminalSessionDrain[] = [];
  let reclaimed: Promise<void> | undefined;
  let admittedWork: Promise<void> | undefined;
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
      }
    }
  };
  try {
    let preparedDrain:
      | {
          workerStop: Awaited<ReturnType<typeof prepareSessionWorkerPlacementStop>>;
          cancellation: ReturnType<typeof abortChatRunsForSessionKeyWithPartials>;
          controllerDrain: () => Promise<boolean>;
        }
      | undefined;
    const prepared = await runSessionMutation({
      diagnosticLabel: "drain",
      target,
      kind: "delete",
      policy: "allow-live",
      assertCurrent: params.authorize,
      prepare: async ({ operations }) => {
        // Settle preceding mutations before selecting owners, but never await their
        // cancellation completion here: it may need placement and lifecycle recovery.
        params.authorize?.();
        if (params.beforeCancel) {
          await params.beforeCancel();
          params.authorize?.();
        }
        const workerStop = await prepareSessionWorkerPlacementStop(params);
        params.authorize?.();
        params.onPrepared?.();
        releaseAdmissions = closeSessionControllerAdmission({
          target,
          reason: createAgentRunDirectAbortError(),
          assertCurrent: params.authorize,
        });
        params.authorize?.();
        if (params.sessionId) {
          workerDrain = getWorkerInferenceSessionControl(workerService)?.reserveSessionDrain(
            params.sessionId,
          );
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
        let controllerTargets: Parameters<typeof waitForChatAbortControllerRemoval>[0]["targets"] =
          [];
        const cancellation = abortChatRunsForSessionKeyWithPartials({
          context: params.context,
          ops: createChatAbortOps(params.context),
          sessionKey: params.sessionKey,
          sessionKeyAliases: params.sessionKeys.filter((key) => key !== params.sessionKey),
          sessionId: params.sessionId,
          session: params.session,
          controllerTargets: [target],
          agentId: params.agentId,
          defaultAgentId: params.defaultAgentId,
          abortOrigin: "rpc",
          stopReason: params.action,
          stopSource: "mutation",
          requester: { isAdmin: true },
          cascadeDescendants: true,
          includeProtectedRuns: true,
          assertCurrent: params.authorize,
          onControllerTargets: (targets) => {
            controllerTargets = targets;
          },
        });
        // Observe failures immediately while the short mutation releases its queues.
        void cancellation.catch(() => {});
        preparedDrain = {
          workerStop,
          cancellation,
          controllerDrain: () =>
            Promise.all([
              waitForChatAbortControllerRemoval({ targets: controllerTargets, timeoutMs }),
              ...operations.map((operation) =>
                waitForReplyOperationOwnerSettlement(operation, timeoutMs),
              ),
            ]).then((results) => results.every(Boolean)),
        };
      },
      run: async () => {
        if (!preparedDrain) {
          throw new Error("Session lifecycle drain was not prepared");
        }
        return preparedDrain;
      },
    });
    const abortResult = await prepared.cancellation;
    if (abortResult.unauthorized) {
      throw new Error("Session cancellation lost ownership");
    }
    if (abortResult.error) {
      throw new Error(abortResult.error.message);
    }
    // Start the captured producers' drain deadline before later placement reads.
    const controllerDrain = prepared.controllerDrain();
    void controllerDrain.catch(() => {});

    // Early reclaim owns dispatch cancellation and settlement. Join its writes before
    // capturing runtime authority, or our own cleanup can invalidate that snapshot.
    await reclaimed;
    params.authorize?.();
    const placementService:
      | (NonNullable<GatewayRequestContext["workerSessionPlacementService"]> &
          Partial<Pick<WorkerSessionPlacementStore, "waitForTurnClaimRelease" | "readProjection">>)
      | undefined = params.context.workerSessionPlacementService;
    let placement: WorkerSessionPlacementRecord | undefined;
    if (params.sessionId) {
      // Cleanup can advance placement while this consistent snapshot is in flight.
      const projection = await placementService?.readProjection?.([params.sessionId], {
        current: true,
      });
      // Released custom readers may expose only the prepared-read contract.
      const preparedPlacement = projection
        ? undefined
        : await placementService?.prepareRuntimeRefresh?.(params.sessionId);
      let pending: WorkerWorkspacePendingResult | undefined;
      try {
        pending = projection
          ? projection.pendingResults.get(params.sessionId)
          : preparedPlacement
            ? preparedPlacement.pendingResult
            : (await placementService?.listPendingWorkspaceResultsAsync?.(params.sessionId))?.[0];
        placement = projection
          ? projection.placements.get(params.sessionId)
          : preparedPlacement
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
    admittedWork = startSessionControllerInterruption({
      target,
      admissionsOnly: true,
      assertCurrent: params.authorize,
    }).released;
    void admittedWork.catch(() => {});
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
    const terminalWork = Promise.all(
      terminalDrains.map((drain) => waitForDrain(drain.drained, "agent terminal lifecycle drain")),
    ).then((results) => results.every(Boolean));
    const drains = await Promise.all([controllerDrain, placementWork, workerWork, terminalWork]);
    if (!drains.every(Boolean)) {
      throw new Error(
        `Session work is still active after the lifecycle drain for ${params.sessionKey}. Wait for active work to end, then retry; session storage has been preserved.`,
      );
    }
    // Failed placements keep cleanup custody without delaying archive visibility.
    // Other placements and destructive deletion still require safe reclaim.
    await (reclaimed ?? prepared.workerStop.stop());
    // Generic preparation effects have no turn for Stop to cancel; join their controller custody.
    await waitForDrain(admittedWork, "session effect lifecycle drain");
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
        return hasAuthoritativeSessionWork(params, workerDrain, terminalDrains);
      },
    };
  } catch (error) {
    // Accepted worker writes retain cleanup custody even after a caller timeout.
    const settled = await Promise.allSettled([reclaimed, workerDrained]);
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
