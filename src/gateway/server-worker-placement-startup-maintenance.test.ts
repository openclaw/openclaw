import { describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  loadSessionEntry,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { observeSessionMaintenanceChanges } from "../config/sessions/session-accessor.sqlite-maintenance.test-support.js";
import { applySessionEntryLifecycleMutation } from "../config/sessions/session-accessor.sqlite-projection.js";
import * as reclamationRun from "../config/sessions/session-accessor.sqlite-reclamation-run.js";
import { prepareSessionMaintenancePreservation } from "../config/sessions/store-maintenance-preserve.js";
import { resolveMaintenanceConfigFromInput } from "../config/sessions/store-maintenance.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as workspaceRetention from "./worker-environments/node-workspace-retain-coordinator.js";
import {
  placementTurnOwner,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
} from "./worker-environments/placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./worker-environments/placement-store.js";
import { advancePlacementFixtureToActive } from "./worker-environments/placement-test-fixtures.js";

const runtimeFactoryMocks = vi.hoisted(() => ({
  createDispatch: vi.fn(),
  createDiskSpace: vi.fn(),
  createSessionEvidenceResolver: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: vi.fn(() => ({})),
}));

vi.mock("./worker-environments/placement-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-environments/placement-dispatch.js")>()),
  createWorkerPlacementDispatchService: runtimeFactoryMocks.createDispatch,
}));

vi.mock("./server-worker-placement-session-evidence.js", () => ({
  createWorkerPlacementSessionEvidenceResolver: runtimeFactoryMocks.createSessionEvidenceResolver,
}));

vi.mock("./worker-environments/placement-disk-space.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-environments/placement-disk-space.js")>()),
  createWorkerPlacementDiskSpaceMonitor: runtimeFactoryMocks.createDiskSpace,
}));

import { getRuntimeConfig } from "../config/config.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";

type PlacementFixture = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  state: WorkerSessionPlacementRecord["state"];
  generation: number;
  environmentId: string | null;
  activeOwnerEpoch: number | null;
  turnClaim: WorkerSessionPlacementRecord["turnClaim"];
};

function createPlacementFixture(
  sessionKey: string,
  state: WorkerSessionPlacementRecord["state"] = "active",
): PlacementFixture {
  const sessionId = `session-${sessionKey.slice(sessionKey.lastIndexOf(":") + 1)}`;
  return {
    sessionId,
    sessionKey,
    agentId: "main",
    state,
    generation: 1,
    environmentId: state === "local" || state === "requested" ? null : `environment-${sessionId}`,
    activeOwnerEpoch: state === "active" || state === "draining" ? 1 : null,
    turnClaim: null,
  };
}

