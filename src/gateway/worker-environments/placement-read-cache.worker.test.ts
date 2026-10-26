import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { createWorkerPlacementDiskSpaceMonitor } from "./placement-disk-space.js";
import { placementTurnOwner } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { sessionIdentity } from "./placement-suite.test-support.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import { capturePlacementReplicaRead } from "./placement-turn-authority.js";

const roots = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await drainGlobalSingletonLifecycleState();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  }),
);

let database: OpenClawStateDatabase;
let reader: ReturnType<typeof createWorkerSessionPlacementStore>;
let writer: ReturnType<typeof createWorkerSessionPlacementStore>;
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("placement-read-cache-"));
  database = openOpenClawStateDatabase();
  reader = createWorkerSessionPlacementStore({ database });
  writer = createWorkerSessionPlacementStore({ database });
});

describe("worker placement read cache", () => {
  it("keeps the syncing owner when a read captured during commit returns its older snapshot", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("placement-pending-replica-"));
    const snapshotDatabase = openOpenClawStateDatabase();
    const store = createWorkerSessionPlacementStore({ database: snapshotDatabase });
    const identity = { sessionId: "dispatch", agentId: "main", sessionKey: "agent:main:dispatch" };
    const requested = await store.startDispatch(identity);
    const provisioning = await store.transition({
      sessionId: identity.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: requested.generation,
      patch: { environmentId: "dispatch-environment" },
    });
    const snapshot = await store.readProjection([identity.sessionId], { current: true });
    const databaseIdentity = requireOpenClawStateDatabaseIdentity({ db: snapshotDatabase.db });
    let publishRead: ReturnType<typeof capturePlacementReplicaRead> | undefined;
    const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementationOnce(
      (admit, attachment) =>
        createAdmission((request, grant) => {
          admit(request, () => {
            if (request.stage === "commit") {
              // The publication has reserved its sequence, but SQLite has not committed yet.
              publishRead = capturePlacementReplicaRead(databaseIdentity);
            }
            return grant();
          });
        }, attachment),
    );
    const syncing = await store.transition({
      sessionId: identity.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: provisioning.generation,
      patch: { workerBundleHash: "a".repeat(64) },
    });
    expect(store.get(identity.sessionId)).toEqual(syncing);
    expect(publishRead).toBeTypeOf("function");
    publishRead!(snapshot.placements.values(), [identity.sessionId]);
    expect(store.get(identity.sessionId)).toEqual(syncing);
  });

  it("reuses empty recovery candidates and sees committed work across stores", async () => {
    const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const recoveryReadCount = () =>
      reads.mock.calls.filter(
        ([, command]) => command.type === "workers.placementRecoveryCandidates",
      ).length;

    expect(await reader.readRecoveryCandidates()).toEqual([]);
    expect(await writer.readRecoveryCandidates()).toEqual([]);
    expect(recoveryReadCount()).toBe(1);

    const local = sessionIdentity("recovery-local");
    const claim = await writer.claimTurn({
      ...local,
      owner: { kind: "local" },
      claimId: "local-claim",
      runId: "local-run",
    });
    expect(await reader.readRecoveryCandidates()).toEqual([]);
    await writer.releaseTurnIfOwned(claim);
    expect(await reader.readRecoveryCandidates()).toEqual([]);
    await writer.retireSessionPlacementAsync({
      sessionId: local.sessionId,
      expectedState: "local",
      expectedGeneration: claim.placementGeneration,
    });
    expect(await reader.readRecoveryCandidates()).toEqual([]);
    expect(recoveryReadCount()).toBe(1);

    const remote = await writer.startDispatch(local);
    const expected = [{ sessionId: remote.sessionId, environmentId: null, state: "requested" }];
    expect(await reader.readRecoveryCandidates()).toEqual(expected);
    expect(await reader.readRecoveryCandidates()).toEqual(expected);
    expect(recoveryReadCount()).toBe(3);

    await writer.retireSessionPlacementAsync({
      sessionId: remote.sessionId,
      expectedState: "requested",
      expectedGeneration: remote.generation,
    });
    expect(await reader.readRecoveryCandidates()).toEqual([]);
    expect(await writer.readRecoveryCandidates()).toEqual([]);
    expect(recoveryReadCount()).toBe(4);
  });

  it("returns overlapping recovery snapshots without caching an invalidated empty result", async () => {
    const captured = createDeferred();
    const release = createDeferred();
    const execute = stateReads.executeExistingOpenClawStateRead;
    let hold = true;
    vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementation(async (...args) => {
      const result = await execute(...args);
      if (args[1].type === "workers.placementRecoveryCandidates" && hold) {
        hold = false;
        captured.resolve();
        await release.promise;
      }
      return result;
    });

    const reading = reader.readRecoveryCandidates();
    try {
      await awaitGateBeforeSettlement(captured.promise, reading, "recovery snapshot");
      const remote = await writer.startDispatch(sessionIdentity("overlapping-recovery"));
      release.resolve();
      await expect(reading).resolves.toEqual([]);
      expect(await reader.readRecoveryCandidates()).toEqual([
        { sessionId: remote.sessionId, environmentId: null, state: "requested" },
      ]);
    } finally {
      release.resolve();
      await Promise.allSettled([reading]);
    }
  });

  it("reuses the disk sweep inventory and observes committed placement transitions", async () => {
    const runWorkspaceCommand = vi.fn(async () =>
      createCommandResult({
        stdout: JSON.stringify({ availableBytes: "6000000000", totalBytes: "10000000000" }),
      }),
    );
    const unexpected = async () => {
      throw new Error("unexpected workspace mutation during a disk probe");
    };
    const warn = vi.fn();
    const monitor = createWorkerPlacementDiskSpaceMonitor({
      placements: reader,
      environments: {
        startTunnel: async ({ environmentId, ownerEpoch }) => ({
          environmentId,
          ownerEpoch,
          runWorkspaceCommand,
          quiesceWorkspace: unexpected,
          syncWorkspace: unexpected,
          reconcileWorkspace: unexpected,
          stop: async () => {},
        }),
      },
      runnerAvailability: { read: () => undefined, version: () => 0 },
      warn,
    });
    const unsubscribe = reader.subscribeChanges(() => monitor.invalidate());
    try {
      await monitor.sweep();
      const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
      await monitor.sweep();
      expect(reads).not.toHaveBeenCalled();
      expect(runWorkspaceCommand).not.toHaveBeenCalled();

      const active = await advancePlacementFixtureToActive(
        writer,
        database,
        sessionIdentity("disk-cache"),
      );
      await monitor.sweep();
      expect(runWorkspaceCommand).toHaveBeenCalledOnce();
      expect(monitor.read(active)?.status).toBe("ok");

      const draining = await writer.transition({
        sessionId: active.sessionId,
        from: "active",
        to: "draining",
        expectedGeneration: active.generation,
      });
      await monitor.sweep();
      expect(monitor.read(draining)).toBeUndefined();
      expect(runWorkspaceCommand).toHaveBeenCalledOnce();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("claims and releases an existing worker placement with a NULL execution mode", async () => {
    const store = writer;
    const identity = sessionIdentity("legacy");
    const active = await advancePlacementFixtureToActive(store, database, identity, {
      environmentId: "legacy-environment",
    });
    database.db
      .prepare("UPDATE worker_session_placements SET execution_mode = NULL WHERE session_id = ?")
      .run(identity.sessionId);
    const claim = await store.claimTurn({
      ...identity,
      owner: placementTurnOwner(active),
      claimId: "legacy-claim",
      runId: "legacy-run",
    });
    expect((await store.getAsync(identity.sessionId))?.turnClaim?.claimId).toBe("legacy-claim");
    await store.releaseTurnIfOwned(claim);
    expect((await store.getAsync(identity.sessionId))?.turnClaim).toBeNull();
  });

  it.each([false, true])(
    "observes local claim receipts with a preloaded projection: %s",
    async (preloaded) => {
      const identity = sessionIdentity("local");
      const read = async (store = reader) =>
        (await store.readProjection([identity.sessionId])).placements.get(identity.sessionId)!;
      if (preloaded) {
        expect((await reader.readProjection([identity.sessionId])).placements.size).toBe(0);
      }
      const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
      const claim = await writer.claimTurn({
        ...identity,
        owner: { kind: "local" },
        claimId: "claim",
        runId: "run",
      });
      const claimed = await read();
      expect(claimed.turnClaim?.claimId).toBe("claim");
      // Borrowed owner facts reject both placement and nested claim mutation.
      const warm = await read();
      expect(Reflect.set(warm, "state", "requested")).toBe(false);
      expect(Reflect.set(warm.turnClaim!, "claimId", "caller-change")).toBe(false);
      expect(await read(writer)).toMatchObject({ state: "local", turnClaim: { claimId: "claim" } });
      await writer.releaseTurnIfOwned(claim);
      expect(await read()).toMatchObject({ state: "local", turnClaim: null });
      expect(reads).toHaveBeenCalledTimes(preloaded ? 0 : 1);
      // A committed replacement leaves the earlier snapshot intact.
      expect(claimed.turnClaim?.claimId).toBe("claim");
      expect(Reflect.set(claimed, "state", "requested")).toBe(false);
      expect((await read()).state).toBe("local");
    },
  );

  it("updates prepared preservation from non-local writer receipts", async () => {
    const initial = await reader.prepareMaintenancePlacements();
    initial.release();
    const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const claim = await writer.claimTurn({
      ...sessionIdentity("local"),
      owner: { kind: "local" },
      claimId: "claim",
      runId: "run",
    });
    await writer.releaseTurnIfOwned(claim);
    const unchanged = await reader.prepareMaintenancePlacements();
    expect(unchanged.placements).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
    const remote = await writer.startDispatch(sessionIdentity("remote"));
    expect(unchanged.placements).toEqual([remote]);
    unchanged.assertCurrent();
    unchanged.release();
    const changed = await reader.prepareMaintenancePlacements();
    expect(changed.placements).toEqual([remote]);
    const callerSnapshot = changed.placements;
    callerSnapshot[0]!.sessionKey = "caller-change";
    callerSnapshot.length = 0;
    expect(changed.placements).toEqual([remote]);
    changed.assertCurrent();
    changed.release();
    expect(() => changed.placements).toThrow();
    expect(
      reads.mock.calls.filter(([, command]) => command.type === "workers.placementPreservation"),
    ).toHaveLength(1);
  });
});
