import type {
  SessionPlacement,
  SessionPlacementDiskSpace,
  SessionPlacementMove,
  SessionPlacementMachine,
  SessionPlacementRunner,
  SessionPlacementWorkerRuntimeInstall,
} from "../../../packages/gateway-protocol/src/index.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import type { WorkerPlacementMoveIntent } from "./placement-move-intent.js";
import type { WorkerEnvironmentPlacementFacts } from "./placement-read-projection.types.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerEnvironmentServiceContract } from "./service-contract.js";

export type WorkerSessionPlacementReader = Pick<WorkerSessionPlacementStore, "getMany"> &
  Partial<
    Pick<
      WorkerSessionPlacementStore,
      | "getManyAsync"
      | "prepareRuntimeRefresh"
      | "getWorkspaceResultReconcilingSessionIds"
      | "getWorkspaceResultReconcilingSessionIdsAsync"
      | "listPendingWorkspaceResults"
      | "listPendingWorkspaceResultsAsync"
      | "registerTurnClaimClosedHandler"
    >
  >;

export type WorkerPlacementDiskSpaceReader = {
  read(record: WorkerSessionPlacementRecord): SessionPlacementDiskSpace | undefined;
  version(): number;
};

export type WorkerPlacementRunnerAvailabilityReader = {
  read(
    record: WorkerSessionPlacementRecord,
    environment?: Pick<
      WorkerEnvironmentPlacementFacts,
      "providerId" | "state" | "ownerEpoch" | "attachedSessionIds" | "nodeDeviceId"
    > | null,
  ): SessionPlacementRunner | undefined;
  version(): number;
};

export type WorkerPlacementRuntimeInstallReader = {
  read(
    record: WorkerSessionPlacementRecord,
    environment?: Pick<WorkerEnvironmentPlacementFacts, "nodeDeviceId"> | null,
  ): SessionPlacementWorkerRuntimeInstall | undefined;
  version(): number;
};

// Structural so the projector does not import the installer module (import cycle).
type WorkerRuntimeInstallObservation = SessionPlacementWorkerRuntimeInstall & {
  bundleHash: string;
};

export function createWorkerPlacementRuntimeInstallReader(params: {
  environments: Pick<WorkerEnvironmentServiceContract, "get">;
  installer: {
    readInstall(nodeId: string): WorkerRuntimeInstallObservation | undefined;
    readInstallForEnvironment(environmentId: string): WorkerRuntimeInstallObservation | undefined;
    version(): number;
  };
}): WorkerPlacementRuntimeInstallReader {
  return {
    read(record, preparedEnvironment) {
      if (record.state !== "provisioning" && record.state !== "active") {
        return undefined;
      }
      const environment =
        preparedEnvironment === undefined
          ? record.environmentId
            ? params.environments.get(record.environmentId)
            : undefined
          : preparedEnvironment;
      const observation =
        record.state === "provisioning"
          ? record.environmentId
            ? params.installer.readInstallForEnvironment(record.environmentId)
            : undefined
          : environment?.nodeDeviceId
            ? params.installer.readInstall(environment.nodeDeviceId)
            : undefined;
      if (
        !observation ||
        observation.transferredBytes <= 0 ||
        (record.state === "active" && observation.bundleHash === record.workerBundleHash)
      ) {
        return undefined;
      }
      const { phase, transferredBytes, totalBytes, startedAtMs, updatedAtMs } = observation;
      return { phase, transferredBytes, totalBytes, startedAtMs, updatedAtMs };
    },
    version: () => params.installer.version(),
  };
}

type WorkerPlacementIdentity = {
  providerId: string;
  profileId: string;
  machine?: SessionPlacementMachine;
  inference?: "worker";
};

export function readWorkerPlacementIdentity(
  record: WorkerSessionPlacementRecord,
  environments: Pick<WorkerEnvironmentServiceContract, "get" | "readMachineShape"> | undefined,
  preparedEnvironment?: WorkerEnvironmentPlacementFacts | null,
): WorkerPlacementIdentity | undefined {
  const environment =
    preparedEnvironment === undefined
      ? record.environmentId
        ? environments?.get(record.environmentId)
        : undefined
      : preparedEnvironment;
  if (!environment) {
    return undefined;
  }
  // Epochs correlate instances even when an environment id is reused. Matching terminal
  // environments retain accurate runner provenance; only pre-epoch dispatch states may
  // expose identity without an epoch, never terminal placements that retained none.
  const correlated =
    record.activeOwnerEpoch !== null
      ? environment.ownerEpoch === record.activeOwnerEpoch
      : record.state === "provisioning" ||
        record.state === "syncing" ||
        record.state === "starting";
  if (!correlated) {
    return undefined;
  }
  const machine = environments?.readMachineShape(
    environment.environmentId,
    preparedEnvironment ?? undefined,
  );
  return {
    providerId: environment.providerId,
    profileId: environment.profileId,
    ...(record.state === "active" &&
    record.executionMode === "worker-turn" &&
    environment.environmentId === record.environmentId &&
    environment.state === "attached" &&
    environment.providerId === DEVICE_WORKER_PROVIDER_ID &&
    environment.nodeDeviceId &&
    environment.attachedSessionIds.length === 1 &&
    environment.attachedSessionIds[0] === record.sessionId &&
    environment.inference === "worker"
      ? { inference: "worker" as const }
      : {}),
    ...(machine && Object.keys(machine).length ? { machine } : {}),
  };
}

