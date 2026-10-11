import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { createWorkerPlacementMoveService } from "./placement-move-service.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import {
  advancePlacementFixtureToActive,
  seedAttachedPlacementEnvironment,
} from "./placement-test-fixtures.js";

const SESSION: WorkerSessionPlacementIdentity = {
  sessionId: "session-move",
  agentId: "main",
  sessionKey: "agent:main:move",
};

describe("worker session placement moves", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerSessionPlacementStore;
  let nowMs: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-move-store-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    nowMs = 1_000;
    store = createWorkerSessionPlacementStore({ database, now: () => nowMs });
  });

  afterEach(async () => {
    await closeStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function advanceToActive() {
    return advancePlacementFixtureToActive(store, database, SESSION, {
      environmentId: "environment-move",
      remoteWorkspaceDir: "/workspace/move",
    });
  }

  async function seedActiveEnvironment() {
    const active = await advanceToActive();
    seedAttachedPlacementEnvironment(database, {
      environmentId: active.environmentId,
      sessionId: active.sessionId,
      ownerEpoch: active.activeOwnerEpoch,
    });
    return active;
  }

  function sourceFor(active: Awaited<ReturnType<typeof advanceToActive>>) {
    return {
      generation: active.generation,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
    };
  }

  async function beginGatewayMove(abandonSource?: true) {
    const active = await seedActiveEnvironment();
    const begun = await store.beginPlacementMove({
      sessionId: active.sessionId,
      source: sourceFor(active),
      target: { kind: "gateway" },
      ...(abandonSource ? { abandonSource } : {}),
    });
    return { active, begun };
  }

  function reconcileMove(active: Awaited<ReturnType<typeof advanceToActive>>, generation: number) {
    return store.startReconcile({
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: generation,
    });
  }

  it("reads and mutates native move state without caller-thread SQL", async () => {
    const active = await seedActiveEnvironment();
    const request = {
      sessionId: ` ${SESSION.sessionId} `,
      source: sourceFor(active),
      target: { kind: "gateway" as const },
    };
    const sql = observeMainThreadSql();
    try {
      const begun = await store.beginPlacementMove(request);
      expect(await store.getWithMoveAsync(request.sessionId)).toMatchObject({
        placement: {
          sessionId: SESSION.sessionId,
          state: "draining",
          generation: begun.placement.generation,
        },
        move: {
          operationId: begun.intent.operationId,
          sessionId: SESSION.sessionId,
          source: request.source,
        },
      });
      expect(
        await store.recordPlacementMoveError({
          operationId: begun.intent.operationId,
          sessionId: SESSION.sessionId,
          error: "waiting for source",
        }),
      ).toBe(true);
      const reconciling = await reconcileMove(active, begun.placement.generation);
      expect(
        await store.completePlacementMoveSourceToLocal({
          operationId: begun.intent.operationId,
          sessionId: SESSION.sessionId,
          expectedGeneration: reconciling.generation,
        }),
      ).toMatchObject({ state: "local" });
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    expect(await store.getPlacementMoveAsync(SESSION.sessionId)).toBeUndefined();
    expect(store.get(SESSION.sessionId)?.state).toBe("local");
  });

  it.each(["transaction", "commit"] as const)(
    "rolls back a move when caller authority ends at %s admission",
    async (stage) => {
      const active = await seedActiveEnvironment();
      let revoked = false;
      const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
      const admission = vi
        .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementationOnce((admit, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === stage) {
              revoked = true;
            }
            admit(request, grant);
          }, attachment),
        );
      try {
        await expect(
          store.beginPlacementMove(
            {
              sessionId: SESSION.sessionId,
              source: sourceFor(active),
              target: { kind: "gateway" },
            },
            {
              assertCurrent: () => {
                if (revoked) {
                  throw new Error("caller revoked");
                }
              },
            },
          ),
        ).rejects.toThrow("caller revoked");
      } finally {
        admission.mockRestore();
      }
      expect(revoked).toBe(true);
      expect(store.get(SESSION.sessionId)).toEqual(active);
      expect(await store.getPlacementMoveAsync(SESSION.sessionId)).toBeUndefined();
    },
  );

  it("lazily begins one exact-source move in the drain transaction", async () => {
    database.db.exec("DROP TABLE worker_session_placement_moves");
    expect(
      database.db
        .prepare("SELECT 1 AS ok FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("worker_session_placement_moves"),
    ).toBeUndefined();
    expect(await store.readProjection([SESSION.sessionId])).toEqual({
      placements: new Map(),
      moves: new Map(),
      pendingResults: new Map(),
      workspaceJournalOwnerSessionIds: new Set(),
      environments: new Map(),
      workspaceResultReconcilingSessionIds: new Set(),
      workspaceRecoveryPendingSessionIds: new Set(),
    });
    expect(
      database.db
        .prepare("SELECT 1 AS ok FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("worker_session_placement_moves"),
    ).toBeUndefined();

    const active = await seedActiveEnvironment();
    const workerClaim = await store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "move-source-claim",
      runId: "move-source-run",
    });
    const source = sourceFor(active);

    const begun = await store.beginPlacementMove({
      sessionId: SESSION.sessionId,
      source,
      target: { kind: "gateway" },
    });

    expect(begun).toMatchObject({
      joined: false,
      intent: {
        sessionId: SESSION.sessionId,
        source,
        target: { kind: "gateway" },
        abandonSource: false,
        lastError: null,
      },
      placement: {
        state: "draining",
        generation: active.generation + 1,
        turnClaim: { claimId: workerClaim.claimId },
      },
    });
    expect(begun.intent.operationId).toMatch(/^move:v1:[A-Za-z0-9_-]{43}$/u);
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(await store.getPlacementMoveAsync(SESSION.sessionId)).toEqual(begun.intent);
    expect(await store.readProjection([SESSION.sessionId, "missing"])).toMatchObject({
      placements: new Map([[SESSION.sessionId, begun.placement]]),
      moves: new Map([[SESSION.sessionId, begun.intent]]),
      workspaceResultReconcilingSessionIds: new Set(),
    });

    expect(
      await store.beginPlacementMove({
        sessionId: SESSION.sessionId,
        source,
        target: { kind: "gateway" },
      }),
    ).toMatchObject({ joined: true, intent: { operationId: begun.intent.operationId } });
    await expect(
      store.beginPlacementMove({
        sessionId: SESSION.sessionId,
        source,
        target: { kind: "profile", profileId: "other-profile" },
      }),
    ).rejects.toThrow("already has a conflicting placement move");
    await expect(
      store.beginPlacementMove({
        sessionId: SESSION.sessionId,
        source,
        target: { kind: "gateway" },
        abandonSource: true,
      }),
    ).rejects.toThrow("already has a conflicting placement move");
  });

  it("persists explicit abandonment and atomically completes its exact failed source", async () => {
    const { active, begun } = await beginGatewayMove(true);
    expect(await store.getPlacementMoveAsync(active.sessionId)).toMatchObject({
      abandonSource: true,
    });
    const reconciling = await reconcileMove(active, begun.placement.generation);
    const recoveryError = "Worker result abandoned by forced operator teardown";
    const failed = await store.fail({
      sessionId: active.sessionId,
      expectedGeneration: reconciling.generation,
      recoveryError,
    });
    await expect(
      store.completeAbandonedPlacementMoveSourceToLocal({
        operationId: begun.intent.operationId,
        sessionId: active.sessionId,
        expectedGeneration: failed.generation,
        expectedRecoveryError: "different abandonment",
      }),
    ).rejects.toThrow("Cannot complete stale abandoned placement move");

    expect(
      await store.completeAbandonedPlacementMoveSourceToLocal({
        operationId: begun.intent.operationId,
        sessionId: active.sessionId,
        expectedGeneration: failed.generation,
        expectedRecoveryError: recoveryError,
      }),
    ).toMatchObject({ state: "local", generation: failed.generation + 1 });
    expect(await store.getPlacementMoveAsync(active.sessionId)).toBeUndefined();
  });

  it("permits draining an active placement with a pending workspace result when abandoning source", async () => {
    const active = await seedActiveEnvironment();
    const claim = await store.claimTurn({
      ...SESSION,
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "pending-claim",
      runId: "pending-run",
    });
    await store.markWorkspaceResultPending(claim);
    expect(await store.listPendingWorkspaceResultsAsync()).toHaveLength(1);
    await store.prepareWorkspaceResultClaim(claim);

    const source = sourceFor(active);

    await expect(
      store.beginPlacementMove({
        sessionId: active.sessionId,
        source,
        target: { kind: "gateway" },
      }),
    ).rejects.toThrow(
      `Cannot drain session ${active.sessionId} with a pending cloud workspace result`,
    );

    const begun = await store.beginPlacementMove({
      sessionId: active.sessionId,
      source,
      target: { kind: "gateway" },
      abandonSource: true,
    });

    expect(begun).toMatchObject({
      joined: false,
      placement: { state: "draining" },
      intent: { abandonSource: true },
    });
    expect(await store.getPlacementMoveAsync(active.sessionId)).toMatchObject({
      abandonSource: true,
    });
    expect(store.validateWorkspaceResultClaim(claim)).toBe(true);
  });

  it("persists profile choices without an OS and joins only the exact target", async () => {
    const active = await seedActiveEnvironment();
    const source = sourceFor(active);
    const target = {
      kind: "profile",
      profileId: "profile-destination",
      machineClass: "beast",
    } as const;
    const begun = await store.beginPlacementMove({
      sessionId: SESSION.sessionId,
      source,
      target: { ...target, machineClass: " beast " },
    });

    expect(await store.getPlacementMoveAsync(SESSION.sessionId)).toMatchObject({ target });
    expect(
      database.db
        .prepare("SELECT target_os FROM worker_session_placement_moves WHERE session_id = ?")
        .get(SESSION.sessionId),
    ).toEqual({ target_os: null });
    expect((await store.getPlacementMoveAsync(SESSION.sessionId))?.target).not.toHaveProperty("os");
    expect(
      await store.beginPlacementMove({ sessionId: SESSION.sessionId, source, target }),
    ).toMatchObject({ joined: true, intent: { operationId: begun.intent.operationId, target } });
    await expect(
      store.beginPlacementMove({
        sessionId: SESSION.sessionId,
        source,
        target: { ...target, machineClass: "fast" },
      }),
    ).rejects.toThrow("already has a conflicting placement move");
    await expect(
      store.beginPlacementMove({
        sessionId: SESSION.sessionId,
        source,
        target: { ...target, os: "os-b" },
      }),
    ).rejects.toThrow("already has a conflicting placement move");
  });

  it("rejects an OS stored for a non-profile target", async () => {
    await beginGatewayMove();
    database.db
      .prepare(
        "UPDATE worker_session_placement_moves SET target_os = 'override' WHERE session_id = ?",
      )
      .run(SESSION.sessionId);

    await expect(store.getPlacementMoveAsync(SESSION.sessionId)).rejects.toThrow(
      "Invalid worker placement move target: gateway",
    );
  });

  it.each([
    ["gateway", "os-a", "operating system requires a profile target"],
    ["profile", " ", /move operating system/u],
    ["profile", "a".repeat(65), /move operating system/u],
  ] as const)("rejects invalid %s OS %j before creating storage", async (kind, targetOs, error) => {
    const target =
      kind === "gateway" ? { kind, os: targetOs } : { kind, profileId: "cloud", os: targetOs };
    database.db.exec("DROP TABLE worker_session_placement_moves");
    await expect(
      store.beginPlacementMove({
        sessionId: SESSION.sessionId,
        source: { generation: 1, environmentId: "source", ownerEpoch: 1 },
        target,
      }),
    ).rejects.toThrow(error);
    expect(
      database.db
        .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'worker_session_placement_moves'")
        .get(),
    ).toBeUndefined();
  });

  it("keeps invalid move attempts from creating optional storage", async () => {
    database.db.exec("DROP TABLE worker_session_placement_moves");
    const active = await advanceToActive();
    database.db
      .prepare("DELETE FROM worker_environments WHERE environment_id = ?")
      .run(active.environmentId);

    await expect(
      store.beginPlacementMove({
        sessionId: SESSION.sessionId,
        source: sourceFor(active),
        target: { kind: "gateway" },
      }),
    ).rejects.toThrow("Cannot move stale worker environment");
    expect(
      database.db
        .prepare("SELECT 1 AS ok FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("worker_session_placement_moves"),
    ).toBeUndefined();
    expect(store.get(SESSION.sessionId)).toMatchObject({
      state: "active",
      generation: active.generation,
    });
  });

  it.each(["generation", "environment", "epoch"] as const)(
    "Stop retains a Move belonging to a different source %s",
    async (change) => {
      const { active, begun } = await beginGatewayMove();
      const reconciling = await reconcileMove(active, begun.placement.generation);
      // A foreign owner has replaced the intent's source before Stop's final CAS.
      const columns = {
        generation: { name: "source_generation", value: active.generation + 1 },
        environment: { name: "source_environment_id", value: "replacement-environment" },
        epoch: { name: "source_owner_epoch", value: active.activeOwnerEpoch + 1 },
      };
      const column = columns[change];
      database.db
        .prepare(
          `UPDATE worker_session_placement_moves SET ${column.name} = ? WHERE session_id = ?`,
        )
        .run(column.value, SESSION.sessionId);
      const replacement = await store.getPlacementMoveAsync(SESSION.sessionId);

      await expect(
        store.transition({
          sessionId: SESSION.sessionId,
          from: "reconciling",
          to: "reclaimed",
          expectedGeneration: reconciling.generation,
        }),
      ).resolves.toMatchObject({ state: "reclaimed" });
      expect(await store.getPlacementMoveAsync(SESSION.sessionId)).toEqual(replacement);
    },
  );

  it("fences move errors and Gateway completion by operation id", async () => {
    const { active, begun } = await beginGatewayMove();

    await expect(
      store.cancelPlacementMove({
        operationId: begun.intent.operationId,
        sessionId: SESSION.sessionId,
        expectedLocalGeneration: begun.placement.generation,
      }),
    ).resolves.toBe(false);
    expect(await store.getPlacementMoveAsync(SESSION.sessionId)).toEqual(begun.intent);

    const observed: Array<Promise<string | null | undefined>> = [];
    onTestFinished(
      sessionChanges.subscribe((change) => {
        if ("all" in change && change.scope === "worker-placements") {
          observed.push(
            store.getPlacementMoveAsync(SESSION.sessionId).then((move) => move?.lastError),
          );
        }
      }),
    );
    expect(
      await store.recordPlacementMoveError({
        operationId: "move:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        sessionId: SESSION.sessionId,
        error: "stale move failed",
      }),
    ).toBe(false);
    expect(observed).toEqual([]);
    expect(
      await store.recordPlacementMoveError({
        operationId: begun.intent.operationId,
        sessionId: SESSION.sessionId,
        error: "workspace reconciliation is waiting",
      }),
    ).toBe(true);
    expect((await store.getPlacementMoveAsync(SESSION.sessionId))?.lastError).toBe(
      "workspace reconciliation is waiting",
    );
    expect(await Promise.all(observed)).toEqual(["workspace reconciliation is waiting"]);

    const reconciling = await reconcileMove(active, begun.placement.generation);
    await expect(
      store.completePlacementMoveSourceToLocal({
        operationId: "move:v1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        sessionId: SESSION.sessionId,
        expectedGeneration: reconciling.generation,
      }),
    ).rejects.toThrow("placement move changed before completion");

    expect(
      await store.completePlacementMoveSourceToLocal({
        operationId: begun.intent.operationId,
        sessionId: SESSION.sessionId,
        expectedGeneration: reconciling.generation,
      }),
    ).toMatchObject({ state: "local", generation: reconciling.generation + 1 });
    expect(await store.getPlacementMoveAsync(SESSION.sessionId)).toBeUndefined();
    expect(await Promise.all(observed)).toEqual(["workspace reconciliation is waiting", undefined]);
  });

  it("completes a worker move only against the exact attached destination", async () => {
    const source = await seedActiveEnvironment();
    const begun = await store.beginPlacementMove({
      sessionId: SESSION.sessionId,
      source: sourceFor(source),
      target: {
        kind: "profile",
        profileId: "profile-destination",
        machineClass: "beast",
        os: "os-a",
      },
    });
    const reconciling = await reconcileMove(source, begun.placement.generation);
    const local = await store.completePlacementMoveSourceToLocal({
      operationId: begun.intent.operationId,
      sessionId: SESSION.sessionId,
      expectedGeneration: reconciling.generation,
    });
    expect(await store.getPlacementMoveAsync(SESSION.sessionId)).toEqual(begun.intent);
    database.db
      .prepare(
        "UPDATE worker_environments SET state = 'destroyed', attached_session_ids_json = '[]'",
      )
      .run();
    const destination = await advanceToActive();
    database.db
      .prepare(
        `UPDATE worker_environments
         SET state = 'attached', profile_id = ?, owner_epoch = ?, attached_session_ids_json = ?
         WHERE environment_id = ?`,
      )
      .run(
        "profile-destination",
        destination.activeOwnerEpoch,
        JSON.stringify([destination.sessionId]),
        destination.environmentId,
      );
    expect(destination.generation).toBeGreaterThan(local.generation);

    expect(
      await store.completePlacementMoveToWorker({
        operationId: begun.intent.operationId,
        sessionId: SESSION.sessionId,
        expectedGeneration: destination.generation,
        environmentId: destination.environmentId,
        ownerEpoch: destination.activeOwnerEpoch,
      }),
    ).toMatchObject({ state: "active", generation: destination.generation });
    expect(await store.getPlacementMoveAsync(SESSION.sessionId)).toBeUndefined();
  });

  it("completes a persisted abandonment only after a later sweep makes its placement local", async () => {
    const { active, begun } = await beginGatewayMove(true);
    const reconciling = await reconcileMove(active, begun.placement.generation);
    const recoveryError = "Worker result abandoned by forced operator teardown";
    const failed = await store.fail({
      sessionId: active.sessionId,
      expectedGeneration: reconciling.generation,
      recoveryError,
    });
    const abandonSource = vi
      .fn()
      .mockRejectedValueOnce(new Error("device teardown is still pending"))
      .mockImplementationOnce(
        async () =>
          await store.completeAbandonedPlacementMoveSourceToLocal({
            operationId: begun.intent.operationId,
            sessionId: active.sessionId,
            expectedGeneration: failed.generation,
            expectedRecoveryError: recoveryError,
          }),
      );
    const moves = createWorkerPlacementMoveService({
      placements: store,
      environments: { get: () => undefined },
      runMoveBarrier: async ({ begin }) => begin(),
      dispatch: vi.fn(),
      reclaimSource: vi.fn(),
      validateAbandonSource: vi.fn(),
      abandonSource,
      resolveDestination: vi.fn(),
    });

    await moves.recoverSession(await store.readProjection([active.sessionId], { current: true }));

    expect(store.get(active.sessionId)).toEqual(failed);
    expect((await store.getPlacementMoveAsync(active.sessionId))?.lastError).toBe(
      "device teardown is still pending",
    );
    await moves.recoverSession(await store.readProjection([active.sessionId], { current: true }));

    expect(store.get(active.sessionId)).toMatchObject({
      sessionId: active.sessionId,
      state: "local",
      generation: failed.generation + 1,
    });
    expect(await store.getPlacementMoveAsync(active.sessionId)).toBeUndefined();
    expect(abandonSource).toHaveBeenCalledTimes(2);
  });

  it("completes an ordinary reconciled move with one durable Gateway placement", async () => {
    const { active, begun } = await beginGatewayMove();
    const reconciling = await reconcileMove(active, begun.placement.generation);
    const moves = createWorkerPlacementMoveService({
      placements: store,
      environments: { get: () => undefined },
      runMoveBarrier: async ({ begin }) => begin(),
      dispatch: vi.fn(),
      reclaimSource: vi.fn(),
      validateAbandonSource: vi.fn(),
      abandonSource: vi.fn(),
      resolveDestination: vi.fn(),
    });

    await moves.recoverSession(await store.readProjection([active.sessionId], { current: true }));

    const recovered = store.get(active.sessionId);
    expect(recovered).toMatchObject({ state: "local", generation: reconciling.generation + 1 });
    expect(await store.getPlacementMoveAsync(active.sessionId)).toBeUndefined();
    await moves.recoverSession(await store.readProjection([active.sessionId], { current: true }));
    expect(store.get(active.sessionId)).toEqual(recovered);
  });

  it("fails a pending profile move after restart loses request authority", async () => {
    const source = await seedActiveEnvironment();
    const begun = await store.beginPlacementMove({
      sessionId: source.sessionId,
      source: sourceFor(source),
      target: {
        kind: "profile",
        profileId: "profile-destination",
        machineClass: "beast",
        os: "os-a",
      },
    });
    const reconciling = await reconcileMove(source, begun.placement.generation);
    const local = await store.completePlacementMoveSourceToLocal({
      operationId: begun.intent.operationId,
      sessionId: source.sessionId,
      expectedGeneration: reconciling.generation,
    });
    const dispatch = vi.fn();
    const reclaimSource = vi.fn(async () => {
      throw new Error("failed destination must not reclaim the old source");
    });
    const restartedStore = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    const moves = createWorkerPlacementMoveService({
      placements: restartedStore,
      environments: { get: () => undefined },
      runMoveBarrier: async ({ begin }) => begin(),
      dispatch,
      reclaimSource,
      validateAbandonSource: vi.fn(),
      abandonSource: vi.fn(async () => {
        throw new Error("unexpected source abandonment");
      }),
      resolveDestination: async (_identity, target) => {
        if (target.kind !== "profile") {
          throw new Error("expected profile move target");
        }
        return {
          profileId: target.profileId,
          executionMode: "worker-turn",
          machineClass: target.machineClass,
          os: target.os,
        };
      },
    });

    await moves.recoverSession(
      await restartedStore.readProjection([source.sessionId], { current: true }),
    );

    expect(reclaimSource).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(restartedStore.get(source.sessionId)).toMatchObject({
      state: "failed",
      generation: local.generation + 1,
      recoveryError:
        "Cloud worker move request authority expired after Gateway restart; retry move",
    });
    expect(await restartedStore.getPlacementMoveAsync(source.sessionId)).toBeUndefined();
  });
});
