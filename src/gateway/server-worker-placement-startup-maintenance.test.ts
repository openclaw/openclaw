import { describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { applySessionEntryLifecycleMutation } from "../config/sessions/session-accessor.sqlite-projection.js";
import { prepareSessionMaintenancePreservation } from "../config/sessions/store-maintenance-preserve.js";
import { resolveMaintenanceConfigFromInput } from "../config/sessions/store-maintenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  preservedSessionKeys,
  startPlacementRuntime as startMaintenanceRuntime,
} from "./server-worker-placement-startup.test-support.js";
import {
  createEnvironments,
  createIdleDiskSpace,
  createRuntimeFactory,
  placementAsyncDefaults,
  setDispatchMock,
} from "./server-worker-placement.test-support.js";
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

const createRuntime = createRuntimeFactory(createGatewayWorkerPlacementRuntime, getRuntimeConfig);

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
}) {
  const goneEnvironmentIds = new Set<string>();
  runtimeFactoryMocks.createDiskSpace.mockReturnValue(createIdleDiskSpace());
  setDispatchMock(runtimeFactoryMocks.createDispatch, {
    forceDestroyEnvironment: vi.fn().mockResolvedValue(undefined),
  });
  runtimeFactoryMocks.createSessionEvidenceResolver.mockResolvedValue(async () => "current");
  const environments = {
    ...createEnvironments(),
    get: (environmentId: string) =>
      goneEnvironmentIds.has(environmentId)
        ? { state: "destroyed" as const, leaseId: null }
        : { state: "attached" as const, leaseId: "cloud-lease" },
  };
  const runtime = createRuntime({
    placements: {
      ...placementAsyncDefaults(() => params.placements),
      subscribeChanges: (
        listener: Parameters<WorkerSessionPlacementStore["subscribeChanges"]>[0],
      ) => params.preservationStore?.subscribeChanges(listener) ?? (() => {}),
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
      pruneOrphanedWorkspaceReconciliations: async () => {
        await params.onRecovery?.();
        if (params.recoveryError) {
          throw params.recoveryError;
        }
        return [];
      },
      prepareRuntimeRefresh: async (sessionId: string) => ({
        placement: params.placements.find((placement) => placement.sessionId === sessionId),
        move: undefined,
        pendingResult: undefined,
        assertCurrent: () => {},
        release: () => {},
      }),
    } as never,
    environments: environments as never,
  });
  return { environments, goneEnvironmentIds, runtime };
}

function seedEntry(scope: Parameters<typeof patchSessionEntryCore>[0], entry: SessionEntry) {
  return patchSessionEntryCore(scope, () => entry, {
    fallbackEntry: entry,
    skipMaintenance: true,
  });
}

function upsertEntry(
  scope: Parameters<typeof applySessionEntryLifecycleMutation>[0] & { sessionKey: string },
  entry: SessionEntry,
) {
  return applySessionEntryLifecycleMutation({
    ...scope,
    upserts: [{ sessionKey: scope.sessionKey, entry }],
  });
}

