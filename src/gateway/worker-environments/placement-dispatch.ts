import { getRuntimeConfig } from "../../config/config.js";
import { resolveNodeCommandAllowlist } from "../node-command-policy.js";
import { assertWorkerRecoveryExecutorReleased } from "./environment-record.js";
import { PreparedWorkspaceRegistrationMissingError } from "./node-worker-prepared-workspace-transport.js";
import { recordWorkerPlacementStage } from "./placement-diagnostics.js";
import {
  createPlacementFailureActions,
  type WorkerActiveDispatchPlacement,
  type WorkerDispatchPlacement,
} from "./placement-dispatch-failure.js";
import { createPlacementRecoveryActions } from "./placement-dispatch-recovery.js";
import { createWorkerPlacementDispatchStartup } from "./placement-dispatch-startup.js";
import { PreparedEnvironmentBindingIndeterminateError } from "./placement-dispatch-store.js";
import type { WorkerPlacementDispatchOptions } from "./placement-dispatch.types.js";
import { createWorkerPlacementMoveAbandonment } from "./placement-move-abandon.js";
import { createWorkerPlacementMoveService } from "./placement-move-service.js";
import type {
  WorkerPlacementPendingOperations,
  WorkerReclaimPlacement,
} from "./placement-reclaim-contract.js";
import { createWorkerPlacementReclaim } from "./placement-reclaim.js";
import { reportPlacementTransition } from "./placement-record.js";
import {
  isFailedWorkerPlacementEnvironmentGone,
  matchesWorkerPlacementTarget,
  type WorkerPlacementCancellationTarget,
} from "./placement-target.js";
import { createRetainedWorkerRecovery } from "./retained-worker-recovery.js";
import type {
  WorkerPlacementDispatchRequest,
  WorkerPlacementAuthorization,
  WorkerPlacementReclaimRequest,
  WorkerPlacementReclaimSourceCheck,
} from "./service-contract.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";
import { WorkerTunnelOwnerDisconnectedError } from "./tunnel-contract.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";

