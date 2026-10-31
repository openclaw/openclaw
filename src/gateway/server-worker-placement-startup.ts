import { resolveConfiguredGitHubToolIdentity } from "../agents/github-tool-identity.js";
import type { SessionPlacementAdmissionProvider } from "../agents/session-placement-admission.js";
import { installSessionPlacementAdmissionProvider } from "../agents/session-placement-admission.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  getGatewayRestartDrainSignal,
  isGatewayWorkAdmissionClosed,
} from "../process/gateway-work-admission.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { createGitHubPublicationRuntime } from "./github-publication-runtime.js";
import type { NodeWorkerSupervisorTransport } from "./node-registry-private.js";
import { measureGatewayCloseStep, measureGatewayRestartTrace } from "./restart-trace.js";
import { emitSessionsChanged } from "./server-methods/session-change-event.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";
import type { WorkerPlacementSessionWorkCancellation } from "./server-worker-placement-cancel.js";
import {
  createGatewayWorkerPlacementChangePublisher,
  subscribeGatewayWorkerPlacementMetadataChanges,
} from "./server-worker-placement-change-events.js";
import { createGatewayWorkerDispatchAdmission } from "./server-worker-placement-dispatch-admission.js";
import { createGatewayWorkerPlacementLocalDispatchBarrier } from "./server-worker-placement-local-dispatch.js";
import { prepareWorkerPlacementRepositoryManifestRefs } from "./server-worker-placement-manifest-refs.js";
import { createGatewayWorkerPlacementMoveBarrier } from "./server-worker-placement-move-barrier.js";
import { createGatewayWorkerPlacementMoveDestinationResolver } from "./server-worker-placement-move-destination.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";
import { installWorkerPlacementReconcileGuard } from "./server-worker-placement-reconcile-guard.js";
import { createWorkerRuntimeRefreshWaiter } from "./server-worker-placement-runtime-refresh.js";
import { createWorkerPlacementSessionEvidenceResolver } from "./server-worker-placement-session-evidence.js";
import {
  createWorkerPlacementNodeWorkspaceBindingResolver,
  createWorkerWorkspaceRecoveryPreparer,
  loadWorkerPlacementSessionRuntimeModule,
  resolveWorkerPlacementSessionTarget,
  runWorkerPlacementSessionBarrier,
} from "./server-worker-placement-session-target.js";
import { recoverGatewayWorkerPlacementWorkspaces } from "./server-worker-placement-workspace-recovery.js";
import { createRepositoryGatewayMovePreparation } from "./session-repository-materialization.js";
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
import type {
  WorkerSessionPlacementIdentity,
  WorkerSessionPlacementRecord,
} from "./worker-environments/placement-record.js";
import { createPlacementSessionRetirement } from "./worker-environments/placement-session-retirement.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { createRepositoryWorkspaceMutationService } from "./worker-environments/repository-workspace-mutation.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";
import { createWorkerPlacementRedispatch } from "./worker-environments/worker-placement-redispatch.js";
import type { WorkerTurnPartialIdentity } from "./worker-environments/worker-turn-failure.js";
import { createWorkerSessionTurnPlacementProvider } from "./worker-environments/worker-turn-launcher.js";
import { createWorkerWorkspaceOperationCoordinator } from "./worker-environments/workspace-operation-coordinator.js";

const loadRequiredWorkerPreparation = createLazyRuntimeModule(
  () => import("./server-worker-required-profile.js"),
);

const WORKER_PLACEMENT_RECONCILE_INTERVAL_MS = 60_000;

type WorkerPlacementSidecar = { stop: () => Promise<void> };

export type GatewayWorkerPlacementRuntimeParams = {
  githubPublicationRuntime?: ReturnType<typeof createGitHubPublicationRuntime>;
  scheduler: GatewayScheduler;
  placements: WorkerSessionPlacementStore;
  initialPlacements: readonly WorkerSessionPlacementRecord[];
  getCommittedRuntimeConfig: () => OpenClawConfig;
  environments: WorkerEnvironmentService;
  gatewayNamespace: string;
  nodeWorkerBundleRetention?: NodeWorkerBundleRetention;
  persistAbandonedPartial?: (request: WorkerTurnPartialIdentity) => Promise<void>;
  getSessionChangeContext?: () => Parameters<typeof emitSessionsChanged>[0] | undefined;
  cancelSessionWork: WorkerPlacementSessionWorkCancellation;
  revokeSessionAuthority: (request: { sessionId: string; sessionKeys: readonly string[] }) => void;
  info?: (message: string) => void;
  warn: (message: string) => void;
};

