import { randomUUID } from "node:crypto";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { DEVICE_FOLDER_MANIFEST_REF } from "../../worker/device-folder.js";
import { measureGatewayRestartTrace } from "../restart-trace.js";
import { hasForcedWorkerEnvironmentAbandonment } from "./environment-errors.js";
import {
  isUnavailableEnvironment,
  workerDisappearanceError,
  type WorkerActiveDispatchPlacement,
  type WorkerDispatchPlacement,
  type WorkerDispatchEnvironmentService,
} from "./placement-dispatch-failure.js";
import {
  cleanupPendingWorkspaceResultOrphans,
  subscribeWorkspaceResultOrphanChanges,
  type PendingWorkspaceResultOrphanCleanup,
} from "./placement-dispatch-orphan-cleanup.js";
import { recoverPendingWorkspaceResults } from "./placement-dispatch-pending-results.js";
import { forceAbandonWorkerEnvironment } from "./placement-force-abandon.js";
import {
  placementTurnOwner,
  projectPlacementTurnClaim,
  projectWorkerSessionTurnClaim,
} from "./placement-record.js";
import type {
  PlacementRecoveryDeps,
  WorkerPlacementRecoveryAdmission,
} from "./placement-recovery-contract.js";
import {
  isCurrentActiveWorkerEnvironment,
  isExactAttachedEnvironment,
} from "./placement-target.js";
import { WorkerRuntimeRefreshPendingError } from "./provider-runtime-refresh.js";

const admitRecovery: WorkerPlacementRecoveryAdmission = async (_sessionIds, run) => {
  await run();
  return true;
};

function activePlacementExecutionError(
  placement: WorkerActiveDispatchPlacement,
  environment: NonNullable<ReturnType<WorkerDispatchEnvironmentService["get"]>>,
  environments: Pick<WorkerDispatchEnvironmentService, "supportsProviderExecutionMode">,
): Error | undefined {
  const provisionedMode = environment.profileSnapshot.executionMode;
  if (provisionedMode !== undefined && provisionedMode !== placement.executionMode) {
    return new Error("Active worker placement execution mode does not match its environment");
  }
  if (placement.executionMode === "worker-turn" && !environment.nodeDeviceId) {
    return new Error("Active worker-turn placement requires a node lease");
  }
  if (
    !environments.supportsProviderExecutionMode(environment.providerId, placement.executionMode)
  ) {
    return new Error(
      `Worker provider ${environment.providerId} does not support ${placement.executionMode} placement`,
    );
  }
  return undefined;
}

