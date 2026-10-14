import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
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
    clearRuntimeConfigSnapshot();
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

  it.each(["generation"] as const)(
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
    setRuntimeConfigSnapshot({});
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
    setRuntimeConfigSnapshot({});
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
