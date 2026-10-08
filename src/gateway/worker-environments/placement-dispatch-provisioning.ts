import { WorkerDispatchTargetChangedError } from "../server-worker-placement-session-target.js";
import { supportsCurrentWorkerLaunch } from "./admission.js";
import type {
  WorkerDispatchEnvironmentService,
  WorkerDispatchPlacement,
  WorkerDispatchPlacementStore,
} from "./placement-dispatch-failure.js";
import {
  WorkerPlacementAdmissionTargetError,
  type WorkerPlacementDispatchRequest,
} from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";

export function isPendingProvisioningEnvironment(
  environment: ReturnType<WorkerEnvironmentService["get"]>,
  environmentId: string | null,
): boolean {
  return (
    environment?.environmentId === environmentId &&
    environment.destroyRequestedAtMs === null &&
    (environment.state === "requested" ||
      environment.state === "provisioning" ||
      environment.state === "bootstrapping")
  );
}

export function createInterruptedWorkerProvisioningRetainer(options: {
  placements: Pick<WorkerDispatchPlacementStore, "get" | "getAsync">;
  environments: Pick<WorkerEnvironmentService, "get" | "recordError">;
  isShuttingDown?: () => boolean;
}) {
  const { environments, placements } = options;
  return async (
    owned: WorkerDispatchPlacement,
    error: unknown,
  ): Promise<WorkerDispatchPlacement | undefined> => {
    const current = await placements.getAsync(owned.sessionId);
    if (
      error instanceof WorkerPlacementAdmissionTargetError ||
      error instanceof WorkerDispatchTargetChangedError ||
      !options.isShuttingDown?.() ||
      current?.state !== "provisioning" ||
      current.state !== owned.state ||
      current.generation !== owned.generation ||
      current.environmentId !== owned.environmentId ||
      current.sessionKey !== owned.sessionKey ||
      current.agentId !== owned.agentId ||
      current.executionMode !== owned.executionMode
    ) {
      return undefined;
    }
    const environment = current.environmentId ? environments.get(current.environmentId) : undefined;
    if (!environment || !isPendingProvisioningEnvironment(environment, current.environmentId)) {
      return undefined;
    }
    const assertCurrent = () => {
      const latest = placements.get(owned.sessionId);
      if (
        latest?.state !== current.state ||
        latest.generation !== current.generation ||
        latest.environmentId !== current.environmentId ||
        latest.sessionKey !== current.sessionKey ||
        latest.agentId !== current.agentId ||
        latest.executionMode !== current.executionMode ||
        !isPendingProvisioningEnvironment(
          environments.get(environment.environmentId),
          current.environmentId,
        )
      ) {
        throw new Error("Worker provisioning owner changed before shutdown retention");
      }
    };
    // Explicit Stop must win while the diagnostic waits for the database worker.
    await environments.recordError(environment, error, assertCurrent);
    assertCurrent();
    return current;
  };
}

export function requireProvisionedEnvironment(
  environment: Awaited<ReturnType<WorkerEnvironmentService["createWithRequest"]>>,
  expectedEnvironmentId: string,
  executionMode: WorkerPlacementDispatchRequest["executionMode"],
  environments: Pick<WorkerDispatchEnvironmentService, "supportsProviderExecutionMode">,
): { environmentId: string; ownerEpoch: number; bundleHash: string } {
  if (
    (environment.state !== "ready" && environment.state !== "idle") ||
    environment.environmentId !== expectedEnvironmentId ||
    environment.destroyRequestedAtMs !== null ||
    !environment.bootstrapReceipt ||
    !supportsCurrentWorkerLaunch(environment.bootstrapReceipt)
  ) {
    throw new Error(
      `Worker environment is not dispatchable with the current worker launch contract: ${environment.state}`,
    );
  }
  if (
    (environment.profileSnapshot.executionMode !== undefined &&
      environment.profileSnapshot.executionMode !== executionMode) ||
    (executionMode === "worker-turn" &&
      environment.profileSnapshot.executionMode !== undefined &&
      !environment.nodeDeviceId) ||
    !environments.supportsProviderExecutionMode(environment.providerId, executionMode)
  ) {
    throw new Error("Worker environment does not support the placement's exact execution mode");
  }
  return {
    environmentId: environment.environmentId,
    ownerEpoch: environment.ownerEpoch,
    bundleHash: environment.bootstrapReceipt.bundleHash,
  };
}
