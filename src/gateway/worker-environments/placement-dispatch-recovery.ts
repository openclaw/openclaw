import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { supportsCurrentWorkerLaunch } from "./admission.js";
import { hasForcedWorkerEnvironmentAbandonment } from "./environment-errors.js";
import {
  isCurrentActiveWorkerEnvironment,
  isUnavailableEnvironment,
  workerDisappearanceError,
  type WorkerActiveDispatchPlacement,
  type WorkerDispatchEnvironmentService,
} from "./placement-dispatch-failure.js";
import { cleanupPendingWorkspaceResultOrphans } from "./placement-dispatch-orphan-cleanup.js";
import { recoverPendingWorkspaceResults } from "./placement-dispatch-pending-results.js";
import { forceAbandonWorkerEnvironment } from "./placement-force-abandon.js";
import type { WorkerSessionPlacementProjection } from "./placement-read-projection.types.js";
import { matchesWorkerPlacementTarget } from "./placement-reclaim-contract.js";
import {
  placementTurnOwner,
  projectWorkerSessionTurnClaim,
  serializeWorkerSessionTurnClaim,
} from "./placement-record.js";
import type {
  PlacementRecoveryDeps,
  WorkerPlacementRecoveryAdmission,
} from "./placement-recovery-contract.js";
import { WorkerRuntimeRefreshPendingError } from "./provider-runtime-refresh.js";
import { boundedWorkerError } from "./worker-error.js";

const log = createSubsystemLogger("gateway/worker-placement");

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