function createMaintenanceRuntime(params: {
  placements: PlacementFixture[];
  preservationStore?: WorkerSessionPlacementStore;
  onRecovery?: () => void | Promise<void>;
  recoveryError?: Error;
  stopError?: Error;
}) {
  const forceDestroyEnvironment = vi.fn().mockResolvedValue(undefined);
  const goneEnvironmentIds = new Set<string>();
  runtimeFactoryMocks.createDiskSpace.mockReturnValue({
    read: vi.fn(),
    version: vi.fn(() => 0),
    sweep: vi.fn().mockResolvedValue(undefined),
  });
  runtimeFactoryMocks.createDispatch.mockReturnValue({
    dispatch: vi.fn(),
    forceDestroyEnvironment,
    reclaim: vi.fn(),
    reconcile: vi.fn().mockResolvedValue(undefined),
    reconcileActive: vi.fn().mockResolvedValue(undefined),
  });
  runtimeFactoryMocks.createSessionEvidenceResolver.mockResolvedValue(async () => "current");
  const stop = vi.fn().mockResolvedValue(undefined);
  if (params.stopError) {
    stop.mockRejectedValueOnce(params.stopError);
  }
  const environments = {
    get: (environmentId: string) =>
      goneEnvironmentIds.has(environmentId)
        ? { state: "destroyed" as const, leaseId: null }
        : { state: "attached" as const, leaseId: "cloud-lease" },
    subscribeMachineShapeChanged: vi.fn(() => vi.fn()),
    installReconcileEnvironmentGuard: vi.fn(() => vi.fn()),
    start: vi.fn(),
    stop,
  };
  const runtime = createGatewayWorkerPlacementRuntime({
    initialPlacements: [],
    scheduler: createTestGatewayScheduler(),
    getCommittedRuntimeConfig: getRuntimeConfig,
    cancelSessionWork: vi.fn(async () => {}),
    placements: {
      workspaceResultInstanceId: () => "gateway-test",
      get: (sessionId: string) =>
        params.placements.find((placement) => placement.sessionId === sessionId),
      listAsync: async () => params.placements,
      listForReconcileAsync: async (sessionKey?: string) =>
        params.preservationStore
          ? await params.preservationStore.listForReconcileAsync(sessionKey)
          : params.placements.filter(
              (placement) =>
                placement.state !== "local" &&
                placement.state !== "reclaimed" &&
                (sessionKey === undefined || placement.sessionKey === sessionKey),
            ),
      prepareMaintenancePlacements: async () =>
        params.preservationStore
          ? await params.preservationStore.prepareMaintenancePlacements()
          : {
              placements: params.placements.filter(
                (placement) => placement.state !== "local" && placement.state !== "reclaimed",
              ),
              assertCurrent: () => {},
              release: () => {},
            },
      retireSessionPlacement: vi.fn(),
      pruneOrphanedWorkspaceReconciliations: async () => {
        await params.onRecovery?.();
        if (params.recoveryError) {
          throw params.recoveryError;
        }
        return [];
      },
      listWorkspaceReconciliationOwners: async () => [],
      listPendingWorkspaceResultsAsync: async () => [],
      prepareRuntimeRefresh: async (sessionId: string) => ({
        placement: params.placements.find((placement) => placement.sessionId === sessionId),
        move: undefined,
        pendingResult: undefined,
        assertCurrent: () => {},
        release: () => {},
      }),
    } as never,
    environments: environments as never,
    gatewayNamespace: "gateway-test",
    revokeSessionAuthority: vi.fn(),
    warn: vi.fn(),
  });
  return { environments, forceDestroyEnvironment, goneEnvironmentIds, runtime };
}

async function startMaintenanceRuntime(
  runtime: ReturnType<typeof createGatewayWorkerPlacementRuntime>,
) {
  const sidecar = await runtime.startRuntime({
    isClosePreludeStarted: () => false,
    registerSidecar: vi.fn(),
    unregisterSidecar: vi.fn(),
  });
  if (!sidecar) {
    throw new Error("worker placement runtime did not start");
  }
  return sidecar;
}

async function preservedSessionKeys() {
  const prepared = await prepareSessionMaintenancePreservation("unused-store");
  try {
    return new Set(prepared.capture().providerKeys);
  } finally {
    prepared.dispose();
  }
}

