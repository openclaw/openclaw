import { resolveConfiguredGitHubToolIdentity } from "../agents/github-tool-identity.js";
import { installSessionPlacementAdmissionProvider } from "../agents/session-placement-admission.js";
import { getRuntimeConfig } from "../config/config.js";
import { registerSessionMaintenancePreserveKeysProvider } from "../config/sessions/store-maintenance-preserve.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { getGatewayRestartDrainSignal } from "../process/gateway-work-admission.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { createGitHubPublicationRuntime } from "./github-publication-runtime.js";
import type { NodeWorkerSupervisorTransport } from "./node-registry-private.js";
import { emitSessionsChanged } from "./server-methods/session-change-event.js";
import type { WorkerPlacementSessionWorkCancellation } from "./server-worker-placement-cancel.js";
import {
  createGatewayWorkerPlacementChangePublisher,
  subscribeGatewayWorkerMachineShapeChanges,
} from "./server-worker-placement-change-events.js";
import { createGatewayWorkerDispatchAdmission } from "./server-worker-placement-dispatch-admission.js";
import { createGatewayWorkerPlacementLocalDispatchBarrier } from "./server-worker-placement-local-dispatch.js";
import { createGatewayWorkerPlacementMoveBarrier } from "./server-worker-placement-move-barrier.js";
import { createGatewayWorkerPlacementMoveDestinationResolver } from "./server-worker-placement-move-destination.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";
import {
  createWorkerPlacementInitialRecovery,
  installWorkerPlacementReconcileGuard,
} from "./server-worker-placement-reconcile-guard.js";
import { createWorkerRuntimeRefreshWaiter } from "./server-worker-placement-runtime-refresh.js";
import { createWorkerPlacementSessionEvidenceResolver } from "./server-worker-placement-session-evidence.js";
import {
  createWorkerPlacementNodeWorkspaceBindingResolver,
  createWorkerWorkspaceRecoveryPreparer,
  loadWorkerPlacementSessionRuntimeModule,
  prepareWorkerPlacementRepositoryManifestRefs,
  resolveWorkerPlacementSessionTarget,
  runWorkerPlacementSessionBarrier,
  WorkerDispatchTargetChangedError,
} from "./server-worker-placement-session-target.js";
import { recoverGatewayWorkerPlacementWorkspaces } from "./server-worker-placement-workspace-recovery.js";
import { materializeSessionRepositoryWorkspaceOnGateway } from "./session-repository-materialization.js";
import { createDevicePlacementAuthority } from "./worker-environments/device-placement-eligibility.js";
import {
  createNodeWorkspaceRetainCoordinator,
  type NodeWorkerBundleRetention,
} from "./worker-environments/node-workspace-retain-coordinator.js";
import { createWorkerPlacementDiskSpaceMonitor } from "./worker-environments/placement-disk-space.js";
import { coordinateWorkerPlacementDispatch } from "./worker-environments/placement-dispatch-coordinator.js";
import type { WorkerDevicePlacementRequirementResolver } from "./worker-environments/placement-dispatch-startup.js";
import { createWorkerPlacementDispatchService } from "./worker-environments/placement-dispatch.js";
import { createWorkerPlacementIdleSweep } from "./worker-environments/placement-idle-sweep.js";
import { createWorkerPlacementRunnerAvailabilityReader } from "./worker-environments/placement-projector.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";
import { createPlacementSessionRetirement } from "./worker-environments/placement-session-retirement.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { isFailedWorkerPlacementEnvironmentGone } from "./worker-environments/placement-target.js";
import { createRepositoryWorkspaceMutationService } from "./worker-environments/repository-workspace-mutation.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";
import type { WorkerSessionWorkspace } from "./worker-environments/session-workspace.js";
import { createWorkerPlacementRedispatch } from "./worker-environments/worker-placement-redispatch.js";
import { createWorkerSessionTurnPlacementProvider } from "./worker-environments/worker-turn-launcher.js";
import { createWorkerWorkspaceOperationCoordinator } from "./worker-environments/workspace-operation-coordinator.js";