export function createGatewayGitHubPublicationRuntime(params: {
  placements: WorkerSessionPlacementStore;
  environments?: Pick<WorkerEnvironmentService, "get" | "startTunnel">;
  getCommittedRuntimeConfig: () => OpenClawConfig;
  warn: (message: string) => void;
}) {
  return createGitHubPublicationRuntime({
    ...params,
    loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
  });
}

export type GatewayWorkerPlacementRuntime = ReturnType<typeof createGatewayWorkerPlacementRuntime>;

export function createGatewayWorkerPlacementRuntime(params: GatewayWorkerPlacementRuntimeParams) {
  const { scheduler } = params;
  const spawnBroker = getSpawnBroker();
  let nodeWorkerSupervisorTransport: NodeWorkerSupervisorTransport | undefined;
  let stopped = false;
  const isStopping = () =>
    stopped || params.environments.isStopping() || getGatewayRestartDrainSignal().aborted;
  const isReconciliationPaused = () => isStopping() || isGatewayWorkAdmissionClosed();
  let scheduleDiskSpaceSweep: (() => void) | undefined;
  const runtimeRefresh = createWorkerRuntimeRefreshWaiter({
    environments: params.environments,
    isStopping: () => stopped,
  });
  const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
  const {
    ready: githubPublicationReady,
    close: closeGitHubPublication,
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
  let metadata: ReturnType<typeof subscribeGatewayWorkerPlacementMetadataChanges> | undefined;
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
    loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
    persistAbandonedPartial: params.persistAbandonedPartial,
    revokeSessionAuthority: params.revokeSessionAuthority,
  });
  const resolveWorkspace = async (identity: WorkerSessionPlacementIdentity) => {
    const sessionRuntime = await loadWorkerPlacementSessionRuntimeModule();
    using resolved = await resolveWorkerPlacementSessionTarget({
      sessionRuntime,
      config: getRuntimeConfig(),
      ...identity,
      errorMessage: `Session ${identity.sessionKey} dispatch requires a session-owned workspace`,
    });
    resolved.assertCurrent(getRuntimeConfig());
    return resolved.workspace;
  };
  const resolveDevicePlacementRequirement: WorkerDevicePlacementRequirementResolver = async (
    identity,
  ) => {
    const sessionRuntime = await loadWorkerPlacementSessionRuntimeModule();
    using resolved = await resolveWorkerPlacementSessionTarget({
      sessionRuntime,
      config: getRuntimeConfig(),
      ...identity,
      errorMessage: `Session ${identity.sessionKey} changed before node-backed placement recovery`,
    });
    const { config, target, entry, assertCurrent } = resolved;
    assertCurrent(getRuntimeConfig());
    const runtime = await sessionRuntime.resolveWorkerPlacementSessionRuntimeAsync({
      cfg: config,
      entry,
      agentId: target.agentId,
      sessionKey: target.canonicalKey,
      assertCurrent: () => assertCurrent(getRuntimeConfig()),
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
      initialPlacements: params.initialPlacements,
      environments: params.environments,
      // Stop closes provider work before the ordinary dispatch failure path releases its resources.
      isShuttingDown: isStopping,
      runnerAvailability,
      resolveDevicePlacementRequirement,
      isCurrentNodePlacement: createDevicePlacementAuthority(() => nodeWorkerSupervisorTransport),
      withPreparedRecovery,
      ...reclaimBarriers,
      runLocalBarrier: createGatewayWorkerPlacementLocalDispatchBarrier({
        placements: params.placements,
        revokeSessionAuthority: params.revokeSessionAuthority,
      }),
      runActivationBarrier: async ({ authorize, activate, ...identity }) =>
        await runWorkerPlacementSessionBarrier({
          sessionRuntime: await loadWorkerPlacementSessionRuntimeModule(),
          getConfig: getRuntimeConfig,
          ...identity,
          run: (_workspace, assertCurrent) => {
            authorize?.();
            return activate(assertCurrent);
          },
        }),
      onActivated: ({ sessionId }, placement) => {
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
      prepareGatewayMove: createRepositoryGatewayMovePreparation({
        placements: params.placements,
        environments: params.environments,
        getConfig: getRuntimeConfig,
      }),
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
    createGatewayWorkerDispatchAdmission(),
    publishPlacementChanges,
    {
      placements: params.placements,
      environments: params.environments,
      warn: params.warn,
      redispatchPlacement: (...args) => redispatchPlacement(...args),
    },
  );
  const redispatchPlacement = createWorkerPlacementRedispatch({
    placements: params.placements,
    dispatch: dispatchService.dispatch,
    resolveDevicePlacementRequirement,
  });
  const withRequiredSession: SessionPlacementAdmissionProvider["withRequiredSession"] = async (
    ...args
  ) => {
    if (!getRuntimeConfig().cloudWorkers?.requiredProfile) {
      return await args[1](() => {});
    }
    const { createRequiredWorkerSessionPreparation } = await loadRequiredWorkerPreparation();
    return await createRequiredWorkerSessionPreparation({
      getConfig: getRuntimeConfig,
      dispatch: {
        ensurePlacement: (request) =>
          dispatchService.ensurePlacement({
            ...request,
            onTransition: (placement) => {
              const context = params.getSessionChangeContext?.();
              if (context) {
                emitSessionsChanged(context, {
                  reason: "dispatch",
                  sessionKey: placement.sessionKey,
                  agentId: placement.agentId,
                });
              }
            },
          }),
      },
    })(...args);
  };
  const placementIdleSweep = createWorkerPlacementIdleSweep({
    placements: params.placements,
    environments: params.environments,
    dispatch: dispatchService,
    reportChanges: publishPlacementChanges,
    getConfig: getRuntimeConfig,
    info: params.info ?? params.warn,
    warn: params.warn,
    isStopping,
    isPlacementOperationInFlight: (sessionId) =>
      dispatchService.isPlacementOperationInFlight(sessionId),
    loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
  });
  const sessionRetirement = createPlacementSessionRetirement({
    placements: params.placements,
    environments: params.environments,
    forceDestroyEnvironment: dispatchService.forceDestroyEnvironment,
    createSessionEvidenceResolver: createWorkerPlacementSessionEvidenceResolver,
    reportChanges: publishPlacementChanges,
    warn: params.warn,
  });
  const admissionProvider = createWorkerSessionTurnPlacementProvider({
    withRequiredSession,
    environments: params.environments,
    placements: params.placements,
    resolveWorkspace,
    reconcileActivePlacement: async (id) => await dispatchService.reconcileActive(id),
    waitForAdmissionNode: runtimeRefresh.wait,
    waitForInitialPlacement: dispatchService.waitForInitialPlacement,
    redispatchPlacement,
    workspaceOperations,
    prepareAcceptedWorkspacePublication,
    publishAcceptedWorkspace,
    persistAbandonedPartial: params.persistAbandonedPartial,
  });
  const startRuntime = async (hooks: {
    startupTrace?: GatewayStartupTrace;
    isClosePreludeStarted: () => boolean;
    registerSidecar: (sidecar: WorkerPlacementSidecar) => void;
    unregisterSidecar: (sidecar: WorkerPlacementSidecar) => void;
  }): Promise<WorkerPlacementSidecar | null> => {
    if (hooks.isClosePreludeStarted()) {
      return null;
    }
    const uninstallPlacementAdmission = installSessionPlacementAdmissionProvider(admissionProvider);
    const changes = subscribeGatewayWorkerPlacementMetadataChanges({
      ...params,
      runnerAvailability,
    });
    metadata = changes;
    const uninstallPlacementChanges = params.placements.subscribeChanges((placement) => {
      sessionRetirement.markPending(placement.sessionId);
      diskSpace.invalidate();
      scheduleDiskSpaceSweep?.();
    });
    const uninstallOrphanWorkspaceChanges = dispatchService.subscribeOrphanWorkspaceChanges();
    const uninstallConfigChanges = sessionChanges.subscribeFacts((change) => {
      if (
        "all" in change &&
        (typeof change.scope !== "string" ||
          change.scope === "stores" ||
          change.scope === "config" ||
          change.scope === "worker-environments")
      ) {
        diskSpace.invalidate();
        scheduleDiskSpaceSweep?.();
      }
    });
    const scope = scheduler.scope();
    const optionalWorkSignal = AbortSignal.any([scope.signal, getGatewayRestartDrainSignal()]);
    const operations = new Map<"reconcile" | "disk-space" | "auto-suspend", Promise<void>>();
    let reconcileIncludesActive = false;
    let reconciliationPhase: string | undefined;
    const reconcilePhase = (name: string, run: () => Promise<void>) => {
      reconciliationPhase = name;
      const measured = name.startsWith("startup.")
        ? measureStartup(
            hooks.startupTrace,
            `sidecars.worker-environments.${name.slice("startup.".length)}`,
            run,
          )
        : measureGatewayRestartTrace(`worker-placement.${name}`, run);
      return measured.finally(() => {
        reconciliationPhase = undefined;
      });
    };
    const uninstallEnvironmentReconcileGuard = installWorkerPlacementReconcileGuard({
      placements: params.placements,
      environments: params.environments,
      dispatch: dispatchService,
      isStopping: () => stopped,
    });
    const uninstallSessionMaintenancePreservation =
      sessionRetirement.installMaintenancePreservation(params.placements);
    const trackOperation = (
      key: "reconcile" | "disk-space" | "auto-suspend",
      current: Promise<void>,
      failureMessage?: string,
    ): Promise<void> => {
      operations.set(key, current);
      const clearCurrent = () => {
        if (operations.get(key) === current) {
          operations.delete(key);
        }
      };
      void current.then(clearCurrent, (error: unknown) => {
        if (failureMessage) {
          params.warn(`${failureMessage}: ${formatErrorMessage(error)}`);
        }
        clearCurrent();
      });
      return current;
    };
    const reconcileActivePlacements = (includeActive = true): Promise<void> => {
      if (isReconciliationPaused()) {
        return Promise.resolve();
      }
      const pending = operations.get("reconcile");
      if (pending) {
        // A periodic sweep must still recover active owners after an identity-only pass.
        const resume = () => reconcileActivePlacements();
        return includeActive && !reconcileIncludesActive ? pending.then(resume, resume) : pending;
      }
      reconcileIncludesActive = includeActive;
      return trackOperation(
        "reconcile",
        runWithSpawnBroker(spawnBroker, async () => {
          await reconcilePhase("reconcile.session-retirement", () =>
            sessionRetirement.reconcile(optionalWorkSignal),
          );
          if (isReconciliationPaused()) {
            return;
          }
          if (includeActive) {
            await reconcilePhase("reconcile.active", () => dispatchService.reconcileActive());
          }
          if (isReconciliationPaused()) {
            return;
          }
          await reconcilePhase("reconcile.publications", () =>
            reconcilePublications(isReconciliationPaused),
          );
          if (!isReconciliationPaused()) {
            void nodeWorkspaceRetention.schedule();
          }
        }),
        "Worker placement reconcile sweep failed",
      );
    };
    const sweepDiskSpace = (): Promise<void> => {
      if (isStopping()) {
        return Promise.resolve();
      }
      return (
        operations.get("disk-space") ??
        trackOperation(
          "disk-space",
          diskSpace.sweep(optionalWorkSignal).finally(() => scheduleDiskSpaceSweep?.()),
          "Worker disk-space sweep failed",
        )
      );
    };
    scheduleDiskSpaceSweep = () => {
      const atMs = diskSpace.nextSweepAtMs();
      if (!isStopping() && Number.isFinite(atMs)) {
        scope.schedule({
          id: "worker-placements:disk-space",
          atMs,
          mode: "earliest",
          run: () => sweepDiskSpace().catch(() => {}),
        });
      }
    };
    const sweepActivePlacements = async (): Promise<void> => {
      try {
        await reconcileActivePlacements();
        if (isReconciliationPaused() || operations.has("auto-suspend")) {
          return;
        }
        // Each reclaim reserves its own session after the recovery pass.
        await trackOperation(
          "auto-suspend",
          placementIdleSweep.sweep(optionalWorkSignal),
          "Worker placement auto-suspend sweep failed",
        );
      } catch {
        // Each operation reports its own failure before releasing its slot.
      }
    };
    const uninstallSessionIdentityMutation = onSessionIdentityMutation((mutation) =>
      // Reconciliation belongs to the Gateway, not the notifying request's cancellation scope.
      runInDetachedAsyncContext(() => {
        const previousSessionId = mutation.previous.sessionId;
        const currentSessionId = "current" in mutation ? mutation.current.sessionId : undefined;
        if (previousSessionId && previousSessionId !== currentSessionId) {
          sessionRetirement.markPending(previousSessionId);
          const pending = operations.get("reconcile");
          // Retire changed identities without sweeping unrelated active placements.
          // The sweep owns reporting; this best-effort subscriber must not return its promise.
          const resume = () => void reconcileActivePlacements(false);
          void (pending ? pending.then(resume, resume) : reconcileActivePlacements(false));
        }
      }),
    );
    let stopPromise: Promise<void> | undefined;
    const sidecar: WorkerPlacementSidecar = {
      stop: () => {
        if (stopPromise) {
          return stopPromise;
        }
        if (!stopped) {
          stopped = true;
          // Abort provider work before joining reconciliation; keep its actual producers
          // and admitted writes alive until environment teardown drains them.
          params.environments.beginClose();
          scope.beginClose();
          uninstallSessionIdentityMutation();
          uninstallPlacementChanges();
          uninstallConfigChanges();
          uninstallOrphanWorkspaceChanges();
          uninstallSessionMaintenancePreservation();
          uninstallPlacementAdmission();
        }
        const currentStop = (async () => {
          const retentionStopped = measureGatewayCloseStep(
            "shutdown.worker-placement.workspace-retention",
            () => nodeWorkspaceRetention.stop(),
          );
          await Promise.allSettled([
            retentionStopped,
            measureGatewayCloseStep("shutdown.worker-placement.changes", () => changes.stop()),
            measureGatewayCloseStep(
              "shutdown.worker-placement.github-ready",
              () => githubPublicationReady,
            ),
            ...Array.from(operations, ([name, operation]) =>
              measureGatewayCloseStep(
                `shutdown.worker-placement.${name === "reconcile" ? (reconciliationPhase ?? name) : name}`,
                () => operation,
              ),
            ),
          ]);
          await measureGatewayCloseStep(
            "shutdown.worker-placement.github-close",
            closeGitHubPublication,
          );
          await retentionStopped;
          await measureGatewayCloseStep("shutdown.worker-placement.scope", () => scope.stop());
          await measureGatewayCloseStep("shutdown.worker-placement.environments", () =>
            params.environments.stop(),
          );
          await measureGatewayCloseStep(
            "shutdown.worker-placement.reconcile-guard",
            uninstallEnvironmentReconcileGuard,
          );
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
      await measureStartup(
        hooks.startupTrace,
        "sidecars.worker-environments.github-ready",
        () => githubPublicationReady,
      );
      // Track startup reconciliation in the placement slot so a concurrent
      // close prelude drains it before uninstalling guards and stopping environments.
      for (const reconcile of [
        () =>
          reconcilePhase("startup.workspaces", () =>
            recoverGatewayWorkerPlacementWorkspaces({
              placements: params.placements,
              resolveWorkspace,
              isStopping,
            }),
          ),
        () => reconcilePhase("startup.active", () => dispatchService.reconcile("startup")),
      ]) {
        await trackOperation("reconcile", reconcile());
        if (isStopping() || hooks.isClosePreludeStarted()) {
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
        reconcilePhase("reconcile.session-retirement", () =>
          sessionRetirement.reconcile(optionalWorkSignal),
        ).then(() =>
          // Git/network recovery must drain on close, but cannot hold Gateway readiness.
          reconcilePhase("startup.publications", () =>
            reconcilePublications(isReconciliationPaused),
          ),
        ),
        "Worker placement reconcile sweep failed",
      );
      void sweepDiskSpace();
      scope.schedule({
        id: "worker-placements:reconcile",
        atMs: scope.now() + WORKER_PLACEMENT_RECONCILE_INTERVAL_MS,
        everyMs: WORKER_PLACEMENT_RECONCILE_INTERVAL_MS,
        run: sweepActivePlacements,
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
    dispatchService: Object.assign(dispatchService, { withRequiredSession }),
    admissionProvider,
    diskSpace,
    runnerAvailability: {
      ...runnerAvailability,
      markChanged(nodeId: string) {
        runnerAvailability.markChanged();
        metadata?.runnerChanged(nodeId);
        scheduleDiskSpaceSweep?.();
      },
    },
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
