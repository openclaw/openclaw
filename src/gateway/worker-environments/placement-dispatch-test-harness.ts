import { vi } from "vitest";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import type { MintedWorkerCredential } from "./credential.js";
import type {
  WorkerDispatchEnvironmentService,
  WorkerDispatchPlacementStore,
} from "./placement-dispatch-failure.js";
import {
  BUNDLE_HASH,
  createDispatchEnvironmentFixtures,
  type DispatchStage,
  MANIFEST_REF,
  type PlacementStore,
  REQUEST,
  seedActivePlacement,
  seedProvisioningPlacement,
  seedStartingPlacement,
} from "./placement-dispatch-test-fixtures.js";
import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { createWorkerPlacementRunnerAvailabilityReader } from "./placement-projector.js";
import { completeWorkerWorkspaceTeardown } from "./placement-teardown.js";
import {
  createPlacementTurnClaimFixtureOps,
  seedAttachedPlacementEnvironment,
  writePlacementEnvironmentFixture,
} from "./placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerEnvironmentService } from "./service.js";
import {
  WorkerTunnelOwnerDisconnectedError,
  type WorkerTurnTunnelHandle,
  type WorkerWorkspaceReconcileRequest,
} from "./tunnel-contract.js";
import { readLaunchToolNames } from "./worker-turn-launcher.test-support.js";
import {
  projectWorkspaceResultConflict,
  type WorkspaceResultConflictLookup,
} from "./workspace-conflicts.js";
import {
  createWorkerWorkspaceOperationCoordinator,
  type WorkerWorkspaceOperationCoordinator,
} from "./workspace-operation-coordinator.js";
import {
  createWorkerWorkspaceRecoveryFixture,
  runReclaimPreparation,
  type WorkerWorkspaceRecoveryFailureReport,
} from "./workspace-recovery.test-support.js";

type DispatchOptions = Parameters<typeof createWorkerPlacementDispatchService>[0];