describe("worker placement session maintenance ownership", () => {
  it.each(["claim", "release"] as const)(
    "rejects unpublished maintenance inventory during a concurrent worker %s",
    async (publication) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const database = openOpenClawStateDatabase();
        const store = createWorkerSessionPlacementStore({ database });
        const identity = {
          sessionId: "concurrent-worker-session",
          sessionKey: "agent:main:concurrent-worker-session",
          agentId: "main",
        };
        const active = await advancePlacementFixtureToActive(store, database, identity);
        const turn = {
          ...identity,
          owner: placementTurnOwner(active),
          claimId: "concurrent-worker-claim",
          runId: "concurrent-worker-run",
        };
        let claim = publication === "release" ? await store.claimTurn(turn) : undefined;
        const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
        const preservedEntry = { sessionId: identity.sessionId, updatedAt: 1 };
        await patchSessionEntryCore(
          { ...identity, storePath, env: state.env },
          () => preservedEntry,
          { fallbackEntry: preservedEntry, skipMaintenance: true },
        );
        const preservedSnapshot = loadSessionEntryReadOnly({
          ...identity,
          env: state.env,
          storePath,
        });
        const { runtime } = createMaintenanceRuntime({
          placements: [active],
          preservationStore: store,
        });
        const sidecar = await startMaintenanceRuntime(runtime);
        const read = stateReads.executeExistingOpenClawStateRead;
        let preservationReads = 0;
        const interleave = vi
          .spyOn(stateReads, "executeExistingOpenClawStateRead")
          .mockImplementation(async (...args) => {
            const result = await read(...args);
            if (args[1].type === "workers.placementPreservation" && ++preservationReads === 1) {
              // Commit after the real worker read, before its inventory can be published.
              if (claim) {
                await store.releaseTurnIfOwned(claim);
                claim = undefined;
              } else {
                claim = await store.claimTurn(turn);
              }
            }
            return result;
          });
        const trigger = {
          agentId: "main",
          env: state.env,
          storePath,
          sessionKey: "agent:main:concurrent-maintenance-trigger",
        };
        try {
          await expect(
            applySessionEntryLifecycleMutation({
              ...trigger,
              upserts: [
                {
                  sessionKey: trigger.sessionKey,
                  entry: {
                    sessionId: "concurrent-maintenance-trigger",
                    updatedAt: Date.now(),
                  },
                },
              ],
              maintenanceOverride: resolveMaintenanceConfigFromInput({
                mode: "enforce",
                maxEntries: 1,
                maxDiskBytes: false,
              }),
            }),
          ).rejects.toThrow("Worker placement inventory changed");
          expect(preservationReads).toBe(1);
          expect(loadSessionEntryReadOnly({ ...identity, env: state.env, storePath })).toEqual(
            preservedSnapshot,
          );
          expect(loadSessionEntryReadOnly(trigger)).toBeUndefined();
        } finally {
          interleave.mockRestore();
          if (claim) {
            await store.releaseTurnIfOwned(claim);
          }
          await sidecar.stop();
        }
      });
    },
  );

  it.each(["local claim", "local release", "worker dispatch"] as const)(
    "fences a fresh lifecycle upsert only for worker placements during %s",
    async (publication) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const store = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
        const localTurn = {
          sessionId: "unrelated-local-session",
          sessionKey: "agent:codex:unrelated-local-session",
          agentId: "codex",
          owner: { kind: "local" as const },
          claimId: "unrelated-local-claim",
          runId: "unrelated-local-run",
        };
        let claim: WorkerSessionTurnClaim | undefined;
        if (publication === "local release") {
          claim = await store.claimTurn(localTurn);
        }
        const { runtime } = createMaintenanceRuntime({ placements: [], preservationStore: store });
        const sidecar = await startMaintenanceRuntime(runtime);
        const prepare = store.prepareMaintenancePlacements.bind(store);
        const interleave = vi
          .spyOn(store, "prepareMaintenancePlacements")
          .mockImplementationOnce(async () => {
            const prepared = await prepare();
            try {
              expect(prepared.placements).toEqual([]);
              if (publication === "worker dispatch") {
                await store.startDispatch(localTurn);
              } else if (claim) {
                await store.releaseTurnIfOwned(claim);
                claim = undefined;
              } else {
                claim = await store.claimTurn(localTurn);
              }
              if (publication !== "worker dispatch") {
                expect(await store.listForReconcileAsync()).toEqual([]);
              }
              return prepared;
            } catch (error) {
              prepared.release();
              throw error;
            }
          });
        const scope = {
          agentId: "main",
          env: state.env,
          storePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
          sessionKey: "agent:main:fresh-local-session",
        };
        const mutate = () =>
          applySessionEntryLifecycleMutation({
            ...scope,
            upserts: [
              {
                sessionKey: scope.sessionKey,
                entry: { sessionId: "fresh-local-session", updatedAt: 1000 },
              },
            ],
          });
        try {
          if (publication === "worker dispatch") {
            await expect(mutate()).rejects.toThrow("Worker placement inventory changed");
            expect(loadSessionEntryReadOnly(scope)).toBeUndefined();
          }
          await expect(mutate()).resolves.toMatchObject({ afterCount: 1 });
          expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe("fresh-local-session");
        } finally {
          interleave.mockRestore();
          if (claim) {
            await store.releaseTurnIfOwned(claim);
          }
          await sidecar.stop();
        }
      });
    },
  );

  it("prepares and recaptures placement preservation without caller-thread SQL", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const store = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
      const placement = await store.startDispatch({
        sessionId: "preserved-placement",
        sessionKey: "agent:main:preserved-placement",
        agentId: "main",
      });
      const { runtime } = createMaintenanceRuntime({
        placements: [placement],
        preservationStore: store,
      });
      const sidecar = await startMaintenanceRuntime(runtime);
      const sql = observeHostDataSql();
      let prepared: Awaited<ReturnType<typeof prepareSessionMaintenancePreservation>> | undefined;
      try {
        prepared = await prepareSessionMaintenancePreservation(
          resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
        );
        for (let grant = 0; grant < 4; grant += 1) {
          expect(prepared.capture().providerKeys).toEqual([placement.sessionKey]);
        }
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
        prepared?.dispose();
        await sidecar.stop();
      }
    });
  });

  it("retains a configured-store repository base after its placement manifest advances", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.path("custom-sessions", "openclaw-agent.sqlite");
      await state.writeConfig({ session: { store: storePath } });
      const placement = {
        ...createPlacementFixture("agent:main:dashboard:repository-retention"),
        workspaceBaseManifestRef: `sha256:${"a".repeat(64)}`,
      };
      const repositories = getSessionRepositoryWorkspaceStore();
      const repository = await repositories.create({
        agentId: placement.agentId,
        sessionKey: placement.sessionKey,
        url: "https://github.com/openclaw/fixture.git",
        assertCurrent: () => {},
      });
      await repositories.bindBase({
        workspaceId: repository.workspaceId,
        expectedRevision: repository.revision,
        baseCommit: "c".repeat(40),
        baseManifestHash: placement.workspaceBaseManifestRef,
        assertCurrent: () => {},
      });
      const entry = {
        sessionId: placement.sessionId,
        repositoryWorkspaceId: repository.workspaceId,
        updatedAt: Date.now(),
      };
      await patchSessionEntryCore({ ...placement, storePath }, () => entry, {
        fallbackEntry: entry,
        skipMaintenance: true,
      });
      expect(loadSessionEntryReadOnly(placement)).toBeUndefined();
      const createRetention = vi.spyOn(workspaceRetention, "createNodeWorkspaceRetainCoordinator");
      let prepared:
        | Awaited<ReturnType<WorkerSessionPlacementStore["prepareRuntimeRefresh"]>>
        | undefined;
      try {
        createMaintenanceRuntime({ placements: [placement] });
        const options = createRetention.mock.calls.at(-1)?.[0];
        const additionalManifestRefs = options?.additionalManifestRefs;
        prepared = await options?.placements.prepareRuntimeRefresh(placement.sessionId);
        const currentPlacement = prepared?.placement;
        if (!additionalManifestRefs || !currentPlacement) {
          throw new Error("startup did not bind repository manifest retention");
        }
        const originalManifest = placement.workspaceBaseManifestRef;
        placement.workspaceBaseManifestRef = `sha256:${"b".repeat(64)}`;
        const currentManifestRefs = await additionalManifestRefs(currentPlacement);
        expect(currentManifestRefs()).toEqual([originalManifest]);
      } finally {
        prepared?.release();
        createRetention.mockRestore();
      }
    });
  });

  it.each([
    { maintenance: "dashboard archive", sessionKey: "agent:main:dashboard:cloud-owned" },
    { maintenance: "stale pruning", sessionKey: "agent:main:explicit:cloud-owned-prune" },
    { maintenance: "entry capping", sessionKey: "agent:main:explicit:cloud-owned-cap" },
  ] as const)(
    "preserves active placements during $maintenance and releases them for maintenance after stop",
    async ({ maintenance, sessionKey }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const now = Date.now();
        const placement = createPlacementFixture(sessionKey);
        const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
        const sessionScope = (key: string) => ({
          agentId: "main",
          env: state.env,
          sessionKey: key,
          storePath,
        });
        const entry = {
          sessionId: placement.sessionId,
          updatedAt: maintenance === "entry capping" ? now - 1_000 : now - 31 * 86_400_000,
        };
        await patchSessionEntryCore(sessionScope(sessionKey), () => entry, {
          fallbackEntry: entry,
          replaceEntry: true,
          skipMaintenance: true,
        });
        const sentinelKey = "agent:main:explicit:maintenance-sentinel";
        const sentinelEntry = {
          sessionId: "maintenance-sentinel",
          updatedAt: now - 31 * 86_400_000,
        };
        await patchSessionEntryCore(sessionScope(sentinelKey), () => sentinelEntry, {
          fallbackEntry: sentinelEntry,
          replaceEntry: true,
          skipMaintenance: true,
        });
        const { forceDestroyEnvironment, runtime } = createMaintenanceRuntime({
          placements: [placement],
        });
        runtimeFactoryMocks.createSessionEvidenceResolver.mockImplementation(
          async () => async (candidate: { sessionKey: string }) =>
            loadSessionEntry(sessionScope(candidate.sessionKey)) ? "current" : "absent",
        );
        const sidecar = await startMaintenanceRuntime(runtime);
        const triggerEntry = { sessionId: "maintenance-trigger", updatedAt: now };
        const maintenanceConfig = resolveMaintenanceConfigFromInput({
          mode: "enforce",
          archiveDashboardAfter: "7d",
          pruneAfter: "30d",
          maxEntries: maintenance === "entry capping" ? 1 : 500,
          maxDiskBytes: false,
        });
        const triggerMaintenance = async () =>
          await patchSessionEntryCore(
            sessionScope("agent:main:explicit:maintenance-trigger"),
            () => triggerEntry,
            { fallbackEntry: triggerEntry, replaceEntry: true, maintenanceConfig },
          );
        const agePublished = createDeferredCore();
        const reclaim = reclamationRun.runSqliteSessionReclamation;
        const ageObserver = vi
          .spyOn(reclamationRun, "runSqliteSessionReclamation")
          .mockImplementation(async (params) => {
            const result = await reclaim(params);
            if (params.plan.kind === "maintenance-age") {
              agePublished.resolve();
            }
            return result;
          });

        try {
          const sentinelArchived = observeSessionMaintenanceChanges(storePath, sentinelKey);
          await triggerMaintenance();
          await sentinelArchived;
          await agePublished.promise;
          await vi.waitFor(() => {
            expect(loadSessionEntry(sessionScope(sentinelKey))).toMatchObject({
              sessionId: sentinelEntry.sessionId,
              archivedAt: expect.any(Number),
            });
          });
          expect(loadSessionEntry(sessionScope(sessionKey))).toMatchObject({
            sessionId: placement.sessionId,
          });
          expect(loadSessionEntry(sessionScope(sessionKey))?.archivedAt).toBeUndefined();
          expect(forceDestroyEnvironment).not.toHaveBeenCalled();
          expect((await preservedSessionKeys()).has(sessionKey)).toBe(true);

          await sidecar.stop();
          expect((await preservedSessionKeys()).has(sessionKey)).not.toBe(true);
          // A managed backdate invalidates the age fact held by the native worker.
          triggerEntry.updatedAt -= 1;
          const placementArchived = observeSessionMaintenanceChanges(storePath, sessionKey);
          await triggerMaintenance();
          await placementArchived;
          await vi.waitFor(() => {
            expect(loadSessionEntry(sessionScope(sessionKey))).toMatchObject({
              sessionId: placement.sessionId,
              archivedAt: expect.any(Number),
            });
          });
        } finally {
          ageObserver.mockRestore();
          await sidecar.stop();
        }
      });
    },
  );

  it("preserves every remote-owning state and releases failed placements once their environment is gone", async () => {
    const remoteOwningStates = [
      "requested",
      "provisioning",
      "syncing",
      "starting",
      "active",
      "draining",
      "reconciling",
    ] as const;
    const protectedPlacements = remoteOwningStates.map((placementState) =>
      createPlacementFixture(`agent:main:placement-${placementState}`, placementState),
    );
    const failedLive = createPlacementFixture("agent:main:failed-live", "failed");
    const failedGone = createPlacementFixture("agent:main:failed-gone", "failed");
    const local = createPlacementFixture("agent:main:placement-local", "local");
    const reclaimed = createPlacementFixture("agent:main:placement-reclaimed", "reclaimed");
    const { goneEnvironmentIds, runtime } = createMaintenanceRuntime({
      placements: [...protectedPlacements, failedLive, failedGone, local, reclaimed],
    });
    if (!failedLive.environmentId || !failedGone.environmentId) {
      throw new Error("failed placement fixtures are missing environment identities");
    }
    goneEnvironmentIds.add(failedGone.environmentId);
    const sidecar = await startMaintenanceRuntime(runtime);
    const prepared = await prepareSessionMaintenancePreservation("unused-store");
    try {
      const preserveKeys = new Set(prepared.capture().providerKeys);
      for (const placement of [...protectedPlacements, failedLive]) {
        expect(preserveKeys?.has(placement.sessionKey)).toBe(true);
      }
      for (const placement of [local, reclaimed, failedGone]) {
        expect(preserveKeys?.has(placement.sessionKey)).not.toBe(true);
      }

      goneEnvironmentIds.add(failedLive.environmentId);
      expect(prepared.capture().providerKeys).not.toContain(failedLive.sessionKey);
    } finally {
      await sidecar.stop();
      expect(() => prepared.capture()).toThrow(
        expect.objectContaining({
          name: "SqliteSessionMutationConflictError",
          operationLabel: "session maintenance",
        }),
      );
      prepared.dispose();
    }
    expect((await preservedSessionKeys()).has("agent:main:placement-requested")).not.toBe(true);
  });

  it("unregisters preservation synchronously when environment stop fails and is retried", async () => {
    const stopError = new Error("tunnel cleanup failed");
    const placement = createPlacementFixture("agent:main:failed-stop");
    const { environments, runtime } = createMaintenanceRuntime({
      placements: [placement],
      stopError,
    });
    const sidecar = await startMaintenanceRuntime(runtime);

    const prepared = await prepareSessionMaintenancePreservation("unused-store");
    try {
      expect(prepared.capture().providerKeys).toContain(placement.sessionKey);
      const firstStop = sidecar.stop();
      expect(() => prepared.capture()).toThrow(
        expect.objectContaining({
          name: "SqliteSessionMutationConflictError",
          operationLabel: "session maintenance",
        }),
      );
      expect(sidecar.stop()).toBe(firstStop);
      await expect(firstStop).rejects.toBe(stopError);
      await expect(sidecar.stop()).resolves.toBeUndefined();
      expect(environments.stop).toHaveBeenCalledTimes(2);
    } finally {
      prepared.dispose();
    }
  });

  it("unregisters preservation and its sidecar when initial workspace recovery fails", async () => {
    const recoveryError = new Error("workspace reconciliation inventory failed");
    const placement = createPlacementFixture("agent:main:failed-recovery");
    let protectedDuringRecovery = false;
    const { environments, runtime } = createMaintenanceRuntime({
      placements: [placement],
      recoveryError,
      onRecovery: async () => {
        protectedDuringRecovery = (await preservedSessionKeys()).has(placement.sessionKey);
      },
    });
    const registerSidecar = vi.fn();
    const unregisterSidecar = vi.fn();

    await expect(
      runtime.startRuntime({
        isClosePreludeStarted: () => false,
        registerSidecar,
        unregisterSidecar,
      }),
    ).rejects.toBe(recoveryError);

    expect(protectedDuringRecovery).toBe(true);
    expect(registerSidecar).toHaveBeenCalledOnce();
    expect(unregisterSidecar).toHaveBeenCalledWith(registerSidecar.mock.calls[0]?.[0]);
    expect(environments.stop).toHaveBeenCalledOnce();
    expect((await preservedSessionKeys()).has(placement.sessionKey)).not.toBe(true);
  });
});