const WORKER_PLACEMENT_RECONCILE_INTERVAL_MS = 60_000;

type WorkerPlacementSidecar = { stop: () => Promise<void> };

export type GatewayWorkerPlacementRuntimeParams = {
  scheduler: GatewayScheduler;
  placements: WorkerSessionPlacementStore;
  getCommittedRuntimeConfig: () => OpenClawConfig;
  environments: WorkerEnvironmentService;
  gatewayNamespace: string;
  nodeWorkerBundleRetention?: NodeWorkerBundleRetention;
  persistAbandonedPartial?: (request: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
    runId: string;
  }) => Promise<void>;
  getSessionChangeContext?: () => Parameters<typeof emitSessionsChanged>[0] | undefined;
  cancelSessionWork: WorkerPlacementSessionWorkCancellation;
  revokeSessionAuthority: (request: { sessionId: string; sessionKeys: readonly string[] }) => void;
  info?: (message: string) => void;
  warn: (message: string) => void;
};

export function createGatewayGitHubPublicationRuntime(params: {
  placements: WorkerSessionPlacementStore;
  getCommittedRuntimeConfig: () => OpenClawConfig;
  warn: (message: string) => void;
}) {
  return createGitHubPublicationRuntime({
    placements: params.placements,
    getCommittedRuntimeConfig: params.getCommittedRuntimeConfig,
    loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
    warn: params.warn,
  });
}

export type GatewayWorkerPlacementRuntime = ReturnType<typeof createGatewayWorkerPlacementRuntime>;

