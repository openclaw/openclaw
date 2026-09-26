import { getRuntimeConfig } from "../../config/config.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import type { WorkerDevicePlacementRequirementResolver } from "./placement-dispatch-startup.js";
import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import { matchesWorkerPlacementTarget } from "./placement-reclaim-contract.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import { canRedispatchFailedWorkerPlacement } from "./session-placement-lifecycle.js";

type RedispatchableWorkerPlacement = Extract<
  WorkerSessionPlacementRecord,
  { state: "reclaimed" | "failed" }
>;

export function createWorkerPlacementRedispatch(params: {
  placements: Pick<WorkerSessionPlacementStore, "readProjection">;
  dispatch: WorkerPlacementDispatchService["dispatch"];
  resolveDevicePlacementRequirement?: WorkerDevicePlacementRequirementResolver;
}) {
  return async (
    placement: RedispatchableWorkerPlacement,
    { assertCurrent, signal }: { assertCurrent: () => void; signal?: AbortSignal },
  ) => {
    signal?.throwIfAborted();
    assertCurrent();
    const projection = await params.placements.readProjection([placement.sessionId], {
      current: true,
    });
    signal?.throwIfAborted();
    assertCurrent();
    const current = projection.placements.get(placement.sessionId);
    if (
      !matchesWorkerPlacementTarget(current, placement) ||
      current?.agentId !== placement.agentId ||
      current.sessionKey !== placement.sessionKey
    ) {
      throw new Error("Worker placement changed before automatic recovery");
    }
    const previousEnvironment = placement.environmentId
      ? projection.environments.get(placement.environmentId)
      : undefined;
    if (!previousEnvironment) {
      throw new Error(
        `Worker placement has no environment record: ${placement.environmentId}. Choose where the session should continue.`,
      );
    }
    if (
      placement.state === "failed" &&
      !canRedispatchFailedWorkerPlacement(placement, previousEnvironment)
    ) {
      throw new Error(`Worker recovery is not ready: ${placement.recoveryError}`);
    }
    const { profileId, providerId, profileSnapshot, nodeDeviceId } = previousEnvironment;
    const { sessionId, sessionKey, agentId, executionMode } = placement;
    const identity = { sessionId, sessionKey, agentId, executionMode };
    let devicePlacement: Awaited<ReturnType<WorkerDevicePlacementRequirementResolver>> | undefined;
    if (nodeDeviceId) {
      if (!params.resolveDevicePlacementRequirement) {
        throw new Error("Node-backed redispatch has no authoritative runtime requirement");
      }
      devicePlacement = await params.resolveDevicePlacementRequirement(identity);
    }
    const requiredProfile = getRuntimeConfig().cloudWorkers?.requiredProfile;
    return await params.dispatch(
      {
        ...identity,
        profileId,
        ...(requiredProfile ? { requiredProfile } : {}),
        expectedPlacement: {
          state: placement.state,
          generation: placement.generation,
          environmentId: placement.environmentId,
          activeOwnerEpoch: placement.activeOwnerEpoch,
        },
        ...(devicePlacement ? { devicePlacement } : {}),
        ...(providerId === DEVICE_WORKER_PROVIDER_ID && nodeDeviceId
          ? { deviceId: nodeDeviceId }
          : {}),
        inheritedProfile: { providerId, profileSnapshot },
      },
      undefined,
      assertCurrent,
      signal,
    );
  };
}