export function createWorkerPlacementDispatchService(options: WorkerPlacementDispatchOptions) {
  const { environments, placements } = options;
  const failure = createPlacementFailureActions({ environments, placements });

  const startup = createWorkerPlacementDispatchStartup({
    ...options,
    failure,
  });

  // Background recovery observes previously requested cleanup; explicit Stop and
  // Move retain their retry contract. Pending-result recovery must inherit this too.
  const recoveryEnvironments = { ...environments, destroy: environments.requestDestroy };
  const recovery = createPlacementRecoveryActions({
    ...options,
    environments: recoveryEnvironments,
    failure: createPlacementFailureActions({ environments: recoveryEnvironments, placements }),
    recoverPlacementMoves: (projection, environmentId) =>
      moveService.recoverSession(projection, environmentId),
  });

  const dispatch = async (
    request: WorkerPlacementDispatchRequest,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
    authorize?: WorkerPlacementAuthorization,
    signal?: AbortSignal,
  ): Promise<WorkerActiveDispatchPlacement> => {
    const assertCurrent = () => {
      signal?.throwIfAborted();
      authorize?.();
    };
    let placement: WorkerDispatchPlacement | undefined;
    try {
      signal?.throwIfAborted();
      placement = await options.runLocalBarrier({
        sessionId: request.sessionId,
        sessionKey: request.sessionKey,
        agentId: request.agentId,
        executionMode: request.executionMode,
        authorize: assertCurrent,
        signal,
        startDispatch: async () => {
          const assertStartCurrent = () => {
            assertCurrent();
            const previous = placements.get(request.sessionId);
            if (
              (previous?.state === "failed" || previous?.state === "reclaimed") &&
              previous.environmentId
            ) {
              const environment = environments.get(previous.environmentId);
              if (!environment) {
                throw new Error(
                  "Previous worker ownership is unavailable before replacement allocation",
                );
              }
              assertWorkerRecoveryExecutorReleased(environment);
            }
            if (coldSource) {
              const current = placements.get(request.sessionId);
              if (
                !matchesWorkerPlacementTarget(current, coldSource) ||
                current?.sessionKey !== request.sessionKey ||
                current.agentId !== request.agentId ||
                current.executionMode !== request.executionMode
              ) {
                throw new Error("Settled prepared worker changed before cold dispatch admission");
              }
            }
          };
          assertStartCurrent();
          const expectedPlacement = coldSource
            ? {
                state: coldSource.state,
                generation: coldSource.generation,
                environmentId: coldSource.environmentId,
                activeOwnerEpoch: coldSource.activeOwnerEpoch,
              }
            : request.expectedPlacement;
          placement = await placements.startDispatch(
            {
              sessionId: request.sessionId,
              sessionKey: request.sessionKey,
              agentId: request.agentId,
              executionMode: request.executionMode,
              ...(expectedPlacement ? { expectedPlacement } : {}),
            },
            { assertCurrent: assertStartCurrent },
          );
          reportPlacementTransition(onTransition, placement);
          return placement;
        },
      });
      recordWorkerPlacementStage(request.sessionId, "local_barrier_completed", {
        generation: placement.generation,
      });
      if (
        !request.deviceId &&
        request.devicePlacement?.requiredNodeCommands.length &&
        environments.requiresNodeEnrollment?.(
          request.profileId,
          request.inheritedProfile?.providerId,
        )
      ) {
        const allowlist = resolveNodeCommandAllowlist(getRuntimeConfig());
        const deniedCommand = request.devicePlacement.requiredNodeCommands.find(
          (command) => !allowlist.has(command),
        );
        if (deniedCommand) {
          throw new Error(
            `cloud worker node command ${deniedCommand} is not enabled; add it to gateway.nodes.commands.allow and approve the command on the node`,
          );
        }
      }
      await startup.validateDevicePlacement(request);
      signal?.throwIfAborted();
      recordWorkerPlacementStage(request.sessionId, "workspace_resolve_started", {
        generation: placement.generation,
      });
      const workspace = await options.resolveWorkspace(request);
      recordWorkerPlacementStage(request.sessionId, "workspace_resolve_completed", {
        generation: placement.generation,
      });
      if (
        workspace.kind === "repository" &&
        !request.deviceId &&
        environments.requiresNodeEnrollment?.(
          request.profileId,
          request.inheritedProfile?.providerId,
        ) !== true
      ) {
        throw new Error(
          "Repository cloud sessions require a managed-node cloud provider or paired node. Choose one and retry dispatch.",
        );
      }
      const projectPath = workspace.kind === "local" ? workspace.path : undefined;
      // Workspace preparation yields; fence the current paired node again before durable provision.
      await startup.validateDevicePlacement(request);
      recordWorkerPlacementStage(request.sessionId, "intent_prepare_started", {
        generation: placement.generation,
      });
      const preparedIntent = !request.deviceId
        ? await environments.prepareProjectIntent(request.profileId, {
            machineClass: request.machineClass,
            executionMode: request.executionMode,
            projectPath,
            ...(workspace.kind === "repository"
              ? {
                  repository: {
                    agentId: request.agentId,
                    url: workspace.repository.url,
                    ref: workspace.repository.requestedRef ?? undefined,
                    baseCommit: workspace.repository.baseCommit ?? undefined,
                  },
                }
              : {}),
            inherited: request.inheritedProfile,
            signal,
            os: request.os,
            runSetupScript:
              workspace.kind === "repository"
                ? workspace.repository.runSetupScript && request.runSetupScript !== false
                : request.runSetupScript,
            setupAuthorized: request.runSetupScript !== undefined,
            readNativeCredential: request.readNativeCredential,
          })
        : undefined;
      assertCurrent();
      recordWorkerPlacementStage(request.sessionId, "intent_prepare_completed", {
        generation: placement.generation,
        preparationKey: preparedIntent?.preparationKey,
      });
      const prepared =
        selectPrepared && preparedIntent
          ? await startup.bindPreparedPlacement({
              request,
              placement,
              intent: preparedIntent,
              workspace,
              assertCurrent,
            })
          : undefined;
      selectedEnvironment = prepared?.environment;
      assertCurrent();
      let allocationIntent = preparedIntent;
      if (
        process.env.FACTORY_AUTH_MODE === "github" &&
        workspace.kind === "repository" &&
        !request.deviceId &&
        !prepared
      ) {
        if (!preparedIntent) {
          throw new Error("Factory cold startup requires its admitted provider intent");
        }
        await environments.revalidatePreparedIntentRepository(request.profileId, preparedIntent);
        assertCurrent();
        environments.assertPreparedIntentCurrent(request.profileId, preparedIntent);
        // The node owns Factory checkout; cold allocation must not seed a Gateway repository pack.
        allocationIntent = await environments.prepareProjectIntent(request.profileId, {
          machineClass: request.machineClass,
          executionMode: request.executionMode,
          inherited: request.inheritedProfile,
          signal,
          os: request.os,
        });
        assertCurrent();
        environments.assertPreparedIntentCurrent(request.profileId, preparedIntent);
      }
      const idempotencyKey =
        request.idempotencyKey ?? `session-dispatch:${request.sessionId}:${placement.generation}`;
      // Select the reserve before assigning a cold environment identity.
      const expectedEnvironmentId =
        prepared?.environment.environmentId ??
        deriveEnvironmentIntent(idempotencyKey).environmentId;
      placement =
        prepared?.placement ??
        (await placements.transition(
          {
            sessionId: request.sessionId,
            from: "requested",
            to: "provisioning",
            expectedGeneration: placement.generation,
            patch: { environmentId: expectedEnvironmentId },
          },
          assertCurrent,
        ));
      reportPlacementTransition(onTransition, placement);
      assertCurrent();
      const environment = prepared
        ? prepared.environment
        : await environments.createWithRequest({
            profileId: request.profileId,
            idempotencyKey,
            machineClass: request.machineClass,
            executionMode: request.executionMode,
            projectPath,
            signal,
            os: request.os,
            runSetupScript: request.runSetupScript,
            admittedIntent: allocationIntent,
            inheritedProfile: request.inheritedProfile,
          });
      recordWorkerPlacementStage(request.sessionId, "environment_ready", {
        generation: placement.generation,
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
        prepared: prepared !== undefined,
      });
      return await startup.continueProvisionedDispatch({
        request,
        placement,
        environment,
        expectedEnvironmentId,
        workspace,
        intent: preparedIntent,
        onTransition,
        authorize: assertCurrent,
        signal,
        ...(prepared ? { admittedNode: prepared.admittedNode } : {}),
      });
    } catch (error) {
      recordWorkerPlacementStage(request.sessionId, "dispatch_failed", {
        generation: placement?.generation,
        environmentId: placement?.environmentId,
      });
      if (
        error instanceof AcceptedWorkspacePublicationIndeterminateError ||
        error instanceof PreparedEnvironmentBindingIndeterminateError
      ) {
        throw error;
      }
      try {
        if (
          selectPrepared &&
          selectedEnvironment?.preparation &&
          selectedEnvironment.preparation.purpose === "reserve" &&
          selectedEnvironment.preparation.consumedAtMs === null &&
          error instanceof PreparedWorkspaceRegistrationMissingError &&
          error.binding.environmentId === selectedEnvironment.environmentId &&
          error.binding.sessionId === request.sessionId &&
          error.binding.sessionKey === request.sessionKey &&
          error.binding.preparationKey === selectedEnvironment.preparation.key
        ) {
          const current = placements.get(request.sessionId);
          const attached = environments.get(selectedEnvironment.environmentId);
          const assertClaimCurrent = () => {
            assertCurrent();
            const owned = placements.get(request.sessionId);
            if (
              owned?.state !== "syncing" ||
              owned.generation !== error.placementGeneration ||
              owned.environmentId !== selectedEnvironment?.environmentId ||
              owned.sessionKey !== request.sessionKey ||
              owned.agentId !== request.agentId ||
              owned.executionMode !== request.executionMode ||
              owned.turnClaim !== null
            ) {
              throw new Error("Rejected prepared worker lost its exact dispatch owner", {
                cause: error,
              });
            }
          };
          assertClaimCurrent();
          if (
            !current ||
            attached?.state !== "attached" ||
            attached.ownerEpoch !== error.binding.ownerEpoch ||
            attached.destroyRequestedAtMs !== null ||
            attached.leaseId !== selectedEnvironment.leaseId ||
            attached.nodeDeviceId !== selectedEnvironment.nodeDeviceId ||
            attached.attachedSessionIds.length !== 1 ||
            attached.attachedSessionIds[0] !== request.sessionId ||
            attached.preparation?.consumedAtMs === null ||
            attached.preparation?.key !== selectedEnvironment.preparation.key
          ) {
            throw error;
          }
          // Only first-bind rejection attests no session work. Join cleanup before another allocation.
          const failed = await failure.teardownEnvironment({
            placement: current,
            environmentId: attached.environmentId,
            ownerEpoch: attached.ownerEpoch,
            primaryError: error,
            authorize: assertClaimCurrent,
            requireSettledCleanup: true,
          });
          reportPlacementTransition(onTransition, failed);
          assertCurrent();
          const settled = placements.get(request.sessionId);
          if (
            settled?.state !== "failed" ||
            settled.generation !== failed.generation ||
            settled.environmentId !== attached.environmentId ||
            settled.sessionKey !== request.sessionKey ||
            settled.agentId !== request.agentId ||
            environments.get(attached.environmentId)?.state !== "destroyed"
          ) {
            throw error;
          }
          return await dispatchOnce(request, onTransition, authorize, signal, settled);
        }
        if (placement && (await startup.retainInterruptedProvisioning(placement, error))) {
          throw error;
        }
        const current = placement ? placements.get(request.sessionId) : undefined;
        if (current && current.state !== "local" && current.state !== "reclaimed") {
          if (current.state === "active") {
            await failure.failActive(current, error);
          } else {
            const currentEnvironment = current.environmentId
              ? environments.get(current.environmentId)
              : undefined;
            const ownedEnvironment =
              currentEnvironment?.environmentId === current.environmentId
                ? currentEnvironment
                : undefined;
            await failure.teardownEnvironment({
              placement: current,
              environmentId: ownedEnvironment?.environmentId ?? null,
              ownerEpoch: ownedEnvironment?.ownerEpoch ?? null,
              primaryError: error,
            });
          }
        }
      } finally {
        const finalPlacement = placements.get(request.sessionId);
        if (finalPlacement) {
          reportPlacementTransition(onTransition, finalPlacement);
        }
      }
      throw error;
    }
  };

  const dispatch = (
    request: WorkerPlacementDispatchRequest,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
    authorize?: WorkerPlacementAuthorization,
    signal?: AbortSignal,
  ) => dispatchOnce(request, onTransition, authorize, signal);

  const reclaimOnce = createWorkerPlacementReclaim(options);

  const reclaimCurrent = async (
    request: WorkerPlacementReclaimRequest,
    authorize?: WorkerPlacementAuthorization,
    beforeDrain?: WorkerPlacementReclaimSourceCheck,
    initial?: WorkerDispatchPlacement,
    completedOperation?: WorkerPlacementCancellationTarget,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
  ): Promise<WorkerReclaimPlacement> => {
    authorize?.();
    beforeDrain?.();
    const current = placements.get(request.sessionId);
    if (current?.state === "reclaimed") {
      return current;
    }
    // Only a captured operation's successful result makes local an idempotent Stop.
    // Its real cleanup has settled, and the lifecycle and exact tuple still match.
    if (current?.state === "local" && matchesWorkerPlacementTarget(current, completedOperation)) {
      return current;
    }
    try {
      // The preparation/placement wait can span another completed failed cleanup.
      // Its old generation classifies an idempotent result, never authorizes new teardown.
      const owned = current?.state === "local" && initial?.state === "failed" ? initial : current;
      if (owned?.state === "failed" || owned?.state === "provisioning") {
        return await options.runFailedReclaimBarrier({
          ...request,
          authorize,
          reclaim: async (reauthorize) => {
            if (request.recoverToGateway) {
              beforeDrain?.();
            }
            let failedPlacement = placements.get(request.sessionId);
            if (owned.state === "provisioning") {
              failedPlacement = await failure.cancelProvisioning(
                failedPlacement,
                initial,
                reauthorize,
              );
              reportPlacementTransition(onTransition, failedPlacement);
            }
            // A preceding cleanup can finish while this request waits for the lifecycle fence.
            if (
              failedPlacement?.state === "local" &&
              owned.state === "failed" &&
              failedPlacement.generation === owned.generation + 1 &&
              failedPlacement.sessionKey === request.sessionKey &&
              failedPlacement.agentId === request.agentId
            ) {
              return failedPlacement;
            }
            if (failedPlacement?.state !== "failed") {
              throw new Error("Failed cloud worker placement changed during reclaim");
            }
            const cleanupError = await failure.retryFailedTeardown(failedPlacement, reauthorize);
            const failed = placements.get(request.sessionId);
            if (failed?.state !== "failed") {
              throw new Error("Failed cloud worker placement changed during reclaim");
            }
            if (
              !isFailedWorkerPlacementEnvironmentGone({
                environmentService: environments,
                placement: failed,
              })
            ) {
              throw new Error(
                cleanupError ?? "Failed cloud worker environment cleanup is still pending",
              );
            }
            if (request.recoverToGateway) {
              const assertCurrent = () => {
                reauthorize?.();
                beforeDrain?.();
              };
              assertCurrent();
              if (options.prepareGatewayMove) {
                await options.prepareGatewayMove({ ...request, assertCurrent });
              } else if ((await options.resolveWorkspace(request)).kind === "repository") {
                throw new Error("Repository workspace Gateway materialization is unavailable");
              }
              // Keep local admission closed until the accepted checkpoint is bound locally.
              assertCurrent();
            }
            const local = await placements.transition(
              {
                sessionId: request.sessionId,
                from: "failed",
                to: "local",
                expectedGeneration: failed.generation,
              },
              request.recoverToGateway ? reauthorize : undefined,
            );
            if (local.state !== "local") {
              throw new Error("Failed cloud worker reclaim did not produce a local placement");
            }
            reportPlacementTransition(onTransition, local);
            return local;
          },
        });
      }
      return await reclaimOnce(request, undefined, authorize, beforeDrain, onTransition);
    } catch (error) {
      // Another teardown path can win after this call has crossed its durable completion fence.
      // Report the committed terminal state instead of leaking a stale tunnel error to callers.
      const completed = placements.get(request.sessionId);
      if (error instanceof WorkerTunnelOwnerDisconnectedError && completed?.state === "reclaimed") {
        return completed;
      }
      throw error;
    }
  };

  const reclaim = async (
    request: WorkerPlacementReclaimRequest,
    authorize?: WorkerPlacementAuthorization,
    beforeDrain?: WorkerPlacementReclaimSourceCheck,
    serialize: (
      run: () => Promise<WorkerReclaimPlacement>,
    ) => Promise<WorkerReclaimPlacement> = async (run) => await run(),
    pendingOperations?: WorkerPlacementPendingOperations,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
  ): Promise<WorkerReclaimPlacement> => {
    const assertGatewayRecoverySource = () => {
      if (!request.recoverToGateway) {
        return;
      }
      const source = placements.get(request.sessionId);
      if (
        source?.state !== "failed" ||
        source.generation !== request.recoverToGateway.expectedGeneration ||
        source.sessionKey !== request.sessionKey ||
        source.agentId !== request.agentId
      ) {
        throw new Error(`Session ${request.sessionKey} changed before Gateway recovery. Retry.`);
      }
      if (
        !isFailedWorkerPlacementEnvironmentGone({
          environmentService: environments,
          placement: source,
        })
      ) {
        throw new Error(
          "Failed cloud worker environment cleanup is still pending; use Stop cloud worker",
        );
      }
    };
    authorize?.();
    beforeDrain?.();
    assertGatewayRecoverySource();
    const initial = placements.get(request.sessionId);
    if (initial) {
      reportPlacementTransition(onTransition, initial);
    }
    const checkSource = Object.assign(
      () => {
        beforeDrain?.(pendingOperations?.currentPlacement());
        assertGatewayRecoverySource();
      },
      { assertCurrent: beforeDrain?.assertCurrent },
    );
    return await options.runReclaimPreparation({
      ...request,
      authorize,
      beforeDrain: checkSource,
      pendingOperations,
      run: (reauthorize) =>
        serialize(() =>
          reclaimCurrent(
            request,
            reauthorize,
            checkSource,
            initial,
            pendingOperations?.completedPlacement(),
            onTransition,
          ),
        ),
    });
  };

  const abandonment = createWorkerPlacementMoveAbandonment(options);

  const moveService = createWorkerPlacementMoveService({
    placements,
    environments,
    runMoveBarrier: options.runMoveBarrier,
    dispatch,
    reclaimSource: (request, intent, authorize, onTransition) =>
      reclaimOnce(request, intent, authorize, undefined, onTransition),
    validateAbandonSource: abandonment.validateAbandonSource,
    abandonSource: abandonment.abandonSource,
    resolveDestination: options.resolveMoveDestination,
    prepareGatewayMove: options.prepareGatewayMove,
  });

  return {
    dispatch,
    forceDestroyEnvironment: abandonment.forceDestroyEnvironment,
    getEnvironmentAttachedSessionIds: (environmentId: string): readonly string[] =>
      environments.get(environmentId)?.attachedSessionIds ?? [],
    async readEnvironmentSessionIds(environmentId: string): Promise<string[]> {
      const sessionIds = (await placements.readChangeSnapshot()).map(({ sessionId }) => sessionId);
      const facts = await placements.readProjection(sessionIds, { current: true });
      return [
        ...new Set([
          ...(environments.get(environmentId)?.attachedSessionIds ?? []),
          ...[...facts.placements.values()]
            .filter((placement) => placement.environmentId === environmentId)
            .map(({ sessionId }) => sessionId),
          ...[...facts.moves.values()]
            .filter((move) => move.source.environmentId === environmentId)
            .map(({ sessionId }) => sessionId),
        ]),
      ];
    },
    move: moveService.move,
    reclaim,
    reconcile: recovery.reconcile,
    reconcileActive: recovery.reconcileActive,
    resumeProvisioning: startup.resumeProvisioning,
  };
}

export type WorkerPlacementDispatchService = ReturnType<
  typeof createWorkerPlacementDispatchService
>;