export function createGatewayWorkerPlacementRuntime(
  params: GatewayWorkerPlacementRuntimeParams & {
    githubPublicationRuntime?: ReturnType<typeof createGitHubPublicationRuntime>;
  },
) {
  const { scheduler } = params;
  let nodeWorkerSupervisorTransport: NodeWorkerSupervisorTransport | undefined;
  let stopped = false;
  const runtimeRefresh = createWorkerRuntimeRefreshWaiter({
    environments: params.environments,
    isStopping: () => stopped,
  });
  const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
  const {
    coordinator: githubPublication,
    prepareAcceptedWorkspacePublication,
    publishAcceptedWorkspace,
    reconcilePublications,
  } = params.githubPublicationRuntime ?? createGatewayGitHubPublicationRuntime(params);
  const withPreparedRecovery = createWorkerWorkspaceRecoveryPreparer({
    loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
    getConfig: getRuntimeConfig,
  });
  const nodeWorkspaceRetention = createNodeWorkspaceRetainCoordinator({
    bundleRetention: params.nodeWorkerBundleRetention,
    gatewayNamespace: params.gatewayNamespace,
    placements: params.placements,
    environments: params.environments,
    additionalManifestRefs: prepareWorkerPlacementRepositoryManifestRefs,
    warn: params.warn,
  });
  const runnerAvailability = createWorkerPlacementRunnerAvailabilityReader({
    environments: params.environments,
    hasCurrentDeviceRunner: (deviceId) =>
      nodeWorkerSupervisorTransport?.hasCurrentRunner(deviceId) === true,
  });
  const diskSpace = createWorkerPlacementDiskSpaceMonitor({
    placements: params.placements,
    environments: params.environments,
    runnerAvailability,
    warn: params.warn,
  });
  const reclaimBarriers = createGatewayWorkerPlacementReclaimBarriers({
    placements: params.placements,
    loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
    cancelSessionWork: params.cancelSessionWork,
    revokeSessionAuthority: params.revokeSessionAuthority,
  });
  const runMoveBarrier = createGatewayWorkerPlacementMoveBarrier({
    placements: params.placements,
    awaitTurnClaimRelease: (sessionId, wait) =>
      dispatchService.awaitTurnClaimRelease(sessionId, wait),
    loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
    persistAbandonedPartial: params.persistAbandonedPartial,
    revokeSessionAuthority: params.revokeSessionAuthority,
  });
  const resolveWorkspace = async ({
    sessionId,
    sessionKey,
    agentId,
  }: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
  }): Promise<WorkerSessionWorkspace> => {
    const sessionRuntime = await loadWorkerPlacementSessionRuntimeModule();
    const { workspace, assertCurrent } = await resolveWorkerPlacementSessionTarget({
      sessionRuntime,
      config: getRuntimeConfig(),
      sessionId,
      sessionKey,
      agentId,
      errorMessage: `Session ${sessionKey} dispatch requires a session-owned workspace`,
    });
    assertCurrent(getRuntimeConfig());
    return workspace;
  };
  const resolveDevicePlacementRequirement: WorkerDevicePlacementRequirementResolver = async (
    identity,
  ) => {
    const sessionRuntime = await loadWorkerPlacementSessionRuntimeModule();
    const { config, target, entry, assertCurrent } = await resolveWorkerPlacementSessionTarget({
      sessionRuntime,
      config: getRuntimeConfig(),
      ...identity,
      errorMessage: `Session ${identity.sessionKey} changed before node-backed placement recovery`,
    });
    assertCurrent(getRuntimeConfig());
    const runtime = sessionRuntime.resolveWorkerPlacementSessionRuntime({
      cfg: config,
      entry,
      agentId: target.agentId,
      sessionKey: target.canonicalKey,
    });
    const { executionMode, devicePlacement } =
      sessionRuntime.resolveWorkerPlacementCapabilities(runtime);
    if (executionMode !== identity.executionMode || !devicePlacement) {
      throw new Error(
        `runtime ${runtime} no longer supports this node-backed placement; select a compatible runtime or continue on the Gateway`,
      );
    }
    return devicePlacement;
  };
  const resolveNodeWorkspaceBinding = createWorkerPlacementNodeWorkspaceBindingResolver({
    placements: params.placements,
    resolveWorkspace,
  });
  const publishPlacementChanges = createGatewayWorkerPlacementChangePublisher(params);
  const dispatchService = coordinateWorkerPlacementDispatch(
    createWorkerPlacementDispatchService({
      placements: params.placements,
      environments: params.environments,
      // Must read true before enrollment cancellation in every shutdown path, so an interrupted
      // provisioning is retained rather than terminalized. Runtime reset replaces the drain signal.
      isShuttingDown: () =>
        stopped || params.environments.isStopping() || getGatewayRestartDrainSignal().aborted,
      runnerAvailability,
      resolveDevicePlacementRequirement,
      isCurrentNodePlacement: createDevicePlacementAuthority(() => nodeWorkerSupervisorTransport),
      withPreparedRecovery,
      ...reclaimBarriers,
      runLocalBarrier: createGatewayWorkerPlacementLocalDispatchBarrier({
        placements: params.placements,
        awaitTurnClaimRelease: (sessionId, wait) =>
          dispatchService.awaitTurnClaimRelease(sessionId, wait),
        revokeSessionAuthority: params.revokeSessionAuthority,
      }),
      runActivationBarrier: async ({ authorize, activate, ...identity }) =>
        await runWorkerPlacementSessionBarrier({
          sessionRuntime: await loadWorkerPlacementSessionRuntimeModule(),
          getConfig: getRuntimeConfig,
          ...identity,
          action: "activation",
          run: (_workspace, assertCurrent) => {
            authorize?.();
            return activate(assertCurrent);
          },
        }),
      runRecoveryBarrier: async ({ environmentId, expectedGeneration, run, ...identity }) =>
        await runWorkerPlacementSessionBarrier({
          sessionRuntime: await loadWorkerPlacementSessionRuntimeModule(),
          getConfig: getRuntimeConfig,
          ...identity,
          action: "recovery",
          run: async (workspace, assertCurrent) => {
            const placement = params.placements.get(identity.sessionId);
            if (
              placement?.state !== "provisioning" ||
              placement.generation !== expectedGeneration ||
              placement.environmentId !== environmentId
            ) {
              throw new WorkerDispatchTargetChangedError(
                `Session ${identity.sessionKey} placement changed before cloud worker recovery. Retry.`,
              );
            }
            await run(workspace, assertCurrent);
          },
        }),
      onActivated: ({ sessionId }) => {
        const placement = params.placements.get(sessionId);
        if (placement?.state !== "active") {
          return;
        }
        const environment = params.environments.get(placement.environmentId);
        if (
          environment?.state === "attached" &&
          environment.ownerEpoch === placement.activeOwnerEpoch &&
          environment.attachedSessionIds.length === 1 &&
          environment.attachedSessionIds[0] === sessionId &&
          environment.nodeDeviceId
        ) {
          void nodeWorkspaceRetention.schedule(environment.nodeDeviceId);
        }
      },
      runMoveBarrier,
      resolveMoveDestination: createGatewayWorkerPlacementMoveDestinationResolver({
        environments: params.environments,
        getConfig: getRuntimeConfig,
        loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
      }),
      resolveWorkspace,
      prepareGatewayMove: (identity) =>
        params.placements.withWorkspaceExclusion(
          identity.sessionId,
          async (assertOwned) =>
            await materializeSessionRepositoryWorkspaceOnGateway({
              cfg: getRuntimeConfig(),
              ...identity,
              assertCurrent: () => {
                assertOwned();
                identity.assertCurrent();
              },
            }),
        ),
      workspaceOperations,
      prepareAcceptedWorkspacePublication,
      publishAcceptedWorkspace,
      resolveGitAuthor: (agentId) =>
        (
          resolveConfiguredGitHubToolIdentity({
            config: getRuntimeConfig(),
            agentId,
            scope: "agent",
          }) ??
          resolveConfiguredGitHubToolIdentity({
            config: getRuntimeConfig(),
            agentId,
            scope: "system",
          })
        )?.gitAuthor,
    }),
    createGatewayWorkerDispatchAdmission(loadWorkerPlacementSessionRuntimeModule),
    createWorkerPlacementInitialRecovery({
      ...params,
      isStopping: () =>
        stopped || params.environments.isStopping() || getGatewayRestartDrainSignal().aborted,
    }),
    publishPlacementChanges,
  );
  const placementIdleSweep = createWorkerPlacementIdleSweep({
    placements: params.placements,
    environments: params.environments,
    dispatch: dispatchService,
    getConfig: getRuntimeConfig,
    info: params.info ?? params.warn,
    warn: params.warn,
    isPlacementOperationInFlight: (sessionId) =>
      dispatchService.isPlacementOperationInFlight(sessionId),
    loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
  });
  const sessionRetirement = createPlacementSessionRetirement({
    placements: params.placements,
    environments: params.environments,
    forceDestroyEnvironment: dispatchService.forceDestroyEnvironment,
    createSessionEvidenceResolver: createWorkerPlacementSessionEvidenceResolver,
    warn: params.warn,
  });
  const admissionProvider = createWorkerSessionTurnPlacementProvider({
    environments: params.environments,
    placements: params.placements,
    resolveWorkspace,
    reconcileActivePlacement: async (id) => await dispatchService.reconcileActive(id),
    waitForAdmissionNode: runtimeRefresh.wait,
    waitForInitialPlacement: dispatchService.waitForInitialPlacement,
    redispatchPlacement: createWorkerPlacementRedispatch({
      placements: params.placements,
      dispatch: dispatchService.dispatch,
      resolveDevicePlacementRequirement,
    }),
    workspaceOperations,
    prepareAcceptedWorkspacePublication,
    publishAcceptedWorkspace,
  });
  const startRuntime = async (hooks: {
    isClosePreludeStarted: () => boolean;
    registerSidecar: (sidecar: WorkerPlacementSidecar) => void;
    unregisterSidecar: (sidecar: WorkerPlacementSidecar) => void;
  }): Promise<WorkerPlacementSidecar | null> => {
    if (hooks.isClosePreludeStarted()) {
      return null;
    }
    const uninstallPlacementAdmission = installSessionPlacementAdmissionProvider(admissionProvider);
    const unsubscribeMachineShape = subscribeGatewayWorkerMachineShapeChanges(params);
    const scope = scheduler.scope();
    const operations = new Map<"reconcile" | "disk-space" | "auto-suspend", Promise<void>>();
    const uninstallEnvironmentReconcileGuard = installWorkerPlacementReconcileGuard({
      placements: params.placements,
      environments: params.environments,
      dispatch: dispatchService,
      isStopping: () => stopped,
    });
    // Session evidence must survive until its remote owner has been reclaimed or proven gone.
    const preservationKeys = (placements: readonly WorkerSessionPlacementRecord[]) =>
      placements.flatMap((placement) =>
        placement.state === "failed" &&
        isFailedWorkerPlacementEnvironmentGone({
          environmentService: params.environments,
          placement,
        })
          ? []
          : [placement.sessionKey],
      );
    const uninstallSessionMaintenancePreservation = registerSessionMaintenancePreserveKeysProvider(
      () => preservationKeys(params.placements.listForReconcile()),
      async () => {
        const prepared = await params.placements.prepareMaintenancePlacements();
        return {
          capture() {
            prepared.assertCurrent();
            const keys = preservationKeys(prepared.placements);
            prepared.assertCurrent();
            return keys;
          },
          dispose: prepared.release,
        };
      },
    );
    const trackOperation = (
      key: "reconcile" | "disk-space" | "auto-suspend",
      current: Promise<void>,
      failureMessage: string,
    ): Promise<void> => {
      operations.set(key, current);
      const clearCurrent = () => {
        if (operations.get(key) === current) {
          operations.delete(key);
        }
      };
      void current.then(clearCurrent, (error: unknown) => {
        params.warn(`${failureMessage}: ${formatErrorMessage(error)}`);
        clearCurrent();
      });
      return current;
    };
    const reconcileActivePlacements = (): Promise<void> => {
      if (stopped) {
        return Promise.resolve();
      }
      return (
        operations.get("reconcile") ??
        trackOperation(
          "reconcile",
          (async () => {
            await publishPlacementChanges(() => sessionRetirement.reconcile());
            await dispatchService.reconcileActive();
            await reconcilePublications();
            void nodeWorkspaceRetention.schedule();
          })(),
          "Worker placement reconcile sweep failed",
        )
      );
    };
    const sweepDiskSpace = (): Promise<void> => {
      if (stopped) {
        return Promise.resolve();
      }
      return (
        operations.get("disk-space") ??
        trackOperation("disk-space", diskSpace.sweep(), "Worker disk-space sweep failed")
      );
    };
    const sweepActivePlacements = async (): Promise<void> => {
      try {
        await reconcileActivePlacements();
        if (stopped || operations.has("auto-suspend")) {
          return;
        }
        // Each reclaim reserves its own session after the recovery pass.
        await trackOperation(
          "auto-suspend",
          publishPlacementChanges(() => placementIdleSweep.sweep()),
          "Worker placement auto-suspend sweep failed",
        );
      } catch {
        // Each operation reports its own failure before releasing its slot.
      }
    };
    const uninstallSessionIdentityMutation = onSessionIdentityMutation((mutation) => {
      const previousSessionId = mutation.previous.sessionId;
      const currentSessionId = "current" in mutation ? mutation.current.sessionId : undefined;
      if (previousSessionId && previousSessionId !== currentSessionId) {
        const pending = operations.get("reconcile");
        if (!pending) {
          void reconcileActivePlacements();
          return;
        }
        // The sweep owns reporting and settlement; returning it would create an
        // unobserved rejecting promise for this best-effort event subscriber.
        const resume = () => {
          void reconcileActivePlacements();
        };
        void pending.then(resume, resume);
      }
    });
    let stopPromise: Promise<void> | undefined;
    const sidecar: WorkerPlacementSidecar = {
      stop: () => {
        if (stopPromise) {
          return stopPromise;
        }
        if (!stopped) {
          stopped = true;
          // Cancel enrollment; admitted recovery keeps its own bootstrap owner.
          params.environments.stopNodeEnrollmentWaits?.();
          scope.beginClose();
          uninstallSessionIdentityMutation();
          uninstallSessionMaintenancePreservation();
          uninstallPlacementAdmission();
        }
        const currentStop = (async () => {
          await Promise.allSettled([unsubscribeMachineShape(), ...operations.values()]);
          await nodeWorkspaceRetention.stop();
          await scope.stop();
          await params.environments.stop();
          await uninstallEnvironmentReconcileGuard();
        })();
        stopPromise = currentStop;
        void currentStop.catch(() => {
          if (stopPromise === currentStop) {
            stopPromise = undefined;
          }
        });
        return currentStop;
      },
    };
    // Close must see the drain handle before reconciliation can yield.
    hooks.registerSidecar(sidecar);
    const stopBeforeReady = async () => {
      await sidecar.stop();
      hooks.unregisterSidecar(sidecar);
      return null;
    };
    try {
      // Track startup reconciliation in the placement slot so a concurrent
      // close prelude drains it before uninstalling guards and stopping environments.
      for (const reconcile of [
        () =>
          recoverGatewayWorkerPlacementWorkspaces({
            placements: params.placements,
            resolveWorkspace,
          }),
        async () => {
          await dispatchService.reconcile("startup");
          await reconcilePublications();
        },
      ]) {
        const current = reconcile();
        operations.set("reconcile", current);
        try {
          await current;
        } finally {
          if (operations.get("reconcile") === current) {
            operations.delete("reconcile");
          }
        }
        if (hooks.isClosePreludeStarted()) {
          return await stopBeforeReady();
        }
      }
      void nodeWorkspaceRetention.start();
      if (hooks.isClosePreludeStarted()) {
        return await stopBeforeReady();
      }
      params.environments.start();
      if (hooks.isClosePreludeStarted()) {
        return await stopBeforeReady();
      }
      void trackOperation(
        "reconcile",
        publishPlacementChanges(() => sessionRetirement.reconcile()),
        "Worker placement reconcile sweep failed",
      );
      void sweepDiskSpace();
      const atMs = scope.now() + WORKER_PLACEMENT_RECONCILE_INTERVAL_MS;
      scope.schedule({
        id: "worker-placements:reconcile",
        atMs,
        everyMs: WORKER_PLACEMENT_RECONCILE_INTERVAL_MS,
        run: sweepActivePlacements,
      });
      scope.schedule({
        id: "worker-placements:disk-space",
        atMs,
        everyMs: WORKER_PLACEMENT_RECONCILE_INTERVAL_MS,
        run: () => sweepDiskSpace().catch(() => {}),
      });
      return sidecar;
    } catch (error) {
      try {
        await stopBeforeReady();
      } catch (cleanupError) {
        params.warn(
          `Worker placement cleanup after startup failure failed: ${formatErrorMessage(cleanupError)}`,
        );
      }
      throw error;
    }
  };
  return {
    dispatchService,
    admissionProvider,
    diskSpace,
    runnerAvailability,
    placements: params.placements,
    githubPublication,
    repositoryWorkspaceMutationService: createRepositoryWorkspaceMutationService({
      placements: params.placements,
      environments: params.environments,
      workspaceOperations,
      resolveWorkspace,
    }),
    resolveNodeWorkspaceBinding,
    bindNodeWorkerSupervisorTransport: (transport: NodeWorkerSupervisorTransport) => {
      nodeWorkerSupervisorTransport = transport;
      nodeWorkspaceRetention.bindTransport(transport);
    },
    bindNodeWorkerAvailability: runtimeRefresh.bind,
    scheduleNodeWorkspaceRetention: (nodeId?: string) => nodeWorkspaceRetention.schedule(nodeId),
    startRuntime,
  };
}
