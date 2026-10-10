import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import {
  isUnavailableEnvironment,
  type WorkerDispatchPlacement,
} from "./placement-dispatch-failure.js";
import {
  forceAbandonWorkerEnvironment,
  reportWorkerAbandonmentCleanupError,
} from "./placement-force-abandon.js";
import type { WorkerPlacementMoveIntent } from "./placement-move-intent.js";
import type { WorkerPlacementRunnerAvailabilityReader } from "./placement-projector.js";
import {
  FORCED_WORKER_ABANDONMENT_ERROR,
  isForceAbandonedWorkerPlacement,
} from "./placement-record.js";
import type { PlacementRecoveryDeps } from "./placement-recovery-contract.js";
import {
  matchesWorkerPlacementTarget,
  type WorkerPlacementCancellationTarget,
} from "./placement-target.js";
import type {
  WorkerPlacementAuthorization,
  WorkerPlacementMoveRequest,
  WorkerPlacementReclaimRequest,
} from "./service-contract.js";

export function createWorkerPlacementMoveAbandonment(
  options: Pick<
    PlacementRecoveryDeps,
    | "placements"
    | "environments"
    | "workspaceOperations"
    | "resolveWorkspace"
    | "prepareGatewayMove"
  > & { runnerAvailability: WorkerPlacementRunnerAvailabilityReader },
) {
  const { environments, placements } = options;
  const forceDestroyEnvironment = async (
    environmentId: string,
    onCleanupError?: (error: unknown) => void,
  ) =>
    await options.workspaceOperations.run(environmentId, async () => {
      // Capture the selected owner before journal cleanup can yield to a replacement.
      const environment = environments.get(environmentId);
      const sessionId = environment?.attachedSessionIds[0];
      const abandonment =
        environment?.providerId === DEVICE_WORKER_PROVIDER_ID &&
        environment.nodeDeviceId &&
        environment.sharedHost !== false &&
        environment.attachedSessionIds.length === 1 &&
        sessionId
          ? { sessionId, ownerEpoch: environment.ownerEpoch }
          : undefined;
      try {
        return await environments.destroy(environmentId, abandonment, async () => {
          await forceAbandonWorkerEnvironment({
            placements,
            environmentId,
            resolveWorkspace: options.resolveWorkspace,
            onCleanupError,
          });
        });
      } catch (error) {
        const current = environments.get(environmentId);
        if (!current || !isUnavailableEnvironment(current)) {
          throw error;
        }
        reportWorkerAbandonmentCleanupError(onCleanupError, error);
        return current;
      }
    });

  const validateAbandonSource = (
    request: WorkerPlacementMoveRequest,
    current: WorkerDispatchPlacement | undefined,
  ): void => {
    if (
      (current?.state !== "active" && !isForceAbandonedWorkerPlacement(current)) ||
      current.generation !== request.source.generation ||
      current.environmentId !== request.source.environmentId ||
      current.activeOwnerEpoch !== request.source.ownerEpoch
    ) {
      throw new Error(`Cannot abandon stale worker placement for session ${request.sessionKey}`);
    }
    if (isForceAbandonedWorkerPlacement(current)) {
      return;
    }
    const runner = options.runnerAvailability.read(current);
    if (!runner) {
      throw new Error(
        "Continue on Gateway can abandon only an active paired-device placement with a known runner binding",
      );
    }
    if (runner.status === "available") {
      throw new Error(
        "Device runner is available; use Move session so OpenClaw can reconcile its workspace safely",
      );
    }
  };

  const abandonSource = async (
    request: WorkerPlacementReclaimRequest,
    intent: WorkerPlacementMoveIntent,
    authorize?: WorkerPlacementAuthorization,
    expectedSource?: WorkerPlacementCancellationTarget,
  ): Promise<Extract<WorkerDispatchPlacement, { state: "local" }>> => {
    const fenced = await options.workspaceOperations.run(intent.source.environmentId, async () => {
      const { placement: current, move } = await placements.getWithMoveAsync(request.sessionId);
      authorize?.();
      if (
        !current ||
        (expectedSource !== undefined && !matchesWorkerPlacementTarget(current, expectedSource)) ||
        (current.state !== "active" &&
          current.state !== "draining" &&
          current.state !== "reconciling" &&
          current.state !== "failed") ||
        current.sessionKey !== request.sessionKey ||
        current.agentId !== request.agentId ||
        current.environmentId !== intent.source.environmentId ||
        current.activeOwnerEpoch !== intent.source.ownerEpoch ||
        move?.operationId !== intent.operationId ||
        !move.abandonSource ||
        move.target.kind !== "gateway" ||
        move.source.generation !== intent.source.generation ||
        move.source.environmentId !== intent.source.environmentId ||
        move.source.ownerEpoch !== intent.source.ownerEpoch
      ) {
        throw new Error(`Session ${request.sessionKey} abandonment source changed before teardown`);
      }
      const failedPlacements = await forceAbandonWorkerEnvironment({
        placements,
        environmentId: intent.source.environmentId,
        resolveWorkspace: options.resolveWorkspace,
      });
      const failed = failedPlacements.get(request.sessionId);
      if (!isForceAbandonedWorkerPlacement(failed)) {
        throw new Error(`Session ${request.sessionKey} abandonment did not fence its remote owner`);
      }
      const assertCurrent = () => {
        authorize?.();
        const { placement: latest, move: currentMove } = placements.readCurrentMoveAuthority(
          request.sessionId,
        );
        if (
          !isForceAbandonedWorkerPlacement(latest) ||
          latest.generation !== failed.generation ||
          latest.environmentId !== intent.source.environmentId ||
          latest.activeOwnerEpoch !== intent.source.ownerEpoch ||
          currentMove?.operationId !== intent.operationId
        ) {
          throw new Error(
            `Session ${request.sessionKey} abandonment source changed during Gateway preparation`,
          );
        }
      };
      assertCurrent();
      if (intent.target.kind === "gateway") {
        if (options.prepareGatewayMove) {
          await options.prepareGatewayMove({ ...request, assertCurrent });
        } else if ((await options.resolveWorkspace(failed)).kind === "repository") {
          throw new Error("Repository workspace Gateway materialization is unavailable");
        }
        assertCurrent();
      }
      if (environments.get(intent.source.environmentId)) {
        await environments.destroy(intent.source.environmentId, {
          sessionId: intent.sessionId,
          ownerEpoch: intent.source.ownerEpoch,
          authorize: assertCurrent,
        });
      }
      // The completion transaction compares this acknowledged generation after teardown.
      return failed;
    });
    authorize?.();
    if (fenced?.state !== "failed") {
      throw new Error(`Session ${request.sessionKey} abandonment did not fence its remote owner`);
    }
    const local = await placements.completeAbandonedPlacementMoveSourceToLocal(
      {
        operationId: intent.operationId,
        sessionId: intent.sessionId,
        expectedGeneration: fenced.generation,
        expectedRecoveryError: FORCED_WORKER_ABANDONMENT_ERROR,
      },
      { assertCurrent: authorize },
    );
    if (local.state !== "local") {
      throw new Error(`Session ${request.sessionKey} abandonment did not finish on the Gateway`);
    }
    return local;
  };

  return { abandonSource, forceDestroyEnvironment, validateAbandonSource };
}