export function createPlacementRecoveryActions(
  deps: PlacementRecoveryDeps,
  initialPlacements: readonly WorkerDispatchPlacement[],
) {
  const { environments, failure, placements } = deps;
  // Retire orphan refs in bounded post-start sweeps, never on readiness or targeted recovery.
  // Completed roots belong to this startup pass; settlement removes new refs itself.
  let orphanCleanupPending: PendingWorkspaceResultOrphanCleanup | undefined;

  const retainDrainingWorkspace = async (
    placement: Extract<WorkerDispatchPlacement, { state: "draining" }>,
  ): Promise<boolean> => {
    if (!isExactAttachedEnvironment(environments.get(placement.environmentId), placement)) {
      return false;
    }
    const assertCurrent = () => {
      if (
        deps.isShuttingDown?.() ||
        !isExactAttachedEnvironment(environments.get(placement.environmentId), placement)
      ) {
        throw new Error("Interrupted worker file handoff lost its attachment owner");
      }
    };
    const claimId = `reclaim-${randomUUID()}`;
    // A stopped placement still owns files. This claim grants only result settlement,
    // never permission to resume the old execution or call its tools.
    const claim =
      projectPlacementTurnClaim(placement) ??
      (await placements.claimReclaimWorkspaceResult(
        {
          sessionId: placement.sessionId,
          sessionKey: placement.sessionKey,
          agentId: placement.agentId,
          claimId,
          runId: claimId,
          owner: placementTurnOwner(placement),
        },
        undefined,
        assertCurrent,
      ));
    await placements.retainInterruptedTurnWorkspace(claim, assertCurrent);
    return true;
  };

  const reconcileActivePlacement = async (
    placement: WorkerActiveDispatchPlacement,
    mode: "restart" | "runtime",
  ): Promise<void> => {
    const environment = environments.get(placement.environmentId);
    if (mode === "restart" && placement.turnClaim) {
      const claim = projectWorkerSessionTurnClaim(placement);
      if (claim && isExactAttachedEnvironment(environment, placement)) {
        // Retain files before stopping the old worker; this never adopts its execution authority.
        await placements.retainInterruptedTurnWorkspace(claim, () => {
          if (
            deps.isShuttingDown?.() ||
            !isExactAttachedEnvironment(environments.get(placement.environmentId), placement)
          ) {
            throw new Error("Interrupted worker file handoff lost its attachment owner");
          }
        });
        await recoverPendingWorkspaceResults(
          deps,
          await placements.readProjection([placement.sessionId], { current: true }),
        );
        return;
      }
      await failure.failActive(
        placement,
        new Error("Active worker turn claim cannot be proven live after gateway restart"),
        { forceClaimFence: true },
      );
      return;
    }
    if (
      placement.workspaceBaseManifestRef === DEVICE_FOLDER_MANIFEST_REF &&
      (!environment ||
        workerDisappearanceError(environment) ||
        isUnavailableEnvironment(environment))
    ) {
      // There is no Gateway copy to fall back to. Preserve the device binding indefinitely.
      return;
    }
    const disappearance = workerDisappearanceError(environment);
    if (disappearance || (environment && isUnavailableEnvironment(environment))) {
      await failure.reclaimActive(
        placement,
        environment,
        disappearance ?? new Error(`Active worker environment is ${environment?.state}`),
      );
      return;
    }
    if (!environment || !isCurrentActiveWorkerEnvironment(placement, environment)) {
      await failure.reclaimActive(
        placement,
        environment,
        new Error("Active worker placement does not match its environment owner"),
      );
      return;
    }
    if (mode === "runtime") {
      const executionError = activePlacementExecutionError(placement, environment, environments);
      if (executionError) {
        await failure.failActive(placement, executionError, { forceClaimFence: true });
      }
      return;
    }
    try {
      const executionError = activePlacementExecutionError(placement, environment, environments);
      if (executionError) {
        throw executionError;
      }
      // Node leases stay authoritative while offline; their reconnect-scoped
      // tunnel is validated lazily when the next turn actually launches.
      if (!environment.nodeDeviceId) {
        await environments.startTunnel({
          environmentId: environment.environmentId,
          ownerEpoch: environment.ownerEpoch,
        });
      }
      await placements.adoptActive({
        sessionId: placement.sessionId,
        expectedGeneration: placement.generation,
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
      });
    } catch (error) {
      if (error instanceof WorkerRuntimeRefreshPendingError) {
        // The provider still owns this machine. A failed runtime update closes
        // execution until retry; it is not evidence that the lease must be reclaimed.
        return;
      }
      await failure.failActive(placement, error);
    }
  };

  const recoverSession = async (
    sessionId: string,
    mode: "startup" | "restart" | "runtime",
    environmentId?: string,
    resultsOnly?: "results-only",
  ): Promise<void> => {
    if (deps.isShuttingDown?.()) {
      return;
    }
    let facts = await placements.readProjection([sessionId], { current: true });
    if (deps.isShuttingDown?.()) {
      return;
    }
    // Once recovery accepts a result, finish this session's durable settlement.
    const stagedOwners =
      facts.pendingResults.size > 0
        ? await recoverPendingWorkspaceResults(deps, facts, environmentId)
        : undefined;
    if (resultsOnly === "results-only" || deps.isShuttingDown?.()) {
      return;
    }
    if (stagedOwners) {
      facts = await placements.readProjection([sessionId], { current: true });
    }
    if (deps.isShuttingDown?.()) {
      return;
    }
    const blocked =
      stagedOwners?.has(sessionId) ||
      facts.pendingResults.has(sessionId) ||
      facts.workspaceJournalOwnerSessionIds.has(sessionId);
    const moveOwners =
      facts.moves.size > 0 ? await deps.recoverPlacementMoves?.(facts, environmentId) : undefined;
    if (blocked || moveOwners?.has(sessionId) || deps.isShuttingDown?.()) {
      return;
    }
    if (moveOwners) {
      facts = await placements.readProjection([sessionId], { current: true });
    }
    for (const placement of facts.placements.values()) {
      if (environmentId !== undefined && placement.environmentId !== environmentId) {
        continue;
      }
      if (mode === "runtime") {
        if (placement.state === "failed") {
          await failure.retryFailedTeardown(placement);
        } else if (placement.state === "active") {
          await reconcileActivePlacement(placement, "runtime");
        }
        continue;
      }
      if (placement.state === "local" || placement.state === "reclaimed") {
        continue;
      }
      if (placement.state === "provisioning") {
        const environment = placement.environmentId
          ? environments.get(placement.environmentId)
          : undefined;
        const exactEnvironment =
          environment?.environmentId === placement.environmentId ? environment : undefined;
        await failure.teardownEnvironment({
          placement,
          environmentId: exactEnvironment?.environmentId ?? null,
          ownerEpoch: exactEnvironment?.ownerEpoch ?? null,
          primaryError: new Error("Cloud worker provisioning canceled by Gateway restart"),
        });
        continue;
      }
      if (placement.state === "active") {
        await reconcileActivePlacement(placement, "restart");
        continue;
      }
      if (placement.state === "failed") {
        // Terminal cleanup never gates readiness; tracked post-start owners resume it safely.
        if (mode !== "startup") {
          await failure.retryFailedTeardown(placement);
        }
        continue;
      }
      const error = new Error(`Worker dispatch interrupted in ${placement.state}`);
      if (placement.state === "draining") {
        if (await retainDrainingWorkspace(placement)) {
          await recoverPendingWorkspaceResults(
            deps,
            await placements.readProjection([sessionId], { current: true }),
          );
          continue;
        }
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

  const reconcile = async (
    mode?: "startup",
    admit: WorkerPlacementRecoveryAdmission = admitRecovery,
  ): Promise<void> => {
    if (deps.isShuttingDown?.()) {
      return;
    }
    // Cancel old setup before environment reconciliation can perform provider work.
    // Existing allocations, staged results, and move journals retain their cleanup owners.
    if (mode === "startup") {
      // Retire interrupted setup and explicitly abandoned resources. Interrupted worker
      // claims transfer only file custody to the existing result-settlement owner.
      for (const { sessionId } of await placements.readRecoveryCandidates()) {
        if (deps.isShuttingDown?.()) {
          return;
        }
        let abandonedEnvironmentId: string | undefined;
        // A busy session has a live lifecycle operation in this process that owns its final save.
        await admit([sessionId], async () => {
          if (deps.isShuttingDown?.()) {
            return;
          }
          const facts = await placements.readProjection([sessionId], { current: true });
          if (deps.isShuttingDown?.()) {
            return;
          }
          const placement = facts.placements.get(sessionId);
          if (!placement || facts.moves.has(sessionId)) {
            return;
          }
          if (placement.state === "provisioning") {
            const environment = placement.environmentId
              ? environments.get(placement.environmentId)
              : undefined;
            await failure.teardownEnvironment({
              placement,
              environmentId: environment?.environmentId ?? null,
              ownerEpoch: environment?.ownerEpoch ?? null,
              primaryError: new Error("Cloud worker provisioning canceled by Gateway restart"),
            });
            return;
          }
          const environment = placement.environmentId
            ? environments.get(placement.environmentId)
            : undefined;
          if (
            (placement.state === "active" ||
              placement.state === "draining" ||
              placement.state === "reconciling") &&
            environment &&
            hasForcedWorkerEnvironmentAbandonment(environment) &&
            environment.ownerEpoch === placement.activeOwnerEpoch
          ) {
            await deps.workspaceOperations.run(environment.environmentId, async () => {
              if (deps.isShuttingDown?.()) {
                return;
              }
              await forceAbandonWorkerEnvironment({
                ...deps,
                environmentId: environment.environmentId,
              });
              abandonedEnvironmentId = environment.environmentId;
            });
            return;
          }
          if (placement.state === "draining" && !facts.pendingResults.has(sessionId)) {
            await retainDrainingWorkspace(placement);
          }
        });
        const environmentId = abandonedEnvironmentId;
        if (environmentId) {
          // Abandonment is durable; release session admission before the guard can re-enter it.
          await deps.workspaceOperations.run(environmentId, () =>
            environments.reconcileEnvironment(environmentId),
          );
        }
      }
      // Drain the bounded environment pass before recovering placement authority or results.
      // Unowned teardown remains in the service-owned sweep.
      const reconciled = await runTasksWithConcurrency({
        tasks: (await placements.readRecoveryCandidates()).flatMap(({ environmentId, state }) =>
          environmentId && state !== "failed" && state !== "local" && state !== "reclaimed"
            ? [
                async () => {
                  if (!deps.isShuttingDown?.()) {
                    await environments.reconcileEnvironment(environmentId);
                  }
                },
              ]
            : [],
        ),
        limit: 8,
        errorMode: "stop",
      });
      if (reconciled.hasError) {
        throw reconciled.firstError;
      }
    } else {
      await environments.reconcileOnce();
    }
    if (deps.isShuttingDown?.()) {
      return;
    }
    const candidates = await placements.readRecoveryCandidates();
    if (mode === "startup") {
      const lookups = initialPlacements.map((placement) => ({
        placement,
        target: undefined,
        dirty: false,
      }));
      orphanCleanupPending =
        lookups.length > 0
          ? {
              placements: lookups,
              initialDiscoveryPending: true,
              unresolved: new Set(lookups),
              rootsBySession: new Map(),
              completedRoots: new Set(),
            }
          : undefined;
    }
    for (const { sessionId } of candidates) {
      if (deps.isShuttingDown?.()) {
        return;
      }
      await admit([sessionId], () => recoverSession(sessionId, mode ?? "restart"));
    }
    if (
      mode !== "startup" &&
      orphanCleanupPending &&
      (await cleanupPendingWorkspaceResultOrphans(deps, admit, orphanCleanupPending))
    ) {
      orphanCleanupPending = undefined;
    }
  };

  // Runtime sweeps must not classify a live dispatch preparation as a crash. They only repair
  // durable active ownership and retry teardown already fenced by a previous failure.
  const reconcileActive = async (
    environmentId?: string,
    admit: WorkerPlacementRecoveryAdmission = admitRecovery,
  ): Promise<void> => {
    if (deps.isShuttingDown?.()) {
      return;
    }
    await measureGatewayRestartTrace(
      "worker-placement.reconcile.environments",
      () => environments.reconcileOnce(environmentId),
      undefined,
      true,
    );
    // Cancellation can settle the environment pass while the shared store is still busy.
    // Do not start a fresh discovery read (or its recovery writes) during shutdown.
    if (deps.isShuttingDown?.()) {
      return;
    }
    const candidates = await measureGatewayRestartTrace(
      "worker-placement.reconcile.candidates",
      () => placements.readRecoveryCandidates(),
      undefined,
      true,
    );
    for (const candidate of candidates) {
      if (deps.isShuttingDown?.()) {
        return;
      }
      if (
        environmentId !== undefined &&
        candidate.environmentId !== environmentId &&
        candidate.moveSourceEnvironmentId !== environmentId
      ) {
        continue;
      }
      await measureGatewayRestartTrace(
        "worker-placement.reconcile.session",
        () =>
          admit([candidate.sessionId], (mode) =>
            recoverSession(candidate.sessionId, "runtime", environmentId, mode),
          ),
        undefined,
        true,
      );
    }
    if (
      orphanCleanupPending &&
      environmentId === undefined &&
      (await cleanupPendingWorkspaceResultOrphans(deps, admit, orphanCleanupPending))
    ) {
      orphanCleanupPending = undefined;
    }
  };

  return {
    reconcile,
    reconcileActive,
    subscribeOrphanWorkspaceChanges: () =>
      subscribeWorkspaceResultOrphanChanges(() => orphanCleanupPending),
  };
}
