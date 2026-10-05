import type {
  WorkerPlacementReclaimBarriers,
  WithPreparedWorkerWorkspaceRecovery,
} from "./placement-reclaim-contract.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { RetainedWorkerRecoveryAcceptance } from "./recovery-hold-store.js";
import type { WorkerEnvironmentServiceContract } from "./service-contract.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";

export type PrepareRetainedRecoveryCheckpoint = (
  identity: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
    assertCurrent: () => void;
    signal?: AbortSignal;
    operatorAuthority?: import("../../agents/admitted-run-context.js").AdmittedRunOperatorAuthority;
    readNativeCredential?: import("../../agents/github-credential-reader.js").GitHubCredentialReader;
  },
  workspace: Extract<WorkerSessionWorkspace, { kind: "repository" }>,
) => Promise<
  Omit<
    RetainedWorkerRecoveryAcceptance,
    "environmentId" | "sessionId" | "placementGeneration" | "disposalOnly"
  > & {
    conflictPaths?: string[];
  }
>;

export function createRetainedWorkerRecovery(options: {
  environments: Pick<
    WorkerEnvironmentServiceContract,
    "get" | "holdFailedEnvironment" | "acceptRetainedRecovery" | "supportsFailedLeaseHold"
  >;
  placements: {
    get(sessionId: string): WorkerSessionPlacementRecord | undefined;
    withWorkspaceExclusion: <T>(
      sessionId: string,
      run: (assertCurrent: () => void) => Promise<T>,
    ) => Promise<T>;
  };
  runFailedReclaimBarrier: WorkerPlacementReclaimBarriers["runFailedReclaimBarrier"];
  withPreparedRecovery: WithPreparedWorkerWorkspaceRecovery;
  prepareCheckpoint?: PrepareRetainedRecoveryCheckpoint;
  prepareDisposalCheckpoint?: PrepareRetainedRecoveryCheckpoint;
}) {
  const canRecover = (placement: WorkerSessionPlacementRecord): boolean => {
    const environment = placement.environmentId
      ? options.environments.get(placement.environmentId)
      : undefined;
    return (
      placement.state === "failed" &&
      placement.activeOwnerEpoch !== null &&
      environment !== undefined &&
      environment.leaseId !== null &&
      environment.sharedHost === false &&
      environment.ownerEpoch === placement.activeOwnerEpoch &&
      options.environments.supportsFailedLeaseHold?.(environment.environmentId) === true &&
      Boolean(options.prepareCheckpoint)
    );
  };
  const recover = async (
    source: Extract<WorkerSessionPlacementRecord, { state: "failed" }>,
    authority: {
      assertCurrent: () => void;
      signal?: AbortSignal;
      operatorAuthority?: import("../../agents/admitted-run-context.js").AdmittedRunOperatorAuthority;
      readNativeCredential?: import("../../agents/github-credential-reader.js").GitHubCredentialReader;
    },
  ) => {
    if (!canRecover(source)) {
      throw new Error(
        `Failed cloud worker cannot be retained for automatic recovery: ${source.recoveryError}`,
      );
    }
    const hold = options.environments.holdFailedEnvironment;
    const accept = options.environments.acceptRetainedRecovery;
    const prepare = options.prepareCheckpoint;
    if (!hold || !accept || !prepare || !source.environmentId || source.activeOwnerEpoch === null) {
      throw new Error("Failed worker recovery capability is unavailable");
    }
    const identity = {
      sessionId: source.sessionId,
      sessionKey: source.sessionKey,
      agentId: source.agentId,
    };
    const environmentId = source.environmentId;
    const ownerEpoch = source.activeOwnerEpoch;
    const result = await options.runFailedReclaimBarrier({
      preserveCurrentAdmission: true,
      ...identity,
      authorize: authority.assertCurrent,
      reclaim: async (reauthorize) => {
        const completed = options.placements.get(source.sessionId);
        if (
          completed?.state === "reclaimed" &&
          completed.generation === source.generation + 1 &&
          completed.environmentId === environmentId &&
          completed.sessionKey === source.sessionKey &&
          completed.agentId === source.agentId
        ) {
          return completed;
        }
        const assertCurrent = () => {
          authority.signal?.throwIfAborted();
          authority.assertCurrent();
          reauthorize?.();
          const current = options.placements.get(source.sessionId);
          if (
            current?.state !== "failed" ||
            current.generation !== source.generation ||
            current.environmentId !== environmentId ||
            current.activeOwnerEpoch !== ownerEpoch ||
            current.sessionKey !== source.sessionKey ||
            current.agentId !== source.agentId ||
            current.executionMode !== source.executionMode
          ) {
            throw new Error("Failed worker placement changed during retained-source recovery");
          }
        };
        assertCurrent();
        return await options.placements.withWorkspaceExclusion(
          identity.sessionId,
          async (assertExclusion) =>
            options.withPreparedRecovery(
              identity,
              () => {
                assertExclusion();
                assertCurrent();
              },
              async (recovery) => {
                if (
                  recovery.workspace.kind !== "repository" ||
                  !recovery.workspace.repository.checkpointRef
                ) {
                  throw new Error(
                    "Automatic retained-source recovery requires an accepted repository checkpoint",
                  );
                }
                const check = recovery.assertCurrent;
                const retained = await hold(
                  {
                    ...identity,
                    environmentId,
                    ownerEpoch,
                    placementGeneration: source.generation,
                    executionMode: source.executionMode,
                  },
                  check,
                  authority.signal,
                );
                check();
                if (retained.recoveryHold?.kind === "prepared") {
                  throw new Error("Prepared-worker custody cannot authorize session recovery");
                }
                const stagedCheckpoint = retained.recoveryHold?.disposalCheckpoint;
                const checkpoint: Awaited<ReturnType<PrepareRetainedRecoveryCheckpoint>> =
                  stagedCheckpoint?.remoteHeadCommit
                    ? stagedCheckpoint
                    : await prepare(
                        {
                          ...identity,
                          assertCurrent: check,
                          signal: authority.signal,
                          operatorAuthority: authority.operatorAuthority,
                          readNativeCredential: authority.readNativeCredential,
                        },
                        recovery.workspace,
                      );
                check();
                const { conflictPaths, ...acceptance } = checkpoint;
                if (conflictPaths?.length) {
                  await recovery.reportConflict({
                    paths: conflictPaths,
                    totalCount: conflictPaths.length,
                    stagedResultRef: checkpoint.previousCheckpointRef,
                  });
                  check();
                }
                const observed =
                  retained.recoveryHold?.receipt?.resources
                    .filter((resource) => resource.state === "retained")
                    .map((resource) => resource.kind) ?? [];
                await recovery.reportRetention?.({
                  environmentId,
                  previousCheckpointRef: checkpoint.previousCheckpointRef,
                  checkpointRef: checkpoint.checkpointRef,
                  manifestHash: checkpoint.manifestHash,
                  message: `The previous worker lease ${retained.leaseId} is temporarily held for recovery and failure diagnostics; observed retained resources: ${observed.join(", ") || "none"}. Any changes after its last accepted checkpoint ${checkpoint.previousCheckpointRef} remain uncertain and may not survive eligible worker cleanup. Recovery prepared checkpoint ${checkpoint.checkpointRef} (manifest ${checkpoint.manifestHash}) from ${checkpoint.remoteHeadCommit ? "accepted state and verified remote history" : "verified accepted state"}; this session will continue from it once the checkpoint cutover is accepted.`,
                });
                check();
                // The recovery owner stages checkpoint custody before physical disposal,
                // then rechecks current authority for the checkpoint/placement cutover.
                const accepted = await accept({
                  ...acceptance,
                  environmentId,
                  ...identity,
                  placementGeneration: source.generation,
                  assertCurrent: check,
                });
                if (accepted.state !== "reclaimed") {
                  throw new Error("Failed worker disposal did not admit current continuation");
                }
                return accepted;
              },
            ),
        );
      },
    });
    if (result.state !== "reclaimed") {
      throw new Error("Retained-source recovery did not preserve worker affinity");
    }
    return result;
  };
  const dispose = async (source: Extract<WorkerSessionPlacementRecord, { state: "failed" }>) => {
    const hold = options.environments.holdFailedEnvironment;
    const accept = options.environments.acceptRetainedRecovery;
    const prepare = options.prepareDisposalCheckpoint;
    const environment = source.environmentId
      ? options.environments.get(source.environmentId)
      : undefined;
    if (
      !hold ||
      !accept ||
      !prepare ||
      !environment ||
      !source.environmentId ||
      environment.sharedHost !== false ||
      !environment.leaseId ||
      environment.state === "destroyed" ||
      !options.environments.supportsFailedLeaseHold?.(source.environmentId)
    ) {
      return false;
    }
    if (source.activeOwnerEpoch === null || environment.ownerEpoch !== source.activeOwnerEpoch) {
      throw new Error("Failed worker disposal requires its exact original owner epoch");
    }
    const environmentId = source.environmentId;
    const ownerEpoch = source.activeOwnerEpoch;
    const identity = {
      sessionId: source.sessionId,
      sessionKey: source.sessionKey,
      agentId: source.agentId,
    };
    const assertCurrent = () => {
      const current = options.placements.get(source.sessionId);
      if (
        current?.state !== "failed" ||
        current.generation !== source.generation ||
        current.environmentId !== environmentId ||
        current.activeOwnerEpoch !== source.activeOwnerEpoch ||
        current.sessionKey !== source.sessionKey ||
        current.agentId !== source.agentId ||
        current.turnClaim !== null
      ) {
        throw new Error("Failed worker owner changed before automatic disposal");
      }
    };
    await options.placements.withWorkspaceExclusion(identity.sessionId, async (assertExclusion) =>
      options.withPreparedRecovery(
        identity,
        () => {
          assertExclusion();
          assertCurrent();
        },
        async (recovery) => {
          const check = recovery.assertCurrent;
          check();
          if (
            recovery.workspace.kind !== "repository" ||
            !recovery.workspace.repository.checkpointRef
          ) {
            throw new Error(
              "Automatic failed worker disposal requires its accepted repository checkpoint",
            );
          }
          const checkpoint = await prepare(
            { ...identity, assertCurrent: check },
            recovery.workspace,
          );
          check();
          const retained = await hold(
            {
              ...identity,
              environmentId,
              ownerEpoch,
              placementGeneration: source.generation,
              executionMode: source.executionMode,
            },
            check,
          );
          check();
          if (retained.recoveryHold?.kind === "prepared") {
            throw new Error("Prepared-worker custody cannot authorize session disposal");
          }
          const selected = retained.recoveryHold?.disposalCheckpoint ?? checkpoint;
          await recovery.reportRetention?.({
            ...selected,
            environmentId,
            message: `The failed worker lease ${retained.leaseId} is queued for exact owned cleanup after failure capture. Accepted checkpoint ${selected.previousCheckpointRef} remains retained; staged checkpoint ${selected.checkpointRef} (manifest ${selected.manifestHash}) is held for this session. Later unaccepted edits remain uncertain; cleanup does not resume paused work or authorize continuation.`,
          });
          check();
          await accept({
            ...selected,
            environmentId,
            sessionId: identity.sessionId,
            placementGeneration: source.generation,
            disposalOnly: true,
            assertCurrent: check,
          });
        },
      ),
    );
    return true;
  };
  return { canRecover, recover, dispose };
}
