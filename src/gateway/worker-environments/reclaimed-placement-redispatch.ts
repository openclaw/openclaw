import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import type { WorkerDevicePlacementRequirementResolver } from "./placement-dispatch-startup.js";
import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerEnvironmentService } from "./service.js";

type ReclaimedWorkerPlacement = Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;

export function createReclaimedPlacementRedispatch(params: {
  environments: Pick<WorkerEnvironmentService, "get">;
  dispatch: WorkerPlacementDispatchService["dispatch"];
  resolveDevicePlacementRequirement?: WorkerDevicePlacementRequirementResolver;
}) {
  return async (
    placement: ReclaimedWorkerPlacement,
    { assertCurrent, signal }: { assertCurrent: () => void; signal?: AbortSignal },
  ) => {
    signal?.throwIfAborted();
    assertCurrent();
    const previousEnvironment = params.environments.get(placement.environmentId);
    if (!previousEnvironment) {
      throw new Error(
        `Reclaimed worker placement has no environment record: ${placement.environmentId}`,
      );
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
    return await params.dispatch(
      {
        ...identity,
        profileId,
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
