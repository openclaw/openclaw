import {
  isUnavailableEnvironment,
  type PlacementFailureActions,
  type WorkerActivationBarrier,
  type WorkerActiveDispatchPlacement,
  type WorkerDispatchEnvironmentService,
  type WorkerDispatchPlacement,
  type WorkerDispatchPlacementStore,
  type WorkerDrainingDispatchPlacement,
  type WorkerFailedDispatchPlacement,
  type WorkerStartingDispatchPlacement,
} from "./placement-dispatch-failure.js";
import type { WorkerEnvironmentService } from "./service.js";
import {
  projectWorkspaceResultConflict,
  type WorkerWorkspaceResultConflict,
} from "./workspace-conflicts.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import type { WorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { recoverWorkerWorkspaceReconciliation } from "./workspace-reconcile.js";
import {
  applyStagedWorkerWorkspaceResult,
  cleanupWorkerWorkspaceResultRef,
  deleteStagedWorkerWorkspaceResult,
  deleteWorkerWorkspaceResultCleanupRefs,
  hasWorkerWorkspaceResultRef,
  isWorkerWorkspaceResultCleanupRef,
  moveStagedWorkerWorkspaceResultToCleanup,
  preparedWorkerWorkspaceResultRef,
  restoreStagedWorkerWorkspaceResultFromCleanup,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

function sameActiveEnvironment(
  placement: WorkerActiveDispatchPlacement | WorkerDrainingDispatchPlacement,
  environment: ReturnType<WorkerEnvironmentService["get"]>,
): boolean {
  return Boolean(
    environment &&
    environment.state === "attached" &&
    placement.environmentId &&
    environment.environmentId === placement.environmentId &&
    placement.activeOwnerEpoch !== null &&
    environment.ownerEpoch === placement.activeOwnerEpoch &&
    placement.workerBundleHash &&
    environment.bootstrapReceipt?.bundleHash === placement.workerBundleHash &&
    environment.attachedSessionIds.length === 1 &&
    environment.attachedSessionIds[0] === placement.sessionId,
  );
}

function isStartingPlacement(
  placement: WorkerDispatchPlacement,
): placement is WorkerStartingDispatchPlacement {
  return placement.state === "starting";
}

function isFailedPlacement(
  placement: WorkerDispatchPlacement,
): placement is WorkerFailedDispatchPlacement {
  return placement.state === "failed";
}

export function createPlacementRecoveryActions(deps: {
  placements: WorkerDispatchPlacementStore;
  environments: WorkerDispatchEnvironmentService;
  runActivationBarrier: WorkerActivationBarrier;
  failure: PlacementFailureActions;
  workspaceOperations: WorkerWorkspaceOperationCoordinator;
  resolveWorkspacePath: (params: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
  }) => Promise<string>;
  reportWorkspaceResultConflict: (
    params: { sessionId: string; sessionKey: string; agentId: string } & (
      | { paths: string[]; stagedResultRef: string; totalCount: number }
      | { cleared: true }
    ),
  ) => Promise<void>;
  resolveWorkspaceResultConflict: (params: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
  }) => Promise<WorkerWorkspaceResultConflict | undefined>;
}) {
  const { environments, failure, placements } = deps;

  const recoverPendingWorkspaceResults = async (cleanupOrphans: boolean): Promise<Set<string>> => {
    const stagedResultOwners = new Set<string>();
    for (const pending of placements.listPendingWorkspaceResults()) {
      if (pending.stagedResultRef) {
        stagedResultOwners.add(pending.sessionId);
      }
      const sameGatewayInstance =
        pending.gatewayInstanceId === placements.workspaceResultInstanceId();
      if (sameGatewayInstance && pending.recoveryRequestedAtMs === null) {
        continue;
      }
      const placement = placements.get(pending.sessionId);
      try {
        const claim = placement?.turnClaim;
        if (
          (placement?.state !== "active" && placement?.state !== "draining") ||
          placement.environmentId !== pending.environmentId ||
          placement.activeOwnerEpoch !== pending.ownerEpoch ||
          claim?.owner !== "worker" ||
          claim.claimId !== pending.claimId ||
          claim.runId !== pending.runId ||
          claim.generation !== pending.placementGeneration ||
          claim.ownerEpoch !== pending.ownerEpoch
        ) {
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
            const root = await deps.resolveWorkspacePath(placement);
            await deleteStagedWorkerWorkspaceResult({
              root,
              stagedResultRef: pending.stagedResultRef,
            });
          }
          placements.abandonWorkspaceResult(pending);
          if (placement?.state === "active") {
            await failure.failActive(
              placement,
              new Error(`Pending cloud workspace result has no active claim: ${pending.sessionId}`),
              { forceClaimFence: true },
            );
          } else if (placement?.state === "draining") {
            await failure.failDraining(
              placement,
              new Error(
                `Pending cloud workspace result has no draining claim: ${pending.sessionId}`,
              ),
              { forceClaimFence: true },
            );
          }
          continue;
        }
        const turnClaim = {
          sessionId: placement.sessionId,
          claimId: claim.claimId,
          runId: claim.runId,
          placementGeneration: claim.generation,
          owner: {
            kind: "worker" as const,
            environmentId: placement.environmentId,
            ownerEpoch: placement.activeOwnerEpoch,
          },
        };
        const localPath = await deps.resolveWorkspacePath({
          sessionId: placement.sessionId,
          sessionKey: placement.sessionKey,
          agentId: placement.agentId,
        });
        const priorWorkspaceResultConflict =
          placement.workspaceResultConflict ??
          (await deps.resolveWorkspaceResultConflict({
            sessionId: placement.sessionId,
            sessionKey: placement.sessionKey,
            agentId: placement.agentId,
          }));
        const canonicalStagedResultRef = workerWorkspaceResultRef(turnClaim.claimId);
        let stagedResultRef = pending.stagedResultRef;
        if (
          !stagedResultRef &&
          (await hasWorkerWorkspaceResultRef({
            root: localPath,
            stagedResultRef: canonicalStagedResultRef,
          }))
        ) {
          placements.recordStagedWorkspaceResult(turnClaim, canonicalStagedResultRef);
          stagedResultRef = canonicalStagedResultRef;
          stagedResultOwners.add(pending.sessionId);
        }
        if (stagedResultRef && pending.workspaceAcceptedAtMs !== null) {
          const canonicalExists = await hasWorkerWorkspaceResultRef({
            root: localPath,
            stagedResultRef,
          });
          if (!canonicalExists) {
            const cleanupRef = cleanupWorkerWorkspaceResultRef(stagedResultRef);
            if (
              await hasWorkerWorkspaceResultRef({ root: localPath, stagedResultRef: cleanupRef })
            ) {
              stagedResultRef = cleanupRef;
            }
          }
        }
        const hasPreparedResult =
          !stagedResultRef &&
          (await hasWorkerWorkspaceResultRef({
            root: localPath,
            stagedResultRef: preparedWorkerWorkspaceResultRef(canonicalStagedResultRef),
          }));
        const environment = environments.get(placement.environmentId);
        if (
          environment?.state === "attached" &&
          environment.attachedSessionIds.includes(placement.sessionId) &&
          environment.attachedSessionIds.length !== 1
        ) {
          // This result cannot own teardown while another session remains attached.
          // Keep the durable claim fenced until environment ownership is unambiguous.
          continue;
        }
        const stagedResultExists = stagedResultRef
          ? await hasWorkerWorkspaceResultRef({ root: localPath, stagedResultRef })
          : false;
        if (stagedResultRef && !stagedResultExists) {
          if (pending.workspaceAcceptedAtMs === null) {
            // An unaccepted result with a missing ref has no proof of apply.
            // Preserve its fence for operator inspection instead of guessing.
            continue;
          }
          // Clean refs are deleted while their accepted fence still exists. A
          // crash after deletion resumes here and can safely finish ownership.
          if (
            environment &&
            environment.state !== "destroyed" &&
            environment.ownerEpoch === placement.activeOwnerEpoch
          ) {
            await environments.destroy(placement.environmentId);
          }
          const reclaimed = placements.completeWorkspaceResultAndReleaseTurn(turnClaim, {
            reclaim: true,
          });
          if (reclaimed.state !== "reclaimed") {
            throw new Error("Recovered cleaned worker result did not reclaim its environment");
          }
          await environments
            .stopTunnel(placement.environmentId, placement.activeOwnerEpoch)
            .catch(() => undefined);
          continue;
        }
        if (stagedResultRef) {
          let ownedStagedResultRef = stagedResultRef;
          // A staged result must never be destroyed by environment lifecycle.
          // Keep its fence and placement until the local apply is durably accepted.
          const owner = {
            sessionId: placement.sessionId,
            environmentId: placement.environmentId,
            ownerEpoch: placement.activeOwnerEpoch,
            placementGeneration: placement.generation,
          };
          const journal = {
            load: () => placements.loadWorkspaceReconciliation(owner),
            begin: (next: Parameters<typeof placements.beginWorkspaceReconciliation>[1]) =>
              placements.beginWorkspaceReconciliation(owner, next),
            commit: (manifestRef: string) =>
              placements.updateWorkspaceBaseManifest({ claim: turnClaim, manifestRef }),
            abort: () => placements.abortWorkspaceReconciliation(owner),
          };
          await deps.workspaceOperations.run(placement.environmentId, async () => {
            const owned = placements.get(placement.sessionId);
            const ownedClaim = owned?.turnClaim;
            if (
              (owned?.state !== "active" && owned?.state !== "draining") ||
              owned.generation !== placement.generation ||
              owned.environmentId !== placement.environmentId ||
              owned.activeOwnerEpoch !== placement.activeOwnerEpoch ||
              ownedClaim?.owner !== "worker" ||
              ownedClaim.claimId !== claim.claimId ||
              ownedClaim.runId !== claim.runId
            ) {
              throw new Error("Recovered workspace result lost its placement owner");
            }
            const interrupted = journal.load();
            const alreadyApplied = interrupted?.appliedManifestRef !== undefined;
            if (interrupted && !alreadyApplied) {
              await recoverWorkerWorkspaceReconciliation({ root: localPath, journal: interrupted });
              journal.abort();
            }
            let conflictPaths = priorWorkspaceResultConflict?.paths ?? [];
            const reconciliation = await applyStagedWorkerWorkspaceResult({
              root: localPath,
              stagedResultRef: ownedStagedResultRef,
              expectedBaseManifestRef: placement.workspaceBaseManifestRef,
              alreadyAccepted: pending.workspaceAcceptedAtMs !== null || alreadyApplied,
              journal,
            });
            await reconciliation.verifyLocalStable();
            conflictPaths = reconciliation.conflictPaths;
            const retainStagedResult = conflictPaths.length > 0;
            if (pending.workspaceAcceptedAtMs === null) {
              placements.acceptWorkspaceResult(turnClaim);
            }
            if (
              conflictPaths.length > 0 &&
              isWorkerWorkspaceResultCleanupRef(ownedStagedResultRef)
            ) {
              await restoreStagedWorkerWorkspaceResultFromCleanup({
                root: localPath,
                cleanupRef: ownedStagedResultRef,
                stagedResultRef: canonicalStagedResultRef,
              });
              ownedStagedResultRef = canonicalStagedResultRef;
            }
            const supersededConflict =
              priorWorkspaceResultConflict &&
              (conflictPaths.length === 0 ||
                priorWorkspaceResultConflict.stagedResultRef !== ownedStagedResultRef)
                ? priorWorkspaceResultConflict
                : undefined;
            if (supersededConflict && supersededConflict.stagedResultRef !== ownedStagedResultRef) {
              await deleteStagedWorkerWorkspaceResult({
                root: localPath,
                stagedResultRef: supersededConflict.stagedResultRef,
              });
            }
            if (conflictPaths.length > 0) {
              const projectedConflict = projectWorkspaceResultConflict(
                conflictPaths,
                ownedStagedResultRef,
              );
              placements.recordWorkspaceResultConflict(turnClaim, projectedConflict);
              await deps.reportWorkspaceResultConflict({
                sessionId: placement.sessionId,
                sessionKey: placement.sessionKey,
                agentId: placement.agentId,
                ...projectedConflict,
              });
            } else if (supersededConflict) {
              placements.recordWorkspaceResultConflict(turnClaim, undefined);
            }
            if (supersededConflict && conflictPaths.length === 0) {
              await deps.reportWorkspaceResultConflict({
                sessionId: placement.sessionId,
                sessionKey: placement.sessionKey,
                agentId: placement.agentId,
                cleared: true,
              });
            }
            const cleanupRef = !retainStagedResult
              ? isWorkerWorkspaceResultCleanupRef(ownedStagedResultRef)
                ? ownedStagedResultRef
                : await moveStagedWorkerWorkspaceResultToCleanup({
                    root: localPath,
                    stagedResultRef: ownedStagedResultRef,
                  })
              : undefined;
            const currentEnvironment = environments.get(placement.environmentId);
            if (
              currentEnvironment &&
              currentEnvironment.state !== "destroyed" &&
              currentEnvironment.ownerEpoch === placement.activeOwnerEpoch
            ) {
              await environments.destroy(placement.environmentId);
            }
            const reclaimed = placements.completeWorkspaceResultAndReleaseTurn(turnClaim, {
              reclaim: true,
            });
            if (reclaimed.state !== "reclaimed") {
              throw new Error("Recovered worker result did not reclaim its stale environment");
            }
            if (cleanupRef) {
              await deleteStagedWorkerWorkspaceResult({
                root: localPath,
                stagedResultRef: cleanupRef,
              }).catch(() => undefined);
            }
            await environments
              .stopTunnel(placement.environmentId, placement.activeOwnerEpoch)
              .catch(() => undefined);
          });
          continue;
        }
        if (!sameActiveEnvironment(placement, environment)) {
          if (hasPreparedResult) {
            // Verification did not publish this prepared snapshot before the
            // crash. Preserve the fence for retry or operator inspection.
            continue;
          }
          if (pending.workspaceAcceptedAtMs !== null && environment?.state === "destroyed") {
            placements.completeWorkspaceResultAndReleaseTurn(turnClaim, { reclaim: true });
            continue;
          }
          placements.abandonWorkspaceResult(pending);
          if (placement.state === "active") {
            await failure.failActive(
              placement,
              new Error(`Pending cloud workspace result lost its worker: ${pending.sessionId}`),
              { forceClaimFence: true },
            );
          } else {
            await failure.failDraining(
              placement,
              new Error(`Pending cloud workspace result lost its worker: ${pending.sessionId}`),
              { forceClaimFence: true },
            );
          }
          continue;
        }
        const owner = {
          sessionId: placement.sessionId,
          environmentId: placement.environmentId,
          ownerEpoch: placement.activeOwnerEpoch,
          placementGeneration: placement.generation,
        };
        const journal = {
          load: () => placements.loadWorkspaceReconciliation(owner),
          begin: (next: Parameters<typeof placements.beginWorkspaceReconciliation>[1]) =>
            placements.beginWorkspaceReconciliation(owner, next),
          commit: (manifestRef: string) =>
            placements.updateWorkspaceBaseManifest({ claim: turnClaim, manifestRef }),
          abort: () => placements.abortWorkspaceReconciliation(owner),
        };
        const tunnel = await environments.startTunnel({
          environmentId: placement.environmentId,
          ownerEpoch: placement.activeOwnerEpoch,
        });
        await deps.workspaceOperations.run(placement.environmentId, async () => {
          const owned = placements.get(placement.sessionId);
          const ownedClaim = owned?.turnClaim;
          if (
            (owned?.state !== "active" && owned?.state !== "draining") ||
            owned.generation !== placement.generation ||
            owned.environmentId !== placement.environmentId ||
            owned.activeOwnerEpoch !== placement.activeOwnerEpoch ||
            ownedClaim?.owner !== "worker" ||
            ownedClaim.claimId !== claim.claimId ||
            ownedClaim.runId !== claim.runId
          ) {
            throw new Error("Recovered workspace result lost its placement owner");
          }
          const quiescence = await tunnel.quiesceWorkspace(placement.remoteWorkspaceDir);
          let quiescenceHandled = false;
          try {
            const reconciliation = await tunnel.reconcileWorkspace({
              localPath,
              remoteWorkspaceDir: placement.remoteWorkspaceDir,
              baseManifestRef: placement.workspaceBaseManifestRef,
              journal: {
                ...journal,
              },
              stagedResult: {
                ref: canonicalStagedResultRef,
                record: (ref) => placements.recordStagedWorkspaceResult(turnClaim, ref),
              },
            });
            const applied = await verifyReconciledWorkspaceFinal(reconciliation, quiescence);
            placements.acceptWorkspaceResult(turnClaim);
            const recordedStagedResultRef = placements
              .listPendingWorkspaceResults()
              .find(
                (result) =>
                  result.sessionId === turnClaim.sessionId &&
                  result.claimId === turnClaim.claimId &&
                  result.runId === turnClaim.runId,
              )?.stagedResultRef;
            const conflictPaths = applied?.conflictPaths ?? [];
            if (conflictPaths.length > 0 && !recordedStagedResultRef) {
              throw new Error("Recovered cloud workspace conflict has no staged result reference");
            }
            const supersededConflict =
              priorWorkspaceResultConflict &&
              (conflictPaths.length === 0 ||
                priorWorkspaceResultConflict.stagedResultRef !== recordedStagedResultRef)
                ? priorWorkspaceResultConflict
                : undefined;
            if (
              supersededConflict &&
              supersededConflict.stagedResultRef !== recordedStagedResultRef
            ) {
              await deleteStagedWorkerWorkspaceResult({
                root: localPath,
                stagedResultRef: supersededConflict.stagedResultRef,
              });
            }
            if (conflictPaths.length > 0 && recordedStagedResultRef) {
              const projectedConflict = projectWorkspaceResultConflict(
                conflictPaths,
                recordedStagedResultRef,
              );
              placements.recordWorkspaceResultConflict(turnClaim, projectedConflict);
              await deps.reportWorkspaceResultConflict({
                sessionId: placement.sessionId,
                sessionKey: placement.sessionKey,
                agentId: placement.agentId,
                ...projectedConflict,
              });
            } else if (supersededConflict) {
              placements.recordWorkspaceResultConflict(turnClaim, undefined);
            }
            if (supersededConflict && conflictPaths.length === 0) {
              await deps.reportWorkspaceResultConflict({
                sessionId: placement.sessionId,
                sessionKey: placement.sessionKey,
                agentId: placement.agentId,
                cleared: true,
              });
            }
            const cleanupRef =
              recordedStagedResultRef && conflictPaths.length === 0
                ? await moveStagedWorkerWorkspaceResultToCleanup({
                    root: localPath,
                    stagedResultRef: recordedStagedResultRef,
                  })
                : undefined;
            if (sameGatewayInstance) {
              await quiescence.resume();
              quiescenceHandled = true;
              placements.completeWorkspaceResultAndReleaseTurn(turnClaim);
            } else {
              await environments.destroy(placement.environmentId);
              quiescenceHandled = true;
              const reclaimed = placements.completeWorkspaceResultAndReleaseTurn(turnClaim, {
                reclaim: true,
              });
              if (reclaimed.state !== "reclaimed") {
                throw new Error("Recovered worker result did not reclaim its stale environment");
              }
              await environments
                .stopTunnel(placement.environmentId, placement.activeOwnerEpoch)
                .catch(() => undefined);
            }
            if (cleanupRef) {
              await deleteStagedWorkerWorkspaceResult({
                root: localPath,
                stagedResultRef: cleanupRef,
              }).catch(() => undefined);
            }
          } finally {
            if (!quiescenceHandled) {
              await quiescence.resume();
            }
          }
        });
      } catch {
        // Keep the result, claim, and environment fenced. The next sweep retries.
      }
    }
    if (cleanupOrphans) {
      const retainedCleanupRefs = new Set(
        placements
          .listPendingWorkspaceResults()
          .flatMap((pending) =>
            pending.stagedResultRef
              ? [cleanupWorkerWorkspaceResultRef(pending.stagedResultRef)]
              : [],
          ),
      );
      const cleanedWorkspaceRoots = new Set<string>();
      for (const placement of placements.list()) {
        try {
          const root = await deps.resolveWorkspacePath(placement);
          if (!cleanedWorkspaceRoots.has(root)) {
            cleanedWorkspaceRoots.add(root);
            await deleteWorkerWorkspaceResultCleanupRefs({
              root,
              retainedRefs: retainedCleanupRefs,
            });
          }
        } catch {
          // Cleanup refs are independently retryable on the next startup sweep.
        }
      }
    }
    return new Set([
      ...stagedResultOwners,
      ...placements.listPendingWorkspaceResults().map((pending) => pending.sessionId),
    ]);
  };

  const adoptActive = async (placement: WorkerActiveDispatchPlacement): Promise<void> => {
    // Worker turns are one-shot SSH children owned by the previous gateway process. A durable
    // claim cannot prove that child remains live after restart, so fence the whole placement.
    if (placement.turnClaim) {
      const error = new Error(
        "Active worker turn claim cannot be proven live after gateway restart",
      );
      await failure.failActive(placement, error, { forceClaimFence: true });
      return;
    }
    const environment = placement.environmentId
      ? environments.get(placement.environmentId)
      : undefined;
    if (!environment || isUnavailableEnvironment(environment)) {
      await failure.reclaimActive(
        placement,
        environment,
        new Error("Active worker disappeared during restart reconciliation"),
      );
      return;
    }
    if (!sameActiveEnvironment(placement, environment)) {
      await failure.reclaimActive(
        placement,
        environment,
        new Error("Active worker placement does not match its environment owner"),
      );
      return;
    }
    try {
      await environments.startTunnel({
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
      });
      placements.adoptActive({
        sessionId: placement.sessionId,
        expectedGeneration: placement.generation,
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
      });
    } catch (error) {
      await failure.failActive(placement, error);
    }
  };

  const resumeStarting = async (placement: WorkerStartingDispatchPlacement): Promise<void> => {
    const environment = placement.environmentId
      ? environments.get(placement.environmentId)
      : undefined;
    const expectedBundle = placement.workerBundleHash;
    const hasSyncedWorkspace = Boolean(
      placement.workspaceBaseManifestRef && placement.remoteWorkspaceDir,
    );
    const canResume =
      environment &&
      expectedBundle &&
      environment.bootstrapReceipt?.bundleHash === expectedBundle &&
      hasSyncedWorkspace;
    if (!canResume) {
      const error = new Error("Interrupted worker dispatch cannot safely resume");
      await failure.teardownEnvironment({
        placement,
        environmentId: placement.environmentId,
        ownerEpoch: environment?.ownerEpoch ?? null,
        primaryError: error,
      });
      return;
    }
    try {
      const ownerEpoch =
        environment.state === "attached" &&
        environment.attachedSessionIds.length === 1 &&
        environment.attachedSessionIds[0] === placement.sessionId
          ? environment.ownerEpoch
          : environment.state === "ready" || environment.state === "idle"
            ? (
                await environments.attachSession({
                  environmentId: environment.environmentId,
                  ownerEpoch: environment.ownerEpoch,
                  sessionId: placement.sessionId,
                })
              ).ownerEpoch
            : undefined;
      if (ownerEpoch === undefined) {
        throw new Error(`Worker environment cannot resume dispatch from ${environment.state}`);
      }
      await environments.startTunnel({ environmentId: environment.environmentId, ownerEpoch });
      await deps.runActivationBarrier({
        sessionId: placement.sessionId,
        sessionKey: placement.sessionKey,
        agentId: placement.agentId,
        activate: () => {
          const activated = placements.transition({
            sessionId: placement.sessionId,
            from: "starting",
            to: "active",
            expectedGeneration: placement.generation,
            patch: { activeOwnerEpoch: ownerEpoch },
          });
          if (activated.state !== "active") {
            throw new Error("Worker dispatch activation did not produce an active placement");
          }
          return activated;
        },
      });
    } catch (error) {
      await failure.teardownEnvironment({
        placement,
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
        primaryError: error,
      });
    }
  };

  const reconcile = async (): Promise<void> => {
    await environments.reconcileOnce();
    const pendingResultOwners = await recoverPendingWorkspaceResults(true);
    const journalOwners = new Set(
      placements.listWorkspaceReconciliationOwners().map((owner) => owner.sessionId),
    );
    for (const placement of placements.listForReconcile()) {
      if (journalOwners.has(placement.sessionId) || pendingResultOwners.has(placement.sessionId)) {
        continue;
      }
      if (placement.state === "local" || placement.state === "reclaimed") {
        continue;
      }
      if (placement.state === "active") {
        await adoptActive(placement);
        continue;
      }
      if (isFailedPlacement(placement)) {
        await failure.retryFailedTeardown(placement);
        continue;
      }
      if (isStartingPlacement(placement)) {
        await resumeStarting(placement);
        continue;
      }
      const error = new Error(`Worker dispatch interrupted in ${placement.state}`);
      if (placement.state === "draining") {
        await failure.failDraining(placement, error, { forceClaimFence: true });
        continue;
      }
      await failure.teardownEnvironment({
        placement,
        environmentId: placement.environmentId,
        ownerEpoch: placement.activeOwnerEpoch,
        primaryError: error,
      });
    }
  };

  // Runtime sweeps must not classify a live dispatch preparation as a crash. They only repair
  // durable active ownership and retry teardown already fenced by a previous failure.
  const reconcileActive = async (environmentId?: string): Promise<void> => {
    await environments.reconcileOnce();
    const pendingResultOwners = await recoverPendingWorkspaceResults(false);
    const journalOwners = new Set(
      placements.listWorkspaceReconciliationOwners().map((owner) => owner.sessionId),
    );
    for (const placement of placements.listForReconcile()) {
      if (journalOwners.has(placement.sessionId) || pendingResultOwners.has(placement.sessionId)) {
        continue;
      }
      if (environmentId !== undefined && placement.environmentId !== environmentId) {
        continue;
      }
      if (isFailedPlacement(placement)) {
        await failure.retryFailedTeardown(placement);
        continue;
      }
      if (placement.state !== "active") {
        continue;
      }
      const environment = environments.get(placement.environmentId);
      if (!environment || isUnavailableEnvironment(environment)) {
        await failure.reclaimActive(
          placement,
          environment,
          new Error("Active worker disappeared during an admitted turn"),
        );
        continue;
      }
      if (!sameActiveEnvironment(placement, environment)) {
        await failure.reclaimActive(
          placement,
          environment,
          new Error("Active worker placement does not match its environment owner"),
        );
      }
    }
  };

  return { reconcile, reconcileActive };
}