export function createHarness(
  database: OpenClawStateDatabase,
  placementStore: PlacementStore,
  options: {
    environmentService?: WorkerEnvironmentService;
    runReclaimPreparation?: DispatchOptions["runReclaimPreparation"];
    runReclaimBarrier?: DispatchOptions["runReclaimBarrier"];
    runFailedReclaimBarrier?: DispatchOptions["runFailedReclaimBarrier"];
    prepareGatewayMove?: DispatchOptions["prepareGatewayMove"];
    failAt?: DispatchStage;
    destroyFails?: boolean;
    destroyFailureCount?: number;
    claimOnDrain?: boolean;
    reconcileFails?: boolean;
    reconcileFailureCount?: number;
    reconcileChanged?: boolean;
    reconcileCommitsManifest?: boolean;
    reconcileCommitsManifestOnApply?: boolean;
    verifyFailurePhase?: "before-apply" | "after-apply";
    leaseFails?: boolean;
    leaseFailureCount?: number;
    leaseFailureCall?: number;
    localVerifyFails?: boolean;
    resumeFails?: boolean;
    workspacePath?: string;
    resolveWorkspace?: DispatchOptions["resolveWorkspace"];
    withPreparedRecovery?: DispatchOptions["withPreparedRecovery"];
    prepareRetainedRecoveryCheckpoint?: DispatchOptions["prepareRetainedRecoveryCheckpoint"];
    prepareFailedDisposalCheckpoint?: DispatchOptions["prepareFailedDisposalCheckpoint"];
    prepareRepositoryRefRecovery?: DispatchOptions["prepareRepositoryRefRecovery"];
    requiresNodeEnrollment?: boolean;
    priorWorkspaceResultConflict?: { paths: string[]; stagedResultRef: string };
    priorWorkspaceResultConflictLookup?: WorkspaceResultConflictLookup;
    reconcileConflictPaths?: string[];
    workspaceOperations?: WorkerWorkspaceOperationCoordinator;
    destroyFailureState?: "draining" | "destroying";
    terminalizeReclaimOnTunnelDrop?: boolean;
    terminalizedReclaimError?: Error;
    environmentGeneration?: number;
    failMoveAfterBegin?: boolean;
    runMoveBarrier?: DispatchOptions["runMoveBarrier"];
    recoveryBarrierError?: Error;
    isShuttingDown?: () => boolean;
    prepareAcceptedWorkspacePublication?: DispatchOptions["prepareAcceptedWorkspacePublication"];
    publishAcceptedWorkspace?: DispatchOptions["publishAcceptedWorkspace"];
    beforeMoveBegin?: (abandoned: { runId: string } | undefined) => Promise<void>;
    afterMoveBegin?: () => Promise<void> | void;
    afterDestroy?: () => Promise<void> | void;
    afterReconcile?: () => Promise<void> | void;
    afterStopTunnel?: () => Promise<void> | void;
    deviceRunnerAvailable?: boolean;
    isCurrentNodePlacement?: DispatchOptions["isCurrentNodePlacement"];
  } = {},
) {
  const reconciledManifestRef = MANIFEST_REF.replaceAll("b", "c");
  let remainingDestroyFailures = options.destroyFailureCount ?? 0;
  let remainingReconcileFailures = options.reconcileFailureCount ?? 0;
  let remainingLeaseFailures = options.leaseFailureCount ?? 0;
  let leaseCalls = 0;
  let pendingVerifyFailurePhase = options.verifyFailurePhase;
  const log: string[] = [];
  const reportWorkspaceResultConflict = vi.fn(async () => {});
  const reportWorkspaceResultRecoveryFailure = vi.fn(
    async (_recovery: WorkerWorkspaceRecoveryFailureReport) => {},
  );
  const fail = (stage: DispatchStage) => {
    log.push(stage);
    if (options.failAt === stage) {
      const error = new Error(`${stage} failed`);
      if (stage === "preflight") {
        Object.assign(error, { code: "invalid_state" });
      }
      throw error;
    }
  };
  const placements: WorkerDispatchPlacementStore = {
    ...placementStore,
    bindPreparedEnvironment: (...args) => placementStore.bindPreparedEnvironment(...args),
    closeWorkerTurnToolState: (claim) => placementStore.closeWorkerTurnToolState(claim),
    beginPlacementMove: (params) => {
      const begun = placementStore.beginPlacementMove(params);
      if (!begun.joined) {
        log.push("placement:draining");
      }
      return begun;
    },
    completePlacementMoveSourceToLocal: (params) => {
      log.push("placement:local");
      return placementStore.completePlacementMoveSourceToLocal(params);
    },
    completeAbandonedPlacementMoveSourceToLocal: (params) => {
      log.push("placement:local");
      return placementStore.completeAbandonedPlacementMoveSourceToLocal(params);
    },
    acceptWorkspaceResult: (...args) => placementStore.acceptWorkspaceResult(...args),
    completeWorkspaceResultAndReleaseTurn: (...args) =>
      placementStore.completeWorkspaceResultAndReleaseTurn(...args),
    failWorkspaceResultAndReleaseTurn: (pending, error, assertCurrent) => {
      const current = placementStore.get(pending.sessionId);
      if (current?.state === "active") {
        log.push("placement:draining");
      }
      log.push("placement:reconciling", "placement:failed");
      return placementStore.failWorkspaceResultAndReleaseTurn(pending, error, assertCurrent);
    },
    startDispatch: (params, dispatchOptions) => {
      log.push("placement:requested");
      return placementStore.startDispatch(params, dispatchOptions);
    },
    transition: (params, assertCurrent) => {
      log.push(`placement:${params.to}`);
      return placementStore.transition(params, assertCurrent);
    },
    fail: (params, assertCurrent) => {
      log.push("placement:failed");
      return placementStore.fail(params, assertCurrent);
    },
    startDrain: (params, assertCurrent) => {
      log.push("placement:draining");
      if (options.claimOnDrain && !placementStore.get(params.sessionId)?.turnClaim) {
        createPlacementTurnClaimFixtureOps(database).claimTurn({
          sessionId: params.sessionId,
          sessionKey: REQUEST.sessionKey,
          agentId: REQUEST.agentId,
          claimId: "claim-on-drain",
          runId: "run-on-drain",
          owner: {
            kind: "worker",
            environmentId: params.environmentId,
            ownerEpoch: params.ownerEpoch,
          },
        });
      }
      return placementStore.startDrain(params, assertCurrent);
    },
    startWorkspaceResultDrain: (...args) => {
      log.push("placement:draining");
      return placementStore.startWorkspaceResultDrain(...args);
    },
    startReconcile: (params, assertCurrent) => {
      log.push("placement:reconciling");
      return placementStore.startReconcile(params, assertCurrent);
    },
    adoptActive: (params) => {
      log.push("placement:adopted");
      return placementStore.adoptActive(params);
    },
  };
  const { attached, destroyedEnvironment, environmentId, ready } =
    createDispatchEnvironmentFixtures(options.environmentGeneration);
  let currentEnvironment: ReturnType<WorkerDispatchEnvironmentService["get"]> = ready;
  const setEnvironment = (environment: NonNullable<typeof currentEnvironment>) => {
    currentEnvironment = environment;
    writePlacementEnvironmentFixture(database, environment);
  };
  const seedActive = (ownerEpoch: number, executionMode?: "worker-turn" | "remote-exec") => {
    seedAttachedPlacementEnvironment(database, {
      environmentId,
      sessionId: REQUEST.sessionId,
      ownerEpoch,
    });
    return seedActivePlacement(placementStore, { environmentId, ownerEpoch, executionMode });
  };
  const tunnelHandle = (ownerEpoch: number): WorkerTurnTunnelHandle => ({
    environmentId: ready.environmentId,
    ownerEpoch,
    measureLaunchTurn: vi.fn(),
    readLaunchToolNames,
    launchTurn: vi.fn(),
    quiesceWorkspace: vi.fn(async () => {
      log.push("workspace:quiesce");
      return {
        assertActive: vi.fn(async () => {
          log.push("workspace:lease");
          leaseCalls += 1;
          if (
            options.leaseFails ||
            remainingLeaseFailures > 0 ||
            leaseCalls === options.leaseFailureCall
          ) {
            remainingLeaseFailures -= 1;
            throw new Error("workspace quiescence expired");
          }
        }),
        resume: vi.fn(async () => {
          log.push("workspace:resume");
          if (options.resumeFails) {
            throw new Error("workspace resume failed");
          }
        }),
      };
    }),
    reconcileWorkspace: vi.fn(async (request: WorkerWorkspaceReconcileRequest) => {
      if (request.source.kind !== "local") {
        throw new Error("Local dispatch fixture received a repository workspace");
      }
      const { journal, stagedResult } = request.source;
      log.push("workspace:reconcile");
      if (options.reconcileFails || remainingReconcileFailures > 0) {
        remainingReconcileFailures -= 1;
        throw new Error("workspace conflict");
      }
      if (options.reconcileCommitsManifest !== false) {
        await journal.commit(reconciledManifestRef);
      }
      if (options.terminalizeReclaimOnTunnelDrop) {
        const owned = placementStore.get(REQUEST.sessionId);
        const persistedClaim = owned?.turnClaim;
        if (owned?.state !== "draining" || persistedClaim?.owner !== "worker") {
          throw new Error("tunnel-drop fixture lost its draining worker claim");
        }
        const claim = {
          sessionId: owned.sessionId,
          claimId: persistedClaim.claimId,
          runId: persistedClaim.runId,
          placementGeneration: persistedClaim.generation,
          owner: {
            kind: "worker" as const,
            environmentId: owned.environmentId,
            ownerEpoch: persistedClaim.ownerEpoch,
          },
        };
        await placementStore.acceptWorkspaceResult(claim);
        setEnvironment(destroyedEnvironment(currentEnvironment?.ownerEpoch ?? 1));
        log.push("teardown:destroy");
        await completeWorkerWorkspaceTeardown({
          placements: placementStore,
          turnClaim: claim,
          environmentId: owned.environmentId,
          ownerEpoch: owned.activeOwnerEpoch,
        });
        throw options.terminalizedReclaimError ?? new WorkerTunnelOwnerDisconnectedError();
      }
      if (options.reconcileConflictPaths?.length && stagedResult) {
        await stagedResult.record(stagedResult.ref);
      }
      await options.afterReconcile?.();
      let applied = false;
      const verifyLocalStable = async () => {
        log.push("workspace:verify-local");
        if (options.localVerifyFails) {
          throw new Error("local workspace changed after reconciliation");
        }
      };
      return {
        manifestRef: reconciledManifestRef,
        changed: options.reconcileChanged ?? true,
        publishStagedResult: async () => {},
        discardPreparedStagedResult: async () => {},
        verifyStable: async () => {
          log.push("workspace:verify");
          if (pendingVerifyFailurePhase === (applied ? "after-apply" : "before-apply")) {
            pendingVerifyFailurePhase = undefined;
            throw new Error("workspace changed after reconciliation");
          }
        },
        verifyLocalStable,
        acceptUnchangedStagedResult:
          options.reconcileChanged === false && !options.reconcileConflictPaths?.length
            ? verifyLocalStable
            : undefined,
        getAppliedWorkspaceResult: options.reconcileConflictPaths?.length
          ? () => ({
              manifestRef: reconciledManifestRef,
              manifest: { version: 1 as const, baseCommit: null, entries: [] },
              conflictPaths: options.reconcileConflictPaths!,
              verifyLocalStable: async () => {},
            })
          : undefined,
        ...(options.reconcileCommitsManifestOnApply
          ? {
              applyPreparedStagedResult: async () => {
                log.push("workspace:apply-prepared");
                await journal.commit(reconciledManifestRef);
                applied = true;
              },
            }
          : {}),
      };
    }),
    runWorkspaceCommand: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
    })),
    syncWorkspace: vi.fn(async () => {
      fail("sync");
      return {
        mode: "git" as const,
        remoteWorkspaceDir: "/worker/workspace",
        manifestRef: MANIFEST_REF,
      };
    }),
    stop: vi.fn(async () => {}),
  });
  const minted: MintedWorkerCredential = {
    credential: "fixture-credential",
    deliveryId: "fixture-delivery-id",
    environmentId: ready.environmentId,
    bundleHash: BUNDLE_HASH,
    sessionId: REQUEST.sessionId,
    rpcSetVersion: 1,
    ownerEpoch: 2,
    expiresAtMs: 10_000,
  };
  const environments: WorkerDispatchEnvironmentService &
    Pick<
      WorkerEnvironmentService,
      "recordError" | "requestDestroy" | "requiresNodeEnrollment" | "readMachineShape"
    > = {
    fenceWorkerTurnForRecovery:
      createWorkerSessionPlacementGate(placementStore).fenceWorkerTurnForRecovery,
    requiresNodeEnrollment: vi.fn(() => options.requiresNodeEnrollment === true),
    readMachineShape: () => undefined,
    recordError: vi.fn((record) => record),
    supportsProviderExecutionMode: vi.fn(() => true),
    assertPreparedIntentCurrent: vi.fn(),
    revalidatePreparedIntentRepository: vi.fn(async () => {}),
    prepareProjectIntent: vi.fn(async (_profileId, request) => ({
      providerId: request?.inherited?.providerId ?? ready.providerId,
      profileSnapshot: request?.inherited?.profileSnapshot ?? ready.profileSnapshot,
    })),
    getPreparedCandidates: vi.fn(() => []),
    bindPreparedWorkspace: vi.fn(async (request) => ({
      gatewayNamespace: "dispatch-fixture",
      environmentId: request.environmentId,
      preparationKey: request.preparationKey,
      cacheKey: request.cacheKey,
      workspaceDir: "/worker/workspace",
      homeDir: "/worker/home",
      sourceManifestRef: MANIFEST_REF,
      preparedManifestRef: MANIFEST_REF,
    })),
    schedulePreparedRefill: vi.fn(),
    createWithRequest: vi.fn<WorkerDispatchEnvironmentService["createWithRequest"]>(
      async ({ inheritedProfile }) => {
        fail("create");
        return inheritedProfile ? ready : (currentEnvironment ?? ready);
      },
    ),
    get: vi.fn(() => currentEnvironment),
    attachSession: vi.fn(async ({ environmentId: attachedEnvironmentId }) => {
      fail("attach");
      const persisted = environments.get(attachedEnvironmentId);
      const attachment = persisted?.state === "attached" ? persisted : attached;
      setEnvironment(attachment);
      return { ...minted, ownerEpoch: attachment.ownerEpoch };
    }),
    startTunnel: vi.fn(async ({ ownerEpoch }) => {
      fail("tunnel:attached");
      if (ownerEpoch !== currentEnvironment?.ownerEpoch) {
        throw new Error("tunnel fixture received a stale owner epoch");
      }
      return tunnelHandle(ownerEpoch);
    }),
    stopTunnel: vi.fn(async () => {
      log.push("teardown:stop");
      await options.afterStopTunnel?.();
    }),
    destroy: vi.fn<WorkerDispatchEnvironmentService["destroy"]>(
      async (_environmentId, _abandonment, forceAbandon) => {
        await forceAbandon?.();
        log.push("teardown:destroy");
        if (options.destroyFails || remainingDestroyFailures > 0) {
          remainingDestroyFailures = Math.max(0, remainingDestroyFailures - 1);
          if (options.destroyFailureState) {
            setEnvironment({
              ...attached,
              state: options.destroyFailureState,
              attachedSessionIds: [],
              tunnelStatus: "stopped",
            });
          }
          throw new Error("destroy pending");
        }
        const destroyed = destroyedEnvironment((currentEnvironment?.ownerEpoch ?? 1) + 1);
        setEnvironment(destroyed);
        await options.afterDestroy?.();
        return destroyed;
      },
    ),
    requestDestroy: (requestedEnvironmentId) => environments.destroy(requestedEnvironmentId),
    reconcileOnce: vi.fn(async () => {
      log.push("environment:reconcile");
    }),
    reconcileEnvironment: vi.fn(async () => {
      log.push("environment:reconcile");
    }),
  };
  if (options.environmentService) {
    Object.assign(environments, options.environmentService);
  }
  const service = createWorkerPlacementDispatchService({
    placements,
    environments,
    isShuttingDown: options.isShuttingDown,
    prepareGatewayMove: options.prepareGatewayMove,
    prepareRepositoryRefRecovery: options.prepareRepositoryRefRecovery,
    runReclaimPreparation: options.runReclaimPreparation ?? runReclaimPreparation,
    runnerAvailability: createWorkerPlacementRunnerAvailabilityReader({
      environments,
      hasCurrentDeviceRunner: () => options.deviceRunnerAvailable === true,
    }),
    workspaceOperations: options.workspaceOperations ?? createWorkerWorkspaceOperationCoordinator(),
    runLocalBarrier: async ({ authorize, startDispatch }) => {
      log.push("barrier");
      if (options.failAt === "preflight") {
        fail("preflight");
      }
      authorize?.();
      const placement = await startDispatch();
      if (options.failAt === "barrier") {
        throw new Error("barrier failed");
      }
      return placement;
    },
    runRecoveryBarrier: async ({ run }) => {
      log.push("recovery-barrier");
      if (options.recoveryBarrierError) {
        throw options.recoveryBarrierError;
      }
      await run({ kind: "local", path: options.workspacePath ?? "/gateway/workspace" });
    },
    runActivationBarrier: async ({ authorize, activate }) => {
      authorize?.();
      fail("activation");
      return activate();
    },
    runMoveBarrier:
      options.runMoveBarrier ??
      (async ({ authorize, begin }) => {
        authorize?.();
        const begun = await begin(async (runId) => {
          if (options.beforeMoveBegin) {
            await options.beforeMoveBegin({ runId });
            authorize?.();
          }
        });
        await options.afterMoveBegin?.();
        if (options.failMoveAfterBegin) {
          throw new Error("move barrier interrupted");
        }
        return begun;
      }),
    resolveMoveDestination: async (_identity, target) =>
      target.kind === "gateway"
        ? undefined
        : {
            profileId: target.kind === "profile" ? target.profileId : `device:${target.deviceId}`,
            executionMode: REQUEST.executionMode,
            ...(target.kind === "device"
              ? {
                  deviceId: target.deviceId,
                  devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
                }
              : {}),
          },
    resolveDevicePlacementRequirement: async ({ executionMode }) =>
      executionMode === "remote-exec"
        ? {
            requiredNodeCommands: ["codex.exec-server.stdio.v1"],
            consumesWorkerSlot: false,
          }
        : { requiredNodeCommands: [], consumesWorkerSlot: true },
    isCurrentNodePlacement: options.isCurrentNodePlacement ?? (() => true),
    runReclaimBarrier:
      options.runReclaimBarrier ??
      (async ({ sessionId, sessionKey, authorize, beforeDrain, begin, reclaim }) =>
        await runExclusiveSessionLifecycleMutation("placement-reclaim", {
          scope: options.workspacePath ?? "/gateway/workspace",
          identities: [sessionId, sessionKey],
          run: async () => {
            authorize?.();
            beforeDrain?.();
            const placement = await begin(authorize);
            return placement.state === "reclaimed"
              ? placement
              : await reclaim(
                  { kind: "local", path: options.workspacePath ?? "/gateway/workspace" },
                  placement,
                  authorize,
                );
          },
        })),
    runFailedReclaimBarrier:
      options.runFailedReclaimBarrier ??
      (async ({ sessionId, sessionKey, authorize, reclaim }) =>
        await runExclusiveSessionLifecycleMutation("placement-failed-reclaim", {
          scope: options.workspacePath ?? "/gateway/workspace",
          identities: [sessionId, sessionKey],
          run: async () => {
            authorize?.();
            return await reclaim(authorize);
          },
        })),
    ...createWorkerWorkspaceRecoveryFixture({
      resolveWorkspace:
        options.resolveWorkspace ??
        (async () => {
          fail("workspace");
          return { kind: "local", path: options.workspacePath ?? "/gateway/workspace" };
        }),
      reportConflict: reportWorkspaceResultConflict,
      reportFailure: reportWorkspaceResultRecoveryFailure,
      resolveConflict: vi.fn(async (): Promise<WorkspaceResultConflictLookup> => {
        const conflict = options.priorWorkspaceResultConflict;
        return (
          options.priorWorkspaceResultConflictLookup ??
          (conflict
            ? {
                kind: "conflict",
                conflict: projectWorkspaceResultConflict(conflict.paths, conflict.stagedResultRef),
              }
            : { kind: "absent" })
        );
      }),
    }),
    ...(options.withPreparedRecovery ? { withPreparedRecovery: options.withPreparedRecovery } : {}),
    prepareRetainedRecoveryCheckpoint: options.prepareRetainedRecoveryCheckpoint,
    prepareFailedDisposalCheckpoint: options.prepareFailedDisposalCheckpoint,
    ...(options.prepareAcceptedWorkspacePublication
      ? { prepareAcceptedWorkspacePublication: options.prepareAcceptedWorkspacePublication }
      : {}),
    ...(options.publishAcceptedWorkspace
      ? { publishAcceptedWorkspace: options.publishAcceptedWorkspace }
      : {}),
  });
  return {
    log,
    tunnelHandle,
    reconciledManifestRef,
    placements: {
      current: () => placementStore.get(REQUEST.sessionId),
      seedProvisioning: (executionMode?: "worker-turn" | "remote-exec") =>
        seedProvisioningPlacement(placementStore, environmentId, executionMode),
      seedStarting: () => seedStartingPlacement(placementStore, environmentId),
      seedActive,
      seedDraining: async (ownerEpoch: number) => {
        const active = await seedActive(ownerEpoch);
        if (active.state !== "active") {
          throw new Error("active placement fixture was not active");
        }
        return placementStore.startDrain({
          sessionId: active.sessionId,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
          expectedGeneration: active.generation,
        });
      },
    },
    environments,
    reportWorkspaceResultConflict,
    reportWorkspaceResultRecoveryFailure,
    markEnvironmentDestroyed: () => {
      setEnvironment(destroyedEnvironment((currentEnvironment?.ownerEpoch ?? 1) + 1));
    },
    markEnvironmentFailed: () => {
      setEnvironment({
        ...destroyedEnvironment(currentEnvironment?.ownerEpoch ?? 1),
        state: "failed",
        leaseId: null,
        sshEndpoint: null,
        sharedHost: null,
        lastError: "Worker environment disappeared before teardown was requested",
        error: "Worker environment disappeared before teardown was requested",
      });
    },
    markEnvironmentOwnerEpoch: (ownerEpoch: number) => {
      currentEnvironment = { ...attached, ownerEpoch };
      seedAttachedPlacementEnvironment(database, {
        environmentId,
        sessionId: REQUEST.sessionId,
        ownerEpoch,
      });
    },
    markEnvironmentNodeDeviceId: (nodeDeviceId: string) => {
      setEnvironment({ ...attached, providerId: "device", nodeDeviceId, sshEndpoint: null });
    },
    markEnvironmentAttachments: (attachedSessionIds: string[]) =>
      setEnvironment({ ...attached, attachedSessionIds }),
    markEnvironmentProtocolFeatures: (protocolFeatures: string[]) => {
      if (!currentEnvironment?.bootstrapReceipt) {
        throw new Error("worker environment fixture has no bootstrap receipt");
      }
      setEnvironment({
        ...currentEnvironment,
        bootstrapReceipt: { ...currentEnvironment.bootstrapReceipt, protocolFeatures },
      });
    },
    service,
    ready,
    attached,
  };
}

export const createRecoveryService = (
  placements: PlacementStore,
  environments: WorkerEnvironmentService,
  isShuttingDown: () => boolean = () => false,
) =>
  createWorkerPlacementDispatchService({
    placements,
    environments,
    isShuttingDown,
    runnerAvailability: { read: () => undefined, version: () => 0 },
    workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
    runLocalBarrier: async ({ startDispatch }) => startDispatch(),
    runRecoveryBarrier: async ({ run }) => await run({ kind: "local", path: "/gateway/workspace" }),
    runActivationBarrier: async ({ activate }) => activate(),
    runMoveBarrier: async ({ begin }) => begin(),
    resolveMoveDestination: async () => undefined,
    runReclaimPreparation,
    runReclaimBarrier: async ({ begin, reclaim }) =>
      await reclaim({ kind: "local", path: "/gateway/workspace" }, await begin()),
    runFailedReclaimBarrier: async ({ reclaim }) => await reclaim(),
    ...createWorkerWorkspaceRecoveryFixture({
      resolveWorkspace: async () => ({ kind: "local", path: "/gateway/workspace" }),
    }),
  });