async function expectWorkerPreservation(storePath: string, keys: string[]) {
  const sql = observeHostDataSql();
  try {
    const prepared = await prepareSessionMaintenancePreservation(storePath);
    using _ = { [Symbol.dispose]: prepared.dispose };
    for (let capture = 0; capture < 4; capture += 1) {
      expect(prepared.capture().providerKeys).toEqual(keys);
    }
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
}

describe("worker placement session maintenance ownership", () => {
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
      try {
        await expectWorkerPreservation(
          resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
          [placement.sessionKey],
        );
      } finally {
        await sidecar.stop();
      }
    });
  });

  it.each(["claim", "release", "dispatch"] as const)(
    "preserves worker-owned session data during a concurrent %s",
    async (publication) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const database = openOpenClawStateDatabase();
        const store = createWorkerSessionPlacementStore({ database });
        const identity = {
          sessionId: "concurrent-worker-session",
          sessionKey: "agent:main:concurrent-worker-session",
          agentId: "main",
        };
        const active =
          publication === "dispatch"
            ? undefined
            : await advancePlacementFixtureToActive(store, database, identity);
        const turn = active && {
          ...identity,
          owner: placementTurnOwner(active),
          claimId: "concurrent-worker-claim",
          runId: "concurrent-worker-run",
        };
        let claim = publication === "release" && turn ? await store.claimTurn(turn) : undefined;
        const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
        const preservedEntry = { sessionId: identity.sessionId, updatedAt: 1 };
        await seedEntry({ ...identity, storePath, env: state.env }, preservedEntry);
        const preservedSnapshot = loadSessionEntryReadOnly({
          ...identity,
          env: state.env,
          storePath,
        });
        const { runtime } = createMaintenanceRuntime({
          placements: active ? [active] : [],
          preservationStore: store,
        });
        const sidecar = await startMaintenanceRuntime(runtime);
        await using runtimeCleanup = new AsyncDisposableStack();
        runtimeCleanup.defer(() => sidecar.stop());
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
              } else if (turn) {
                claim = await store.claimTurn(turn);
              } else {
                await store.startDispatch(identity);
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
            upsertEntry(
              {
                ...trigger,
                maintenanceOverride: resolveMaintenanceConfigFromInput({
                  mode: "enforce",
                  maxEntries: 1,
                  maxDiskBytes: false,
                }),
              },
              { sessionId: "concurrent-maintenance-trigger", updatedAt: Date.now() },
            ),
          ).resolves.toBeDefined();
          expect(preservationReads).toBe(1);
          expect(loadSessionEntryReadOnly({ ...identity, env: state.env, storePath })).toEqual(
            preservedSnapshot,
          );
          expect(loadSessionEntryReadOnly(trigger)?.sessionId).toBe(
            "concurrent-maintenance-trigger",
          );
        } finally {
          interleave.mockRestore();
          if (claim) {
            await store.releaseTurnIfOwned(claim);
          }
        }
      });
    },
  );

  it.each(["local claim", "local release", "worker dispatch"] as const)(
    "admits a fresh lifecycle upsert during an unrelated %s",
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
        try {
          await expect(
            upsertEntry(scope, { sessionId: "fresh-local-session", updatedAt: 1000 }),
          ).resolves.toMatchObject({ afterCount: 1 });
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

  it("retains a configured-store repository base after its placement manifest advances", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.path("custom-sessions", "openclaw-agent.sqlite");
      const cfg = { session: { store: storePath } };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot({});
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
      await seedEntry({ ...placement, storePath }, entry);
      expect(loadSessionEntryReadOnly(placement)).toBeUndefined();
      setRuntimeConfigSnapshot(cfg);
      const createRetention = vi.spyOn(workspaceRetention, "createNodeWorkspaceRetainCoordinator");
      let prepared:
        | Awaited<ReturnType<WorkerSessionPlacementStore["prepareRuntimeRefresh"]>>
        | undefined;
      try {
        vi.mocked(getRuntimeConfig).mockReturnValue(cfg);
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
        using currentManifestRefs = await additionalManifestRefs(currentPlacement);
        expect(currentManifestRefs()).toEqual([originalManifest]);
        await patchSessionEntryCore({ ...placement, storePath }, () => ({
          repositoryWorkspaceId: "replacement-workspace",
        }));
        const sql = observeHostDataSql();
        try {
          expect(currentManifestRefs()).toEqual([originalManifest]);
          expect(sql.queries).toEqual([]);
        } finally {
          sql.restore();
        }
      } finally {
        prepared?.release();
        createRetention.mockRestore();
        vi.mocked(getRuntimeConfig).mockReturnValue({});
      }
    });
  });

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
      const stopping = sidecar.stop();
      expect(() => prepared.capture()).toThrow(
        expect.objectContaining({
          name: "SqliteSessionMutationConflictError",
          operationLabel: "session maintenance",
        }),
      );
      await stopping;
      prepared.dispose();
    }
    expect((await preservedSessionKeys()).has("agent:main:placement-requested")).not.toBe(true);
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
