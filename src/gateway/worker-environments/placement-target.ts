import type { WorkerEnvironmentRecord } from "./environment-record.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";

export type WorkerPlacementCancellationTarget = Readonly<
  Pick<WorkerSessionPlacementRecord, "state" | "generation" | "environmentId" | "activeOwnerEpoch">
>;

/** Local retirement receipt; provider disposal remains with the old environment owner. */
export type WorkerPreactivationRetirement = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  environmentId: string;
  ownerEpoch: number;
  provisionOperationId: string;
  nodeSetupId: string | null;
};

export function isNeverActivatedWorkerPlacement(placement: WorkerSessionPlacementRecord): boolean {
  return (
    placement.state === "failed" &&
    placement.environmentId !== null &&
    placement.activeOwnerEpoch === null &&
    placement.turnClaim === null &&
    placement.workspaceBaseManifestRef === null &&
    placement.remoteWorkspaceDir === null &&
    placement.workerBundleHash === null &&
    placement.lastTranscriptAckCursor === null &&
    placement.lastLiveEventAckCursor === null
  );
}

export function isFencedPreactivationEnvironment(environment: WorkerEnvironmentRecord): boolean {
  return (
    environment.destroyRequestedAtMs !== null &&
    (environment.state === "destroying" ||
      environment.state === "draining" ||
      environment.state === "failed" ||
      environment.state === "destroyed") &&
    environment.lastActivatedAtMs === null &&
    environment.bootstrapReceipt === null &&
    environment.nodeDeviceId === null &&
    environment.sshEndpoint === null &&
    environment.attachedSessionIds.length === 0 &&
    environment.recoveryHold === undefined
  );
}

export function matchesWorkerPlacementTarget(
  current: WorkerPlacementCancellationTarget | undefined,
  expected: WorkerPlacementCancellationTarget | undefined,
): boolean {
  return (
    current?.state === expected?.state &&
    current?.generation === expected?.generation &&
    current?.environmentId === expected?.environmentId &&
    current?.activeOwnerEpoch === expected?.activeOwnerEpoch
  );
}

export function isFailedWorkerPlacementEnvironmentGone(params: {
  environmentService:
    | {
        get(environmentId: string): Pick<WorkerEnvironmentRecord, "state" | "leaseId"> | undefined;
      }
    | undefined;
  placement: Extract<WorkerSessionPlacementRecord, { state: "failed" }>;
}): boolean {
  if (params.placement.environmentId === null) {
    return true;
  }
  // Provisioning persists deterministic allocation intent first; only the configured service
  // can prove that the corresponding durable environment row was never created or is gone.
  if (!params.environmentService) {
    return false;
  }
  try {
    const environment = params.environmentService.get(params.placement.environmentId);
    return (
      environment === undefined ||
      environment.state === "destroyed" ||
      (environment.state === "failed" && environment.leaseId === null)
    );
  } catch {
    return false;
  }
}

/** A failed dispatch that never bound an allocation or admitted a worker executor. */
export function isUnallocatedWorkerPlacementFailure(
  placement: WorkerSessionPlacementRecord,
): boolean {
  return (
    placement.state === "failed" &&
    placement.environmentId === null &&
    placement.activeOwnerEpoch === null &&
    placement.turnClaim === null &&
    placement.workspaceBaseManifestRef === null &&
    placement.remoteWorkspaceDir === null &&
    placement.workerBundleHash === null &&
    placement.lastTranscriptAckCursor === null &&
    placement.lastLiveEventAckCursor === null
  );
}

/** Canonical teardown completed before a session executor or workspace was admitted. */
export function isWorkerPlacementDestroyedBeforeActivation(
  placement: WorkerSessionPlacementRecord,
  environment:
    | Pick<WorkerEnvironmentRecord, "environmentId" | "state" | "recoveryHold">
    | undefined,
): boolean {
  return (
    placement.state === "failed" &&
    placement.activeOwnerEpoch === null &&
    placement.turnClaim === null &&
    environment?.environmentId === placement.environmentId &&
    environment?.state === "destroyed" &&
    environment.recoveryHold === undefined &&
    placement.workspaceBaseManifestRef === null &&
    placement.remoteWorkspaceDir === null &&
    placement.lastTranscriptAckCursor === null &&
    placement.lastLiveEventAckCursor === null
  );
}