export function createPlacementRecoveryActions(deps: PlacementRecoveryDeps) {
  const { environments, failure, placements } = deps;
  const interruptedClaims = new Set(
    placements.list().flatMap((placement) => {
      const claim = projectWorkerSessionTurnClaim(placement);
      return claim ? [serializeWorkerSessionTurnClaim(claim)] : [];
    }),
  );
  // Orphan Git refs carry no live authority. Scan them once in the tracked full
  // post-start sweep, never on readiness or targeted turn recovery.
  let orphanCleanupPending = false;

  const reconcileActivePlacement = async (
    initialPlacement: WorkerActiveDispatchPlacement,
    mode: "restart" | "runtime",
    facts: WorkerSessionPlacementProjection,
  ): Promise<void> => {
    let placement = initialPlacement;
    let environment = environments.get(placement.environmentId);
    // Retire the old turn, not its machine. The node stop acknowledgement fences the
    // physical worker; the replacement turn receives a fresh claim on the same workspace.
    const claim = projectWorkerSessionTurnClaim(placement);
    const interrupted = claim && interruptedClaims.has(serializeWorkerSessionTurnClaim(claim));
    if ((mode === "restart" || interrupted) && placement.turnClaim) {
      if (
        claim &&
        interrupted &&
        environment?.nodeDeviceId &&
        isCurrentActiveWorkerEnvironment(placement, environment) &&
        !facts.moves.has(placement.sessionId)
      ) {
        try {
          await environments.stopTunnel(placement.environmentId, placement.activeOwnerEpoch);
          await placements.closeWorkerTurnToolState(claim);
          const current = placements.get(placement.sessionId);
          const currentEnvironment = environments.get(placement.environmentId);
          if (
            current?.state !== "active" ||
            current.generation !== placement.generation ||
            currentEnvironment?.nodeDeviceId !== environment.nodeDeviceId ||
            !isCurrentActiveWorkerEnvironment(current, currentEnvironment) ||
            placements.getPlacementMove(placement.sessionId)
          ) {
            throw new Error("Interrupted worker owner changed while stopping");
          }
          await placements.retainInterruptedTurnWorkspace(claim, () => {
            const releaseEnvironment = environments.get(placement.environmentId);
            if (!isCurrentActiveWorkerEnvironment(placement, releaseEnvironment)) {
              throw new Error("Interrupted worker owner changed before workspace recovery");
            }
          });
          const pendingFacts = await placements.readProjection([placement.sessionId], {
            current: true,
          });
          await recoverPendingWorkspaceResults(deps, pendingFacts, placement.environmentId);
          const recovered = (
            await placements.readProjection([placement.sessionId], { current: true })
          ).placements.get(placement.sessionId);
          if (
            recovered?.state !== "active" ||
            !matchesWorkerPlacementTarget(recovered, placement) ||
            recovered.turnClaim
          ) {
            return;
          }
          interruptedClaims.delete(serializeWorkerSessionTurnClaim(claim));
          placement = recovered;
          environment = environments.get(placement.environmentId);
        } catch (error) {
          log.warn(
            `Interrupted cloud worker is waiting for recovery: ${boundedWorkerError(error)}`,
          );
          return;
        }
      } else {
        const error = new Error(
          "Active worker turn claim cannot be proven live after gateway restart",
        );
        await failure.failActive(placement, error, { forceClaimFence: true });
        return;
      }
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
      placements.adoptActive({
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
    let facts = await placements.readProjection([sessionId], { current: true });
    const stagedOwners = await recoverPendingWorkspaceResults(deps, facts, environmentId);
    if (resultsOnly === "results-only") {
      return;
    }
    facts = await placements.readProjection([sessionId], { current: true });
    const blocked =
      stagedOwners.has(sessionId) ||
      facts.pendingResults.has(sessionId) ||
      facts.workspaceJournalOwnerSessionIds.has(sessionId);
    const moveOwners =
      (await deps.recoverPlacementMoves?.(facts, environmentId)) ?? new Set<string>();
    if (blocked || moveOwners.has(sessionId)) {
      return;
    }
    facts = await placements.readProjection([sessionId], { current: true });
    for (const placement of facts.placements.values()) {
      if (environmentId !== undefined && placement.environmentId !== environmentId) {
        continue;
      }
      if (mode === "runtime") {
        if (placement.state === "failed") {
          await failure.retryFailedTeardown(placement);
        } else if (placement.state === "active") {
          await reconcileActivePlacement(placement, "runtime", facts);
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
        if (
          exactEnvironment &&
          exactEnvironment.destroyRequestedAtMs === null &&
          (exactEnvironment.state === "requested" ||
            exactEnvironment.state === "provisioning" ||
            exactEnvironment.state === "bootstrapping" ||
            ((exactEnvironment.state === "ready" || exactEnvironment.state === "idle") &&
              supportsCurrentWorkerLaunch(exactEnvironment.bootstrapReceipt)))
        ) {
          // Transient provider or node-enrollment failure retains its exact durable operation.
          continue;
        }
        await failure.teardownEnvironment({
          placement,
          environmentId: exactEnvironment?.environmentId ?? null,
          ownerEpoch: exactEnvironment?.ownerEpoch ?? null,
          primaryError: new Error(
            exactEnvironment
              ? `Provisioning worker environment cannot be recovered from ${exactEnvironment.state}`
              : "Provisioning worker environment record is missing",
          ),
        });
        continue;
      }
      if (placement.state === "active") {
        await reconcileActivePlacement(placement, "restart", facts);
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
    // Environment reconciliation can resume provisioning through session admission.
    // It must finish outside admission, before any recoverSession unit enters it.
    if (mode === "startup") {
      // Older Gateways can commit draining before claiming a result, or release
      // an unstaged failed claim. The draining placement still owes a final save.
      for (const { sessionId } of await placements.readRecoveryCandidates()) {
        let abandonedEnvironmentId: string | undefined;
        // A busy session has a live lifecycle operation in this process that owns its final save.
        await admit([sessionId], async () => {
          const facts = await placements.readProjection([sessionId], { current: true });
          const placement = facts.placements.get(sessionId);
          if (!placement || facts.moves.has(sessionId)) {
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
              await forceAbandonWorkerEnvironment({
                ...deps,
                environmentId: environment.environmentId,
              });
            });
            abandonedEnvironmentId = environment.environmentId;
            return;
          }
          if (
            placement.state !== "draining" ||
            placement.turnClaim ||
            facts.pendingResults.has(sessionId)
          ) {
            return;
          }
          const claimId = `reclaim-${randomUUID()}`;
          const claim = placements.claimReclaimWorkspaceResult(
            {
              sessionId: placement.sessionId,
              sessionKey: placement.sessionKey,
              agentId: placement.agentId,
              claimId,
              runId: claimId,
              owner: placementTurnOwner(placement),
            },
            (recoveryClaim) => environments.fenceWorkerTurnForRecovery(recoveryClaim),
          );
          placements.handoffWorkspaceResultRecovery(claim);
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
            ? [() => environments.reconcileEnvironment(environmentId)]
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
    const candidates = await placements.readRecoveryCandidates();
    if (mode === "startup") {
      orphanCleanupPending = true;
    }
    for (const { sessionId } of candidates) {
      await admit([sessionId], () => recoverSession(sessionId, mode ?? "restart"));
    }
    if (mode !== "startup" && orphanCleanupPending) {
      orphanCleanupPending = !(await cleanupPendingWorkspaceResultOrphans(deps, admit));
    }
  };

  // Runtime sweeps must not classify a live dispatch preparation as a crash. They only repair
  // durable active ownership and retry teardown already fenced by a previous failure.
  const reconcileActive = async (
    environmentId?: string,
    admit: WorkerPlacementRecoveryAdmission = admitRecovery,
  ): Promise<void> => {
    await environments.reconcileOnce(environmentId);
    for (const candidate of await placements.readRecoveryCandidates()) {
      if (
        environmentId !== undefined &&
        candidate.environmentId !== environmentId &&
        candidate.moveSourceEnvironmentId !== environmentId
      ) {
        continue;
      }
      await admit([candidate.sessionId], (mode) =>
        recoverSession(candidate.sessionId, "runtime", environmentId, mode),
      );
    }
    if (orphanCleanupPending && environmentId === undefined) {
      orphanCleanupPending = !(await cleanupPendingWorkspaceResultOrphans(deps, admit));
    }
  };

  return { reconcile, reconcileActive };
}
