import { describe, expect, it, vi } from "vitest";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import type { WorkerLeaseRecoveryHold } from "../../plugins/types.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";

describe("unused prepared worker custody", () => {
  support.setupWorkerEnvironmentServiceSuite();

  async function reserve(environmentId: string) {
    const store = support.testState.store;
    await store.createIntent({
      environmentId,
      providerId: "fake",
      profileId: "development",
      provisionOperationId: `provision:${environmentId}`,
      profileSnapshot: {
        executionMode: "remote-exec",
        settings: {},
        project: { key: "a".repeat(64), root: support.testState.root, baseCommit: "c".repeat(40) },
      },
      preparation: {
        purpose: "reserve",
        key: "b".repeat(64),
        demandAtMs: support.testState.nowMs,
        expiresAtMs: support.testState.nowMs + 10_000,
      },
    });
    await store.transition({ environmentId, from: "requested", to: "provisioning" });
    const ready = await store.transition({
      environmentId,
      from: "provisioning",
      to: "ready",
      patch: {
        ...support.readyPatch(environmentId),
        leaseId: `lease:${environmentId}`,
        nodeDeviceId: `node:${environmentId}`,
        sharedHost: false,
      },
    });
    return store.requestPreparedDestroy({
      environmentId,
      ownerEpoch: ready.ownerEpoch,
      preparationKey: ready.preparation!.key,
      reason: "invalidated",
      assertCurrent: () => {},
    });
  }

  const receipt = (leaseId: string): WorkerLeaseRecoveryHold => ({
    status: "held",
    leaseId,
    unacceptedChanges: "unknown",
    resources: [
      { kind: "vm", id: "/retained/vm", state: "absent" },
      { kind: "disk", id: "/retained/disk", immutableId: "original-disk", state: "retained" },
      { kind: "nic", id: "/retained/nic", immutableId: "original-nic", state: "retained" },
    ],
  });

  it("post-RCA cleanup automatically disposes exact unused prepared custody through ordinary pool maintenance", async () => {
    await reserve("failed-reserve");
    const destroy = vi.fn(async () => {});
    const holdFailedLease = vi.fn(async ({ leaseId }: { leaseId: string }) => receipt(leaseId));
    const service = support.createService(
      support.createProvider({
        inspect: async () => ({ status: "unknown" }),
        destroy,
        holdFailedLease,
      }),
    );
    await service.setHumanPresence(false);
    expect(holdFailedLease).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
    const held = service.get("failed-reserve")!.recoveryHold!;
    expect(held).toMatchObject({
      kind: "prepared",
      phase: "held",
      diagnostic: { origin: "unused-prepared-worker", cause: "unverified" },
    });
    expect(held.sessionId).toBeUndefined();
    await service.setHumanPresence(false);
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "lease:failed-reserve" }),
    );
    expect(service.get("failed-reserve")).toMatchObject({
      state: "destroyed",
      recoveryHold: {
        receipt: held.receipt,
        diagnostic: held.diagnostic,
        cleanup: { settledAtMs: expect.any(Number) },
      },
    });
    expect(support.testState.store.getCredential("failed-reserve")).toBeUndefined();
    await service.setHumanPresence(false);
    expect(destroy).toHaveBeenCalledOnce();
    expect(support.testState.store.preparedReservationEnvironmentIds()).toEqual([]);
    await service.stop();
    const settledHold = support.testState.store.get("failed-reserve")!.recoveryHold!;
    const originalHoldJson = support.testState.stateDb.db
      .prepare("SELECT hold_json FROM worker_environment_recovery_holds WHERE environment_id = ?")
      .get("failed-reserve")!.hold_json!;
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        db.prepare(
          "UPDATE worker_environment_recovery_holds SET hold_json = ? WHERE environment_id = ?",
        ).run(
          JSON.stringify({
            ...settledHold,
            cleanup: { ...settledHold.cleanup, settledAtMs: "unverified" },
          }),
          "failed-reserve",
        );
      },
      { database: support.testState.stateDb },
    );
    await support.reopenWorkerEnvironmentStore();
    const prune = () =>
      support.testState.store.pruneTerminalEnvironments({
        nowMs: support.testState.nowMs + 8 * 24 * 60 * 60 * 1_000,
        canPruneDemand: () => true,
      });
    expect(await prune()).toBe(0);
    expect(support.testState.store.get("failed-reserve")?.state).toBe("destroyed");
    expect(
      support.testState.stateDb.db
        .prepare("SELECT hold_json FROM worker_environment_recovery_holds WHERE environment_id = ?")
        .get("failed-reserve"),
    ).toBeDefined();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        db.prepare(
          "UPDATE worker_environment_recovery_holds SET hold_json = ? WHERE environment_id = ?",
        ).run(originalHoldJson, "failed-reserve");
      },
      { database: support.testState.stateDb },
    );
    expect(await prune()).toBe(1);
    expect(support.testState.store.get("failed-reserve")).toBeUndefined();
  });

  it("keeps existing custody while a full retained budget retries exact teardown through restart", async () => {
    support.testState.config.cloudWorkers!.preparedPool = { maxTotal: 3 };
    for (const id of ["stale-a", "stale-b", "stale-c"]) {
      await reserve(id);
    }
    const destroy = vi.fn(async (): Promise<void> => {
      throw new Error("orphan cleanup refused: NIC still exists");
    });
    const holdFailedLease = vi.fn(async ({ leaseId }: { leaseId: string }) => {
      const id = leaseId.slice("lease:".length);
      expect(support.testState.store.get(id)).toMatchObject({
        state: "orphaned",
        recoveryHold: { kind: "prepared", phase: "requested" },
      });
      expect(support.testState.store.getCredential(id)).toBeUndefined();
      return receipt(leaseId);
    });
    const service = support.createService(
      support.createProvider({
        inspect: async () => {
          throw new Error("Crabbox inspect failed: Azure VM ResourceNotFound (404)");
        },
        destroy,
        holdFailedLease,
      }),
    );
    await service.setHumanPresence(false);
    expect(holdFailedLease).toHaveBeenCalledTimes(3);
    expect(destroy).not.toHaveBeenCalled();
    expect(service.readPreparedPoolSummary()).toEqual({ maxTotal: 3, reservedEnvironmentIds: [] });
    for (const id of ["stale-a", "stale-b", "stale-c"]) {
      expect(support.testState.store.get(id)).toMatchObject({
        state: "orphaned",
        leaseId: `lease:${id}`,
        recoveryHold: { kind: "prepared", phase: "held", receipt: receipt(`lease:${id}`) },
      });
    }
    await service.stop();
    await support.reopenWorkerEnvironmentStore();
    expect(support.testState.store.list()).toHaveLength(3);
    expect(support.testState.store.preparedReservationEnvironmentIds()).toEqual([]);
    const store = support.testState.store;
    const fresh = await store.ensurePreparedIntent({
      intent: {
        environmentId: "fresh",
        providerId: "fake",
        profileId: "development",
        provisionOperationId: "provision:fresh",
        profileSnapshot: {
          executionMode: "remote-exec",
          settings: {},
          project: {
            key: "a".repeat(64),
            root: support.testState.root,
            baseCommit: "c".repeat(40),
          },
        },
        preparation: {
          purpose: "reserve",
          key: "b".repeat(64),
          demandAtMs: 1_000,
          expiresAtMs: 11_000,
        },
      },
      projectKey: "a".repeat(64),
      target: 3,
      maxTotal: 3,
      assertCurrent: () => {},
    });
    expect(fresh).toBeDefined();
    await store.transition({ environmentId: "fresh", from: "requested", to: "provisioning" });
    const ready = await store.transition({
      environmentId: "fresh",
      from: "provisioning",
      to: "ready",
      patch: {
        ...support.readyPatch("fresh"),
        leaseId: "lease:fresh",
        nodeDeviceId: "node:fresh",
        sharedHost: false,
      },
    });
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const identity = {
      sessionId: "fresh-session",
      sessionKey: "agent:main:fresh-session",
      agentId: "main",
      executionMode: "remote-exec" as const,
    };
    const requested = await placements.startDispatch(identity);
    expect(
      await placements.bindPreparedEnvironment({
        ...identity,
        expectedGeneration: requested.generation,
        environmentId: "fresh",
        ownerEpoch: ready.ownerEpoch,
        providerId: "fake",
        profileId: "development",
        preparationKey: "b".repeat(64),
        nodeDeviceId: "node:fresh",
        leaseId: "lease:fresh",
        bundleHash: support.BUNDLE_HASH,
        assertCurrent: () => {},
      }),
    ).toBeDefined();
    expect(store.get("fresh")?.preparation?.consumedAtMs).not.toBeNull();
    await reserve("fourth");
    const restarted = support.createService(
      support.createProvider({
        inspect: async () => {
          throw new Error("Crabbox inspect failed: Azure VM ResourceNotFound (404)");
        },
        destroy,
        holdFailedLease,
      }),
    );
    await restarted.reconcileOnce("fourth");
    expect(holdFailedLease).toHaveBeenCalledTimes(3);
    expect(support.testState.store.get("fourth")?.recoveryHold).toBeUndefined();
    expect(support.testState.store.preparedReservationEnvironmentIds()).toEqual(["fourth"]);
    expect(destroy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ leaseId: "lease:fourth" }),
    );
    expect(support.testState.store.get("fourth")).toMatchObject({
      destroyRequestedAtMs: expect.any(Number),
      lastError: "orphan cleanup refused: NIC still exists",
    });
    await restarted.stop();
    await support.reopenWorkerEnvironmentStore();
    destroy.mockResolvedValue(undefined);
    const finalizing = support.createService(
      support.createProvider({
        inspect: async () => ({ status: "unknown" }),
        destroy,
        holdFailedLease,
      }),
    );
    await finalizing.reconcileOnce("fourth");
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(support.testState.store.get("fourth")?.state).toBe("destroyed");
    expect(support.testState.store.preparedReservationEnvironmentIds()).toEqual([]);
    for (const id of ["stale-a", "stale-b", "stale-c"]) {
      expect(support.testState.store.get(id)).toMatchObject({
        state: "orphaned",
        recoveryHold: { phase: "held", receipt: receipt(`lease:${id}`) },
      });
    }
    await finalizing.reconcileOnce("fourth");
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(holdFailedLease).toHaveBeenCalledTimes(3);
  });

  it("preserves a populated predecessor session hold and metadata during first-use migration", async () => {
    const original = await reserve("original");
    const hold = JSON.stringify({
      environmentId: "original",
      ownerEpoch: original!.ownerEpoch,
      leaseId: "lease:original",
      sessionId: "original-session",
      sessionKey: "agent:main:original",
      agentId: "main",
      executionMode: "remote-exec",
      placementGeneration: 56,
      phase: "held",
      createdAtMs: 1_000,
      receipt: receipt("lease:original"),
      checkpointRef: "refs/openclaw/worker-results/accepted",
    });
    const db = support.testState.stateDb.db;
    const metadata = db.prepare("SELECT * FROM schema_meta").all();
    db.exec("DROP TABLE worker_environment_recovery_holds;");
    db.exec(
      extractSqliteTableSchema(
        OPENCLAW_STATE_SCHEMA_SQL,
        "worker_environment_recovery_holds",
      ).replace("session_id TEXT UNIQUE", "session_id TEXT NOT NULL UNIQUE"),
    );
    db.prepare("INSERT INTO worker_environment_recovery_holds VALUES (?, ?, ?)").run(
      "original",
      "original-session",
      hold,
    );
    await support.reopenWorkerEnvironmentStore();
    const reopened = support.testState.stateDb.db;
    expect(reopened.prepare("SELECT * FROM schema_meta").all()).toEqual(metadata);
    expect(
      reopened.prepare("SELECT hold_json FROM worker_environment_recovery_holds").get()?.hold_json,
    ).toBe(hold);
    expect(
      reopened
        .prepare("PRAGMA table_info(worker_environment_recovery_holds)")
        .all()
        .find((column) => column.name === "session_id")?.notnull,
    ).toBe(0);
    expect(support.testState.store.get("original")?.recoveryHold).toEqual(JSON.parse(hold));
  });

  it.each([
    "confirmation lost",
    "VM still exists",
    "authorization denied",
    "wrong lease",
    "shutdown",
  ])("keeps %s confirmation charged until exact cleanup after restart", async (failure) => {
    await reserve("uncertain");
    let stopping: Promise<void> | undefined;
    const holdFailedLease = vi.fn(async ({ leaseId }: { leaseId: string }) => {
      if (failure === "wrong lease") {
        return receipt("unexpected-lease");
      }
      if (failure === "shutdown") {
        stopping = service.stop();
        return receipt(leaseId);
      }
      throw new Error(failure);
    });
    const destroy = vi.fn(async () => {});
    const service = support.createService(
      support.createProvider({
        inspect: async () => {
          throw new Error("Crabbox inspect failed: Azure VM ResourceNotFound (404)");
        },
        holdFailedLease,
        destroy,
      }),
    );
    await service.reconcileOnce("uncertain");
    expect(support.testState.store.get("uncertain")).toMatchObject({
      state: "orphaned",
      recoveryHold: { kind: "prepared", phase: "requested" },
    });
    expect(support.testState.store.preparedReservationEnvironmentIds()).toEqual(["uncertain"]);
    expect(holdFailedLease).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
    await stopping;
    await service.stop();
    await support.reopenWorkerEnvironmentStore();
    const confirm = vi.fn(async ({ leaseId }: { leaseId: string }) => receipt(leaseId));
    await support
      .createService(support.createProvider({ holdFailedLease: confirm, destroy }))
      .reconcileOnce("uncertain");
    expect(confirm).not.toHaveBeenCalled();
    expect(support.testState.store.preparedReservationEnvironmentIds()).toEqual([]);
    expect(destroy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ leaseId: "lease:uncertain" }),
    );
    expect(support.testState.store.get("uncertain")).toMatchObject({
      state: "destroyed",
      recoveryHold: {
        diagnostic: { origin: "unused-prepared-worker" },
        cleanup: { providerReleasedAtMs: expect.any(Number), settledAtMs: expect.any(Number) },
      },
    });
  });
});
