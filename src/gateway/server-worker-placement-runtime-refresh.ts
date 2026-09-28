import { getGatewayRestartDrainSignal } from "../process/gateway-work-admission.js";
import type { waitForNodeWorkerSupervisor } from "./node-registry-private.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";
import type { createWorkerSessionTurnPlacementProvider } from "./worker-environments/worker-turn-launcher.js";

type NodeAvailabilityWait = (
  nodeId: string,
  options: Parameters<typeof waitForNodeWorkerSupervisor>[2],
) => Promise<void>;

/** Bind pre-handoff admission to this Gateway's node registry and lifetime. */
export function createWorkerRuntimeRefreshWaiter(params: {
  environments: WorkerEnvironmentService;
  isStopping: () => boolean;
}) {
  let waitForNode: NodeAvailabilityWait | undefined;
  const wait: Parameters<
    typeof createWorkerSessionTurnPlacementProvider
  >[0]["waitForAdmissionNode"] = async ({ placement, signal, assertCurrent }) => {
    const environment = params.environments.get(placement.environmentId);
    if (!environment?.nodeDeviceId) {
      return;
    }
    if (!waitForNode) {
      throw new Error("Worker node availability runtime is unavailable");
    }
    const waitingSignal = AbortSignal.any([signal, getGatewayRestartDrainSignal()]);
    const assertWaitingCurrent = () => {
      waitingSignal.throwIfAborted();
      assertCurrent();
      const current = params.environments.get(placement.environmentId);
      if (
        params.isStopping() ||
        params.environments.isStopping() ||
        current?.state !== "attached" ||
        current.ownerEpoch !== placement.activeOwnerEpoch ||
        current.nodeDeviceId !== environment.nodeDeviceId ||
        current.leaseId !== environment.leaseId ||
        current.destroyRequestedAtMs !== null ||
        current.attachedSessionIds.length !== 1 ||
        current.attachedSessionIds[0] !== placement.sessionId
      ) {
        throw new Error("Worker admission lost its environment while waiting for reconnect");
      }
    };
    assertWaitingCurrent();
    await waitForNode(environment.nodeDeviceId, {
      signal: waitingSignal,
      assertCurrent: assertWaitingCurrent,
    });
    assertWaitingCurrent();
  };
  return {
    wait,
    bind: (bound: NodeAvailabilityWait) => {
      waitForNode = bound;
    },
  };
}
