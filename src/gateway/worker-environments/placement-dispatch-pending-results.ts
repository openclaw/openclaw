import { getRuntimeConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  workerDisappearanceError,
  type WorkerDispatchPlacement,
} from "./placement-dispatch-failure.js";
import { createPendingGatewayMovePreparation } from "./placement-dispatch-pending-move.js";
import type { WorkerSessionPlacementProjection } from "./placement-read-projection.types.js";
import { placementTurnOwner } from "./placement-record.js";
import type { PlacementRecoveryDeps } from "./placement-recovery-contract.js";
import type { WorkerSessionTurnClaim } from "./placement-store.js";
import { isExactAttachedEnvironment } from "./placement-target.js";
import { completeRecoveredWorkspaceTeardown } from "./placement-teardown.js";
import type { PlacementTurnClaimCurrentCheck } from "./placement-turn-claims.types.js";
import {
  matchesWorkspaceResultClaim,
  isCurrentWorkerWorkspacePendingResultOwner,
} from "./placement-workspace-result-owner.js";
import {
  createWorkerWorkspaceReconcileRequest,
  recoverSessionWorkspaceCheckpoint,
  sessionWorkspaceRoot,
} from "./session-workspace.js";
import { boundedWorkerError } from "./worker-error.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import { recoverWorkerWorkspaceReconciliation } from "./workspace-reconcile.js";
import {
  adoptReclaimedWorkspaceHistory,
  createWorkspaceResultJournal,
  finalizeWorkspaceResultConflicts,
  resolvePriorWorkspaceResultConflict,
  settleStagedWorkspaceResult,
  recoverRepositoryDiskResult,
  resolvePendingResultWorkspace,
} from "./workspace-result-settlement.js";
import {
  applyStagedWorkerWorkspaceResult,
  cleanupWorkerWorkspaceResultRef,
  deleteStagedWorkerWorkspaceResult,
  hasWorkerWorkspaceResultRef,
  isWorkerWorkspaceResultCleanupRef,
  preparedWorkerWorkspaceResultRef,
  restoreStagedWorkerWorkspaceResultFromCleanup,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

const log = createSubsystemLogger("gateway/worker-placement");

type WorkerOwnedPendingPlacement = Extract<
  WorkerDispatchPlacement,
  { state: "active" | "draining" }
>;

async function prepareAcceptedPublication(
  deps: PlacementRecoveryDeps,
  claim: WorkerSessionTurnClaim,
): Promise<void> {
  await deps.prepareAcceptedWorkspacePublication?.(claim).catch(() => undefined);
}

export async function recoverPendingWorkspaceResults(
  deps: PlacementRecoveryDeps,
  projection: WorkerSessionPlacementProjection,
  environmentId?: string,
): Promise<Set<string>> {
  const { environments, failure, placements } = deps;
  const prepareGatewayMove = createPendingGatewayMovePreparation(deps);
  const destroyPendingEnvironment = async (
    placement: WorkerOwnedPendingPlacement,
    assertCurrent: () => void,
  ) => {
    assertCurrent();
    const current = environments.get(placement.environmentId);
    // Drain advances the epoch, but store.requestDestroy is monotonic and forbids
    // reattachment. Retry its cleanup; a live replacement still needs the exact epoch.
    if (
      current &&
      current.state !== "destroyed" &&
      (current.ownerEpoch === placement.activeOwnerEpoch || current.destroyRequestedAtMs !== null)
    ) {
      await environments.destroy(placement.environmentId);
    }
  };
  const stagedResultOwners = new Set<string>();
  for (const pending of projection.pendingResults.values()) {
    if (pending.stagedResultRef) {
      stagedResultOwners.add(pending.sessionId);
    }
    const sameGatewayInstance =
      pending.gatewayInstanceId === placements.workspaceResultInstanceId();
    const reclaimResult =
      pending.claimId === pending.runId && pending.claimId.startsWith("reclaim-");
    if (sameGatewayInstance && pending.recoveryRequestedAtMs === null) {
      continue;
    }
    const placement = projection.placements.get(pending.sessionId);
    if (environmentId !== undefined && placement?.environmentId !== environmentId) {
      continue;
    }
    if (projection.moves.get(pending.sessionId)?.abandonSource) {
      // Move recovery owns forced abandonment for this session. Preserve the
      // pending result fence so recoverPlacementMoves can retire it under
      // FORCED_WORKER_ABANDONMENT_ERROR and return to local placement.
      continue;
    }
    try {
      const pendingPlacement =
        placement?.state === "active" || placement?.state === "draining" ? placement : undefined;
      const turnClaim =
        pendingPlacement &&
        pendingPlacement.environmentId === pending.environmentId &&
        pendingPlacement.activeOwnerEpoch === pending.ownerEpoch
          ? {
              sessionId: pendingPlacement.sessionId,
              claimId: pending.claimId,
              runId: pending.runId,
              placementGeneration: pending.placementGeneration,
              owner: placementTurnOwner(pendingPlacement),
            }
          : undefined;
      if (
        !pendingPlacement ||
        !turnClaim ||
        !matchesWorkspaceResultClaim(pendingPlacement, pending, turnClaim)
      ) {
        if (pending.repositoryDiskAuthority) {
          // Losing the claim does not transfer or discard the only repository copy.
          throw new Error(
            "Disk-authoritative workspace result lost its placement; recovery is held",
          );
        }
        if (pending.stagedResultRef && pending.workspaceAcceptedAtMs === null) {
          // A staged unaccepted result outlives stale placement ownership. Only
          // explicit operator abandonment may delete its durable Git ref.
          continue;
        }
        if (pending.stagedResultRef) {
          if (!placement) {
            throw new Error(
              `Staged cloud workspace result lost its placement: ${pending.sessionId}`,
            );
          }
          const workspace = await resolvePendingResultWorkspace(deps, placement, pending);
          if (workspace.kind === "local") {
            await deleteStagedWorkerWorkspaceResult({
              root: workspace.path,
              stagedResultRef: pending.stagedResultRef,
            });
          }
        }
        if (placement?.state === "active" || placement?.state === "draining") {
          const failed = await placements.failWorkspaceResultAndReleaseTurn(
            pending,
            new Error(`Pending cloud workspace result has no active claim: ${pending.sessionId}`),
          );
          if (failed.state === "failed") {
            await failure.retryFailedTeardown(failed);
          }
        } else {
          await placements.abandonWorkspaceResult(pending);
        }
        continue;
      }
      await placements.prepareWorkspaceResultClaim(turnClaim);
      await deps.withPreparedRecovery(
        pendingPlacement,
        () => {
          if (!placements.validateWorkspaceResultClaim(turnClaim)) {
            throw new Error("Workspace recovery lost its durable result owner");
          }
        },
        async (recovery) => {
          try {
            let active: WorkerOwnedPendingPlacement = pendingPlacement;
            const workspace = await resolvePendingResultWorkspace(
              deps,
              active,
              pending,
              recovery.workspace,
            );
            recovery.assertCurrent();
            if (pending.repositoryDiskAuthority) {
              await recoverRepositoryDiskResult({
                deps,
                placement: active,
                pending,
                turnClaim,
                workspace,
                assertCurrent: recovery.assertCurrent,
                authority: pending.repositoryDiskAuthority,
                move: projection.moves.get(pending.sessionId),
                currentWorkspace: recovery.workspace,
              });
              return;
            }
            if (workspace.kind === "device-folder") {
              // A restart revokes the old turn, but not this device's authoritative files.
              // Join process cleanup without capturing or reconciling the folder.
              await environments.stopTunnel(active.environmentId, active.activeOwnerEpoch);
              recovery.assertCurrent();
              await placements.acceptWorkspaceResult(turnClaim, recovery.assertCurrent);
              await placements.closeWorkerTurnToolState(turnClaim);
              if (active.state === "draining") {
                await environments.destroy(active.environmentId);
                await completeRecoveredWorkspaceTeardown({
                  placements,
                  placement: active,
                  turnClaim,
                });
              } else {
                await placements.completeWorkspaceResultAndReleaseTurn(
                  turnClaim,
                  recovery.assertCurrent,
                );
              }
              return;
            }
            const root = sessionWorkspaceRoot(workspace);
            const priorWorkspaceResultConflict = await resolvePriorWorkspaceResultConflict(
              recovery.resolveConflict,
              active,
            );
            const canonicalStagedResultRef = workerWorkspaceResultRef(turnClaim.claimId);
            let stagedResultRef = pending.stagedResultRef;
            if (
              !stagedResultRef &&
              (await hasWorkerWorkspaceResultRef({
                root,
                stagedResultRef: canonicalStagedResultRef,
              }))
            ) {
              recovery.assertCurrent();
              await placements.recordStagedWorkspaceResult(
                turnClaim,
                canonicalStagedResultRef,
                workspace.kind === "repository" ? workspace.repository.workspaceId : undefined,
                recovery.assertCurrent,
              );
              recovery.assertCurrent();
              stagedResultRef = canonicalStagedResultRef;
              stagedResultOwners.add(pending.sessionId);
            }
            if (
              workspace.kind === "local" &&
              stagedResultRef &&
              pending.workspaceAcceptedAtMs !== null
            ) {
              const canonicalExists = await hasWorkerWorkspaceResultRef({
                root,
                stagedResultRef,
              });
              if (!canonicalExists) {
                const cleanupRef = cleanupWorkerWorkspaceResultRef(stagedResultRef);
                if (await hasWorkerWorkspaceResultRef({ root, stagedResultRef: cleanupRef })) {
                  stagedResultRef = cleanupRef;
                }
              }
            }
            const hasPreparedResult =
              !stagedResultRef &&
              (await hasWorkerWorkspaceResultRef({
                root,
                stagedResultRef: preparedWorkerWorkspaceResultRef(canonicalStagedResultRef),
              }));
            const environment = environments.get(active.environmentId);
            if (
              environment?.state === "attached" &&
              (environment.attachedSessionIds.length !== 1 ||
                environment.attachedSessionIds[0] !== active.sessionId)
            ) {
              // This result cannot own teardown unless the environment is attached
              // exclusively to this session. Preserve the fence until ownership is exact.
              return;
            }
            const blockedMove = projection.moves.get(pending.sessionId);
            const preserveBlockedMove =
              blockedMove?.target.kind === "gateway" &&
              Boolean(getRuntimeConfig().cloudWorkers?.requiredProfile);
            // Source destruction is committed; settle its accepted result without
            // authorizing the rejected destination or reopening local placement.
            const finishBlockedMove =
              preserveBlockedMove &&
              pending.workspaceAcceptedAtMs !== null &&
              environment?.state === "destroyed";
            const canPreserveEnvironment = (
              current: Parameters<PlacementTurnClaimCurrentCheck["assertPlacementCurrent"]>[0],
              move: Parameters<PlacementTurnClaimCurrentCheck["assertPlacementCurrent"]>[1],
            ) => {
              const currentEnvironment = environments.get(pending.environmentId);
              if (preserveBlockedMove) {
                // Result acceptance does not authorize its persisted Move destination.
                // Release the claim without teardown; the Move or serialized Stop
                // still owns the exact drained source and its accepted checkpoint.
                return (
                  current?.state === "draining" &&
                  isCurrentWorkerWorkspacePendingResultOwner(current, pending) &&
                  current.environmentId === pending.environmentId &&
                  current.activeOwnerEpoch === pending.ownerEpoch &&
                  move?.operationId === blockedMove?.operationId &&
                  move?.source.generation + 1 === current.generation &&
                  move.source.environmentId === current.environmentId &&
                  move.source.ownerEpoch === current.activeOwnerEpoch &&
                  (finishBlockedMove
                    ? currentEnvironment?.state === "destroyed"
                    : Boolean(getRuntimeConfig().cloudWorkers?.requiredProfile) &&
                      isExactAttachedEnvironment(currentEnvironment, current))
                );
              }
              return (
                current?.state === "active" &&
                current.generation === pending.placementGeneration &&
                current.environmentId === pending.environmentId &&
                current.activeOwnerEpoch === pending.ownerEpoch &&
                Boolean(currentEnvironment?.nodeDeviceId) &&
                currentEnvironment?.nodeDeviceId === environment?.nodeDeviceId &&
                currentEnvironment?.leaseId === environment?.leaseId &&
                isExactAttachedEnvironment(currentEnvironment, current) &&
                move === null &&
                !reclaimResult
              );
            };
            const preserveEnvironment =
              !finishBlockedMove && canPreserveEnvironment(active, blockedMove ?? null);
            const currentCheck: PlacementTurnClaimCurrentCheck = {
              assertPlacementCurrent(current, move) {
                if (
                  (preserveEnvironment || finishBlockedMove) &&
                  !canPreserveEnvironment(current, move)
                ) {
                  throw new Error("Recovered workspace result lost its active environment owner");
                }
              },
            };
            const assertPreservedEnvironment = () => {
              recovery.assertCurrent();
              if (
                preserveEnvironment &&
                (!canPreserveEnvironment(active, blockedMove ?? null) ||
                  !placements.validateWorkspaceResultClaim(turnClaim))
              ) {
                throw new Error("Recovered workspace result lost its active environment owner");
              }
            };
            const destroyResultEnvironment = async () => {
              if (!preserveEnvironment && !finishBlockedMove) {
                const assertMoveCurrent = await prepareGatewayMove(
                  active,
                  turnClaim,
                  recovery.assertCurrent,
                );
                await destroyPendingEnvironment(
                  active,
                  assertMoveCurrent ?? recovery.assertCurrent,
                );
              }
            };
            const completeResult = () => {
              assertPreservedEnvironment();
              return preserveEnvironment
                ? placements.completeWorkspaceResultAndReleaseTurn(
                    turnClaim,
                    recovery.assertCurrent,
                    currentCheck,
                  )
                : completeRecoveredWorkspaceTeardown({
                    placements,
                    placement: active,
                    turnClaim,
                    ...(finishBlockedMove ? { destination: "reclaimed", currentCheck } : {}),
                  });
            };
            const settleRecoveredResult = async (
              result: Pick<
                Parameters<typeof finalizeWorkspaceResultConflicts>[0],
                "stagedResultRef" | "conflictPaths" | "retainPriorConflict"
              >,
              completion: Pick<
                Parameters<typeof settleStagedWorkspaceResult>[0],
                "beforeComplete" | "complete" | "afterComplete"
              > = { beforeComplete: destroyResultEnvironment, complete: completeResult },
            ) => {
              const conflictRetained = await finalizeWorkspaceResultConflicts({
                assertCurrent: recovery.assertCurrent,
                placements,
                turnClaim,
                ...result,
                priorConflict: priorWorkspaceResultConflict,
                workspace,
                report: recovery.reportConflict,
              });
              await deps.publishAcceptedWorkspace?.(turnClaim);
              // Recovery may drain an ordinary turn; only a reclaim owns commit adoption.
              if (reclaimResult) {
                await adoptReclaimedWorkspaceHistory({
                  ...recovery,
                  workspace,
                  stagedResultRef: result.stagedResultRef,
                });
              }
              await settleStagedWorkspaceResult({
                assertCurrent: recovery.assertCurrent,
                placements,
                turnClaim,
                workspace,
                stagedResultRef: result.stagedResultRef,
                conflictRetained,
                ...completion,
              });
            };
            if (
              preserveEnvironment &&
              (!sameGatewayInstance || pending.recoveryRequestedAtMs !== null)
            ) {
              // Restart revokes the previous turn, not its machine. Confirm the old
              // node runtime stopped before accepting a result or reconnecting it.
              recovery.assertCurrent();
              await environments.stopTunnel(active.environmentId, active.activeOwnerEpoch);
              assertPreservedEnvironment();
            }
            const teardownRequired =
              !preserveEnvironment &&
              (!sameGatewayInstance ||
                reclaimResult ||
                Boolean(stagedResultRef) ||
                (pending.workspaceAcceptedAtMs !== null &&
                  (workspace.kind === "local" || environment?.state === "destroyed")));
            if (active.state === "active" && teardownRequired) {
              recovery.assertCurrent();
              const draining = await placements.startWorkspaceResultDrain(
                turnClaim,
                recovery.assertCurrent,
              );
              if (draining.state !== "draining") {
                throw new Error(
                  `Pending workspace result did not drain session ${active.sessionId}`,
                );
              }
              active = draining;
            }
            const stagedResultExists = stagedResultRef
              ? await hasWorkerWorkspaceResultRef({ root, stagedResultRef })
              : false;
            const acceptedUnstaged =
              workspace.kind === "local" &&
              !stagedResultRef &&
              pending.workspaceAcceptedAtMs !== null;
            if (acceptedUnstaged || (stagedResultRef && !stagedResultExists)) {
              if (workspace.kind === "repository") {
                throw new Error(
                  "Repository checkpoint is missing; restore its artifact before retrying recovery",
                );
              }
              if (pending.workspaceAcceptedAtMs === null) {
                // An unaccepted result with a missing ref has no proof of apply.
                // Preserve its fence for operator inspection instead of guessing.
                return;
              }
              // Clean refs are deleted while their accepted fence still exists. A
              // crash after deletion resumes here and can safely finish ownership.
              if (acceptedUnstaged) {
                await prepareAcceptedPublication(deps, turnClaim);
                await settleRecoveredResult({
                  stagedResultRef: null,
                  conflictPaths: [],
                  retainPriorConflict: reclaimResult,
                });
              } else {
                if (turnClaim.owner.kind === "worker") {
                  recovery.assertCurrent();
                  await placements.closeWorkerTurnToolState(turnClaim);
                }
                await destroyResultEnvironment();
                await prepareAcceptedPublication(deps, turnClaim);
                await deps.publishAcceptedWorkspace?.(turnClaim);
                await completeResult();
              }
              if (!preserveEnvironment) {
                await environments
                  .stopTunnel(active.environmentId, active.activeOwnerEpoch)
                  .catch(() => undefined);
              }
              return;
            }
            const { adapter: journal } = createWorkspaceResultJournal({
              placement: { ...active, generation: pending.placementGeneration },
              placements,
              turnClaim,
              assertCurrent: recovery.assertCurrent,
              assertCommitCurrent: assertPreservedEnvironment,
              current: currentCheck,
            });
            if (stagedResultRef) {
              let ownedStagedResultRef = stagedResultRef;
              // A staged result must never be destroyed by environment lifecycle.
              // Keep its fence and placement until the local apply is durably accepted.
              await deps.workspaceOperations.run(active.environmentId, async () => {
                assertPreservedEnvironment();
                if (!placements.validateWorkspaceResultClaim(turnClaim)) {
                  throw new Error("Recovered workspace result lost its placement owner");
                }
                let conflictPaths: string[] = [];
                if (workspace.kind === "repository") {
                  await recoverSessionWorkspaceCheckpoint({
                    workspace,
                    checkpointRef: ownedStagedResultRef,
                    assertCurrent: () => {
                      recovery.assertCurrent();
                      if (!placements.validateWorkspaceResultClaim(turnClaim)) {
                        throw new Error("Recovered repository checkpoint lost its placement owner");
                      }
                    },
                    onAccepted: journal.commit,
                  });
                } else {
                  const interrupted = await journal.load();
                  const alreadyApplied = interrupted?.appliedManifestRef !== undefined;
                  if (interrupted && !alreadyApplied) {
                    await recoverWorkerWorkspaceReconciliation({
                      root,
                      journal: interrupted,
                      assertCurrent: recovery.assertCurrent,
                    });
                    await journal.abort();
                  }
                  const reconciliation = await applyStagedWorkerWorkspaceResult({
                    root,
                    stagedResultRef: ownedStagedResultRef,
                    expectedBaseManifestRef: active.workspaceBaseManifestRef,
                    alreadyAccepted: pending.workspaceAcceptedAtMs !== null || alreadyApplied,
                    journal,
                    assertCurrent: recovery.assertCurrent,
                  });
                  await reconciliation.verifyLocalStable();
                  conflictPaths = reconciliation.conflictPaths;
                }
                if (pending.workspaceAcceptedAtMs === null) {
                  await prepareAcceptedPublication(deps, turnClaim);
                  assertPreservedEnvironment();
                  await placements.acceptWorkspaceResult(turnClaim, recovery.assertCurrent);
                }
                if (
                  conflictPaths.length > 0 &&
                  isWorkerWorkspaceResultCleanupRef(ownedStagedResultRef)
                ) {
                  await restoreStagedWorkerWorkspaceResultFromCleanup({
                    root,
                    cleanupRef: ownedStagedResultRef,
                    stagedResultRef: canonicalStagedResultRef,
                    assertCurrent: recovery.assertCurrent,
                  });
                  ownedStagedResultRef = canonicalStagedResultRef;
                }
                await settleRecoveredResult({
                  stagedResultRef: ownedStagedResultRef,
                  conflictPaths,
                });
                if (!preserveEnvironment) {
                  await environments
                    .stopTunnel(active.environmentId, active.activeOwnerEpoch)
                    .catch(() => undefined);
                }
              });
              return;
            }
            // File custody depends on the exact attachment, not launch compatibility.
            if (!isExactAttachedEnvironment(environment, active)) {
              if (hasPreparedResult) {
                // Verification did not publish this prepared snapshot before the
                // crash. Preserve the fence for retry or operator inspection.
                return;
              }
              if (pending.workspaceAcceptedAtMs !== null && environment?.state === "destroyed") {
                await prepareAcceptedPublication(deps, turnClaim);
                await deps.publishAcceptedWorkspace?.(turnClaim);
                const assertMoveCurrent = finishBlockedMove
                  ? recovery.assertCurrent
                  : await prepareGatewayMove(active, turnClaim, recovery.assertCurrent);
                (assertMoveCurrent ?? recovery.assertCurrent)();
                await completeResult();
                return;
              }
              recovery.assertCurrent();
              const failed = await placements.failWorkspaceResultAndReleaseTurn(
                pending,
                workerDisappearanceError(environment) ??
                  new Error(`Pending cloud workspace result lost its worker: ${pending.sessionId}`),
                recovery.assertCurrent,
              );
              if (failed.state === "failed") {
                await failure.retryFailedTeardown(failed);
              }
              return;
            }
            recovery.assertCurrent();
            const tunnel = await environments.startTunnel({
              environmentId: active.environmentId,
              ownerEpoch: active.activeOwnerEpoch,
            });
            await deps.workspaceOperations.run(active.environmentId, async () => {
              assertPreservedEnvironment();
              if (!placements.validateWorkspaceResultClaim(turnClaim)) {
                throw new Error("Recovered workspace result lost its placement owner");
              }
              const quiescence = await tunnel.quiesceWorkspace(active.remoteWorkspaceDir);
              let quiescenceHandled = false;
              try {
                assertPreservedEnvironment();
                const reconciliation = await tunnel.reconcileWorkspace(
                  createWorkerWorkspaceReconcileRequest({
                    workspace,
                    remoteWorkspaceDir: active.remoteWorkspaceDir,
                    baseManifestRef: active.workspaceBaseManifestRef,
                    journal,
                    stagedResult: {
                      ref: canonicalStagedResultRef,
                      record: (ref) => {
                        recovery.assertCurrent();
                        return placements.recordStagedWorkspaceResult(
                          turnClaim,
                          ref,
                          workspace.kind === "repository"
                            ? workspace.repository.workspaceId
                            : undefined,
                          recovery.assertCurrent,
                        );
                      },
                    },
                    assertCurrent: () => {
                      recovery.assertCurrent();
                      if (!placements.validateWorkspaceResultClaim(turnClaim)) {
                        throw new Error("Recovered workspace result lost its placement owner");
                      }
                    },
                  }),
                );
                const applied = await verifyReconciledWorkspaceFinal(reconciliation, quiescence);
                await prepareAcceptedPublication(deps, turnClaim);
                assertPreservedEnvironment();
                await placements.acceptWorkspaceResult(turnClaim, recovery.assertCurrent);
                const recordedPending = (
                  await placements.readProjection([turnClaim.sessionId], { current: true })
                ).pendingResults.get(turnClaim.sessionId);
                const recordedStagedResultRef =
                  recordedPending?.sessionId === turnClaim.sessionId &&
                  recordedPending.claimId === turnClaim.claimId &&
                  recordedPending.runId === turnClaim.runId
                    ? recordedPending.stagedResultRef
                    : undefined;
                const conflictPaths = applied?.conflictPaths ?? [];
                if (conflictPaths.length > 0 && !recordedStagedResultRef) {
                  throw new Error(
                    "Recovered cloud workspace conflict has no staged result reference",
                  );
                }
                await settleRecoveredResult(
                  {
                    stagedResultRef: recordedStagedResultRef,
                    conflictPaths,
                    retainPriorConflict: reclaimResult && !reconciliation.changed,
                  },
                  {
                    beforeComplete: async () => {
                      const assertMoveCurrent = !preserveEnvironment
                        ? await prepareGatewayMove(active, turnClaim, recovery.assertCurrent)
                        : undefined;
                      if ((sameGatewayInstance && !reclaimResult) || preserveEnvironment) {
                        assertPreservedEnvironment();
                        await quiescence.resume();
                      } else {
                        recovery.assertCurrent();
                        assertMoveCurrent?.();
                        await environments.destroy(active.environmentId);
                      }
                      quiescenceHandled = true;
                    },
                    ...(sameGatewayInstance && !reclaimResult && !preserveEnvironment
                      ? {}
                      : {
                          complete: completeResult,
                        }),
                    afterComplete: async () => {
                      if ((!sameGatewayInstance || reclaimResult) && !preserveEnvironment) {
                        await environments
                          .stopTunnel(active.environmentId, active.activeOwnerEpoch)
                          .catch(() => undefined);
                      }
                    },
                  },
                );
              } finally {
                if (!quiescenceHandled) {
                  await quiescence.resume();
                }
              }
            });
          } catch (error) {
            try {
              const currentFacts = await placements.readProjection([pending.sessionId], {
                current: true,
              });
              const current = currentFacts.placements.get(pending.sessionId);
              const candidate = currentFacts.pendingResults.get(pending.sessionId);
              const currentPending =
                candidate &&
                candidate.sessionId === pending.sessionId &&
                candidate.environmentId === pending.environmentId &&
                candidate.ownerEpoch === pending.ownerEpoch &&
                candidate.placementGeneration === pending.placementGeneration &&
                candidate.claimId === pending.claimId &&
                candidate.runId === pending.runId &&
                candidate.gatewayInstanceId === pending.gatewayInstanceId
                  ? candidate
                  : undefined;
              if (
                currentPending &&
                isCurrentWorkerWorkspacePendingResultOwner(current, currentPending)
              ) {
                await recovery.reportFailure(boundedWorkerError(error));
              }
            } catch {
              // Transcript reporting must not weaken the durable recovery fence.
            }
          }
        },
      );
    } catch (error) {
      log.warn(`Cloud workspace recovery deferred: ${boundedWorkerError(error)}`);
    }
  }
  return stagedResultOwners;
}
