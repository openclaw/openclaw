import { randomUUID } from "node:crypto";
import type { WorkerDispatchPlacement } from "./placement-dispatch-failure.js";
import type { WorkerPlacementMoveIntent } from "./placement-move-intent.types.js";
import type {
  WorkerPlacementReclaimBarriers,
  WorkerReclaimPlacement,
} from "./placement-reclaim-contract.js";
import { placementTurnOwner, reportPlacementTransition } from "./placement-record.js";
import type { PlacementRecoveryDeps } from "./placement-recovery-contract.js";
import { isExactAttachedEnvironment } from "./placement-target.js";
import { completeWorkerWorkspaceTeardown } from "./placement-teardown.js";
import { findPendingWorkerWorkspaceResult } from "./placement-workspace-result.js";
import type {
  WorkerPlacementAuthorization,
  WorkerPlacementReclaimRequest,
  WorkerPlacementReclaimSourceCheck,
} from "./service-contract.js";
import {
  createWorkerWorkspaceReconcileRequest,
  sessionWorkspaceRoot,
} from "./session-workspace.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";
import {
  verifyReconciledWorkspaceFinal,
  WorkerWorkspaceFinalFenceError,
} from "./workspace-finalize.js";
import { recoverWorkerWorkspaceReconciliation } from "./workspace-reconcile.js";
import {
  createWorkspaceResultJournal,
  finalizeWorkspaceResultConflicts,
  resolvePriorWorkspaceResultConflict,
  settleStagedWorkspaceResult,
} from "./workspace-result-settlement.js";
import {
  hasWorkerWorkspaceResultRef,
  preparedWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

export type WorkerPlacementReclaimOptions = Pick<
  WorkerPlacementReclaimBarriers,
  "runReclaimBarrier"
> &
  Pick<
    PlacementRecoveryDeps,
    | "placements"
    | "environments"
    | "workspaceOperations"
    | "prepareGatewayMove"
    | "withPreparedRecovery"
  >;

export function createWorkerPlacementReclaim(options: WorkerPlacementReclaimOptions) {
  const { environments, placements } = options;
  return async (
    request: WorkerPlacementReclaimRequest,
    moveIntent?: WorkerPlacementMoveIntent,
    authorize?: WorkerPlacementAuthorization,
    beforeDrain?: WorkerPlacementReclaimSourceCheck,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
  ): Promise<WorkerReclaimPlacement> =>
    await options.runReclaimBarrier({
      ...request,
      authorize,
      beforeDrain,
      begin: async (assertCurrent) => {
        const current = await placements.getAsync(request.sessionId);
        assertCurrent?.();
        beforeDrain?.assertCurrent?.();
        // A queued stop can observe the previous stop's completion only after
        // entering the lifecycle fence; joining an outside promise can deadlock it.
        if (
          current?.state === "reclaimed" &&
          current.sessionKey === request.sessionKey &&
          current.agentId === request.agentId
        ) {
          return current;
        }
        if ((current?.state !== "active" && current?.state !== "draining") || current.turnClaim) {
          throw new Error(
            `Session ${request.sessionKey} cannot stop cloud worker from placement ${current?.state ?? "missing"}`,
          );
        }
        const environment = environments.get(current.environmentId);
        if (!isExactAttachedEnvironment(environment, current)) {
          throw new Error("Active cloud worker does not match its session placement");
        }
        if (current.state === "draining") {
          return current;
        }
        let draining: WorkerDispatchPlacement;
        try {
          draining = await placements.startDrain(
            {
              sessionId: current.sessionId,
              environmentId: current.environmentId,
              ownerEpoch: current.activeOwnerEpoch,
              expectedGeneration: current.generation,
              expectedUpdatedAtMs: current.updatedAtMs,
              requireUnclaimed: true,
            },
            () => {
              assertCurrent?.();
              beforeDrain?.assertCurrent?.();
              if (!isExactAttachedEnvironment(environments.get(current.environmentId), current)) {
                throw new Error("Active cloud worker does not match its session placement");
              }
            },
          );
        } catch (error) {
          if (!(error instanceof AcceptedWorkspacePublicationIndeterminateError)) {
            // Classify a settled refusal without replaying a write or inspecting an unknown one.
            beforeDrain?.();
          }
          throw error;
        }
        if (draining.state !== "draining") {
          throw new Error(`Session ${request.sessionKey} did not enter draining placement`);
        }
        reportPlacementTransition(onTransition, draining);
        return draining;
      },
      reclaim: async (workspace, current, reauthorize) => {
        if (current.state === "reclaimed") {
          return current;
        }
        const root = sessionWorkspaceRoot(workspace);
        const journalPlacement = { ...current };
        const reclaimClaimId = `reclaim-${randomUUID()}`;
        const reclaimClaim = await placements.claimReclaimWorkspaceResult(
          {
            sessionId: current.sessionId,
            sessionKey: current.sessionKey,
            agentId: current.agentId,
            claimId: reclaimClaimId,
            runId: reclaimClaimId,
            owner: placementTurnOwner(current),
          },
          undefined,
          reauthorize,
        );
        return await options.withPreparedRecovery(
          current,
          () => {
            reauthorize?.();
            if (!placements.validateWorkspaceResultClaim(reclaimClaim)) {
              throw new Error("Cloud worker stop lost its durable result owner");
            }
          },
          async (recovery) => {
            if (
              recovery.workspace.kind !== workspace.kind ||
              sessionWorkspaceRoot(recovery.workspace) !== sessionWorkspaceRoot(workspace)
            ) {
              throw new Error("Cloud worker stop workspace changed during preparation");
            }
            const reclaimResultRef = workerWorkspaceResultRef(reclaimClaim.claimId);
            const { adapter: journal, wasAccepted } = createWorkspaceResultJournal({
              placement: journalPlacement,
              placements,
              turnClaim: reclaimClaim,
              assertCurrent: recovery.assertCurrent,
            });
            const cancelUnstagedFailedReclaim = async (allowCommitted: boolean): Promise<void> => {
              await options.workspaceOperations.run(current.environmentId, async () => {
                const stillOwnsEmptyResult = (): boolean => {
                  const owned = placements.get(current.sessionId);
                  const currentEnvironment = environments.get(current.environmentId);
                  const pendingResult = placements.preparedWorkspaceResult(reclaimClaim);
                  return (
                    (allowCommitted || !wasAccepted()) &&
                    owned?.state === "draining" &&
                    owned.turnClaim?.claimId === reclaimClaim.claimId &&
                    reclaimClaim.owner.environmentId === current.environmentId &&
                    reclaimClaim.owner.ownerEpoch === current.activeOwnerEpoch &&
                    currentEnvironment?.state === "attached" &&
                    currentEnvironment.ownerEpoch === reclaimClaim.owner.ownerEpoch &&
                    currentEnvironment.attachedSessionIds.length === 1 &&
                    currentEnvironment.attachedSessionIds[0] === owned.sessionId &&
                    pendingResult?.workspaceAcceptedAtMs === null &&
                    pendingResult.stagedResultRef === null
                  );
                };
                if (!stillOwnsEmptyResult()) {
                  return;
                }
                const [canonicalExists, preparedExists] = await Promise.all([
                  hasWorkerWorkspaceResultRef({ root, stagedResultRef: reclaimResultRef }),
                  hasWorkerWorkspaceResultRef({
                    root,
                    stagedResultRef: preparedWorkerWorkspaceResultRef(reclaimResultRef),
                  }),
                ]);
                // Recheck after filesystem I/O while the session barrier and workspace
                // owner lock are still held. A committed manifest or durable ref keeps
                // recovery authoritative.
                if (!canonicalExists && !preparedExists && stillOwnsEmptyResult()) {
                  recovery.assertCurrent();
                  await placements.closeWorkerTurnToolState(reclaimClaim);
                  recovery.assertCurrent();
                  await placements.cancelWorkspaceResultAndReleaseTurn(
                    reclaimClaim,
                    undefined,
                    reauthorize,
                  );
                }
              });
            };
            try {
              const pending = await journal.load();
              if (pending) {
                reauthorize?.();
                if (workspace.kind !== "local") {
                  throw new Error(
                    "Repository checkpoints cannot own a local reconciliation journal",
                  );
                }
                await recoverWorkerWorkspaceReconciliation({
                  root,
                  journal: pending,
                  assertCurrent: recovery.assertCurrent,
                });
                reauthorize?.();
                await journal.abort();
              }
              recovery.assertCurrent();
              const tunnel = await environments.startTunnel({
                environmentId: current.environmentId,
                ownerEpoch: current.activeOwnerEpoch,
              });
              const reclaimed = await options.workspaceOperations.run(
                current.environmentId,
                async () => {
                  // Lock acquisition and every remote/filesystem step may yield; stale callers must
                  // fail before the next reclaim effect, not only after teardown has completed.
                  const assertCurrent = () => {
                    recovery.assertCurrent();
                    reauthorize?.();
                    const owned = placements.preparedWorkspaceResultPlacement(reclaimClaim);
                    if (
                      owned?.state !== "draining" ||
                      owned.generation !== current.generation ||
                      owned.environmentId !== current.environmentId ||
                      owned.activeOwnerEpoch !== current.activeOwnerEpoch ||
                      owned.turnClaim?.claimId !== reclaimClaim.claimId ||
                      !placements.validateWorkspaceResultClaim(reclaimClaim)
                    ) {
                      throw new Error(
                        "Cloud worker stop lost its placement owner before reconciliation",
                      );
                    }
                  };
                  assertCurrent();
                  const quiescence = await tunnel.quiesceWorkspace(current.remoteWorkspaceDir);
                  try {
                    assertCurrent();
                    const reconciliation = await tunnel.reconcileWorkspace(
                      createWorkerWorkspaceReconcileRequest({
                        workspace,
                        remoteWorkspaceDir: current.remoteWorkspaceDir,
                        baseManifestRef: current.workspaceBaseManifestRef,
                        journal,
                        stagedResult: {
                          ref: reclaimResultRef,
                          record: (ref) => {
                            assertCurrent();
                            return placements.recordStagedWorkspaceResult(
                              reclaimClaim,
                              ref,
                              workspace.kind === "repository"
                                ? workspace.repository.workspaceId
                                : undefined,
                              assertCurrent,
                            );
                          },
                        },
                        assertCurrent,
                      }),
                    );
                    const applied = await verifyReconciledWorkspaceFinal(
                      reconciliation,
                      quiescence,
                    );
                    if (reconciliation.changed && !wasAccepted()) {
                      throw new Error("Cloud worker stop did not commit its reconciled workspace");
                    }
                    assertCurrent();
                    await placements.acceptWorkspaceResult(reclaimClaim, reauthorize);
                    const recordedStagedResultRef = (
                      await findPendingWorkerWorkspaceResult(placements, reclaimClaim)
                    )?.stagedResultRef;
                    const conflictPaths = applied?.conflictPaths ?? [];
                    if (conflictPaths.length > 0 && !recordedStagedResultRef) {
                      throw new Error("Cloud worker stop conflict has no staged result reference");
                    }
                    const priorWorkspaceResultConflict = await resolvePriorWorkspaceResultConflict(
                      recovery.resolveConflict,
                      current,
                    );
                    reauthorize?.();
                    const finalized = await finalizeWorkspaceResultConflicts({
                      assertCurrent: recovery.assertCurrent,
                      placements,
                      turnClaim: reclaimClaim,
                      conflictPaths,
                      priorConflict: priorWorkspaceResultConflict,
                      stagedResultRef: recordedStagedResultRef,
                      // An unchanged stop is not a later cloud result; keep its prior fence inspectable.
                      retainPriorConflict: !reconciliation.changed,
                      workspace,
                      report: recovery.reportConflict,
                    });
                    reauthorize?.();
                    return await settleStagedWorkspaceResult({
                      assertCurrent: recovery.assertCurrent,
                      placements,
                      turnClaim: reclaimClaim,
                      workspace,
                      stagedResultRef: recordedStagedResultRef,
                      conflictRetained: finalized.conflictRetained,
                      beforeComplete: async () => {
                        assertCurrent();
                        if (
                          workspace.kind === "repository" &&
                          moveIntent?.target.kind === "gateway"
                        ) {
                          if (!options.prepareGatewayMove) {
                            throw new Error("Repository workspace materialization is unavailable");
                          }
                          await options.prepareGatewayMove({
                            sessionId: current.sessionId,
                            sessionKey: current.sessionKey,
                            agentId: current.agentId,
                            assertCurrent,
                          });
                          assertCurrent();
                        }
                        await environments.destroy(current.environmentId);
                      },
                      complete: async () => {
                        // Destroy is the final privileged effect. Once it commits, durable placement
                        // completion must finish even if caller authority closes during the await.
                        const completed = await completeWorkerWorkspaceTeardown({
                          placements,
                          turnClaim: reclaimClaim,
                          environmentId: current.environmentId,
                          ownerEpoch: current.activeOwnerEpoch,
                          move: moveIntent,
                        });
                        // Publish the committed owner before cleanup refs and the tunnel can yield.
                        reportPlacementTransition(onTransition, completed);
                        return completed;
                      },
                    });
                  } finally {
                    if (
                      isExactAttachedEnvironment(environments.get(current.environmentId), current)
                    ) {
                      await quiescence.resume();
                    }
                  }
                },
              );
              if (reclaimed.state !== "local" && reclaimed.state !== "reclaimed") {
                throw new Error("Cloud worker teardown produced a nonterminal placement");
              }
              try {
                await environments.stopTunnel(current.environmentId, current.activeOwnerEpoch);
              } catch {
                // Provider teardown is authoritative; local tunnel cleanup is best effort.
              }
              return reclaimed;
            } catch (error) {
              if (error instanceof AcceptedWorkspacePublicationIndeterminateError) {
                throw error;
              }
              // An unstaged final-fence failure is retryable even after an unchanged
              // manifest commit; the journal remains authoritative for the next attempt.
              await cancelUnstagedFailedReclaim(
                error instanceof WorkerWorkspaceFinalFenceError &&
                  error.reclaimDisposition === "retry",
              ).catch(() => undefined);
              const pendingReclaimResult = await findPendingWorkerWorkspaceResult(
                placements,
                reclaimClaim,
              );
              if (pendingReclaimResult && pendingReclaimResult.workspaceAcceptedAtMs !== null) {
                await placements.handoffWorkspaceResultRecovery(reclaimClaim);
                // The tracked sweep retries cleanup after this lifecycle/placement fence releases.
                // Awaiting it here can join provisioning recovery queued behind our own fence.
              }
              throw error;
            }
          },
        );
      },
    });
}