export function createWorkerPlacementRunnerAvailabilityReader(params: {
  environments: Pick<WorkerEnvironmentServiceContract, "get">;
  hasCurrentDeviceRunner: (deviceId: string) => boolean;
}): WorkerPlacementRunnerAvailabilityReader & { markChanged(): void } {
  let version = 0;
  const read: WorkerPlacementRunnerAvailabilityReader["read"] = (record, preparedEnvironment) => {
    if (record.state !== "active") {
      return undefined;
    }
    const environment =
      preparedEnvironment === undefined
        ? params.environments.get(record.environmentId)
        : preparedEnvironment;
    if (
      environment?.providerId !== DEVICE_WORKER_PROVIDER_ID ||
      environment.state !== "attached" ||
      environment.ownerEpoch !== record.activeOwnerEpoch ||
      environment.attachedSessionIds.length !== 1 ||
      environment.attachedSessionIds[0] !== record.sessionId ||
      !environment.nodeDeviceId
    ) {
      return undefined;
    }
    return {
      kind: "device",
      deviceId: environment.nodeDeviceId,
      status: params.hasCurrentDeviceRunner(environment.nodeDeviceId) ? "available" : "offline",
    };
  };
  return {
    read,
    markChanged: () => {
      version += 1;
    },
    version: () => version,
  };
}

export function projectWorkerPlacementMove(
  intent: WorkerPlacementMoveIntent,
): SessionPlacementMove {
  return {
    target: intent.target,
    updatedAtMs: intent.updatedAtMs,
    ...(intent.lastError ? { error: intent.lastError } : {}),
  };
}

/** Removes gateway-only identity and turn-claim fields from the operator projection. */
export function projectWorkerSessionPlacement(
  record: WorkerSessionPlacementRecord,
  diskSpace?: SessionPlacementDiskSpace,
  runner?: SessionPlacementRunner,
  identity?: WorkerPlacementIdentity,
  failedRecoveryAction?: "restart" | "stop-first",
  workspaceResultReconciling = false,
  retryOnSend = false,
  options: { workerRuntimeInstall?: SessionPlacementWorkerRuntimeInstall } = {},
): SessionPlacement {
  const { inference, ...provenance } = identity ?? {};
  const timing = {
    generation: record.generation,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    stateChangedAtMs: record.stateChangedAtMs,
  };
  if (record.state === "local" || record.state === "requested") {
    return { state: record.state, ...timing };
  }
  const worker = { ...timing, ...provenance };
  const workerRuntimeInstall = options.workerRuntimeInstall
    ? { workerRuntimeInstall: options.workerRuntimeInstall }
    : {};
  if (record.state === "provisioning") {
    return {
      state: record.state,
      ...worker,
      ...(record.environmentId ? { environmentId: record.environmentId } : {}),
      ...workerRuntimeInstall,
    };
  }
  const progress = {
    ...(record.lastTranscriptAckCursor !== null
      ? { lastTranscriptAckCursor: record.lastTranscriptAckCursor }
      : {}),
    ...(record.lastLiveEventAckCursor !== null
      ? { lastLiveEventAckCursor: record.lastLiveEventAckCursor }
      : {}),
  };
  const conflict = record.workspaceResultConflict
    ? { workspaceResultConflict: record.workspaceResultConflict }
    : {};
  if (record.state === "reclaimed" || record.state === "failed") {
    const retained = {
      ...worker,
      ...(record.environmentId ? { environmentId: record.environmentId } : {}),
      ...(record.activeOwnerEpoch !== null ? { activeOwnerEpoch: record.activeOwnerEpoch } : {}),
      ...(record.workspaceBaseManifestRef
        ? { workspaceBaseManifestRef: record.workspaceBaseManifestRef }
        : {}),
      ...(record.remoteWorkspaceDir ? { remoteWorkspaceDir: record.remoteWorkspaceDir } : {}),
      ...(record.workerBundleHash ? { workerBundleHash: record.workerBundleHash } : {}),
      ...progress,
      ...conflict,
    };
    const terminal = {
      ...(record.terminalReason ? { terminalReason: record.terminalReason } : {}),
      ...(record.terminalAtMs !== null ? { terminalAtMs: record.terminalAtMs } : {}),
    };
    return record.state === "failed"
      ? {
          state: record.state,
          ...retained,
          recoveryError: record.recoveryError,
          ...(failedRecoveryAction ? { recoveryAction: failedRecoveryAction } : {}),
          ...(retryOnSend ? { retryOnSend: true as const } : {}),
          ...terminal,
        }
      : { state: record.state, ...retained, ...terminal };
  }
  const bundle = {
    ...worker,
    environmentId: record.environmentId,
    workerBundleHash: record.workerBundleHash,
  };
  if (record.state === "syncing") {
    return { state: record.state, ...bundle };
  }
  const workspace = {
    ...bundle,
    workspaceBaseManifestRef: record.workspaceBaseManifestRef,
    remoteWorkspaceDir: record.remoteWorkspaceDir,
  };
  if (record.state === "starting") {
    return { state: record.state, ...workspace };
  }
  return {
    state: record.state,
    ...worker,
    environmentId: record.environmentId,
    activeOwnerEpoch: record.activeOwnerEpoch,
    workerBundleHash: record.workerBundleHash,
    workspaceBaseManifestRef: record.workspaceBaseManifestRef,
    remoteWorkspaceDir: record.remoteWorkspaceDir,
    ...progress,
    ...(record.state === "active" && inference ? { inference } : {}),
    ...(record.state === "active" && diskSpace ? { diskSpace } : {}),
    ...(record.state === "active" && runner ? { runner } : {}),
    ...(record.state === "active" ? workerRuntimeInstall : {}),
    ...(workspaceResultReconciling && record.state !== "reconciling"
      ? { workspaceResultReconciling: true as const }
      : {}),
    ...conflict,
  };
}
