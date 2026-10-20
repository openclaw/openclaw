import assert from "node:assert/strict";
import fs from "node:fs";
import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, test, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { sqliteReaderDatabasePathKey } from "../../infra/sqlite-reader-lifecycle.js";
import * as walCheckpoint from "../../infra/sqlite-wal-checkpoint.js";
import { observeSqliteWalPeriodicWork } from "../../infra/sqlite-wal-scheduler.test-support.js";
import { configureSqliteWalMaintenance } from "../../infra/sqlite-wal.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { closeCachedOpenClawAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { drainAgentDatabaseResources } from "../../state/openclaw-agent-db-resources.js";
import * as agentDb from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { withSqliteSessionPageReclamation } from "./session-accessor.sqlite-page-reclamation.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import { createLifecycleArtifactReclamationPlan } from "./session-accessor.sqlite-reclamation.js";
import * as sessionScope from "./session-accessor.sqlite-scope.js";
import {
  deferPhysicalBudgetForCheckpoint,
  getBudgetKickState,
} from "./session-history-budget-state.js";

const tempDirs = useSessionStoreTempDirs(afterEach, "openclaw-reclamation-wal-");

function createFixture() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make() };
  const options = { agentId: "main", env };
  const database = agentDb.openOpenClawAgentDatabase(options);
  return {
    database,
    databaseOptions: { ...options, path: database.path },
    freePages: () => Number(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count),
  };
}

function targetsDatabase(facts: unknown, pathKey: string) {
  return (
    isRecord(facts) &&
    isRecord(facts.identity) &&
    typeof facts.identity.nativeLocation === "string" &&
    sqliteReaderDatabasePathKey(facts.identity.nativeLocation) === pathKey
  );
}

function expectReclaimed(pages: number, limit: number) {
  expect(pages).toBeGreaterThan(0);
  expect(pages).toBeLessThanOrEqual(limit);
}

test.each(["reclaim", "resource-close", "shared-state-close"] as const)(
  "reclaims pages off-thread and applies current checkpoint receipts (%s)",
  async (recovery) => {
    const { database, databaseOptions, freePages } = createFixture();
    const databasePathKey = sqliteReaderDatabasePathKey(database.path);
    database.db.exec(`INSERT INTO cache_entries(scope, key, blob, updated_at)
    VALUES ('wal-proof', 'pages', zeroblob(4194304), 1);
    DELETE FROM cache_entries WHERE scope = 'wal-proof';`);
    expect(database.walMaintenance.checkpoint()).toBe(true);
    const { DatabaseSync } = requireNodeSqlite();
    using reader = new DatabaseSync(database.path, { readOnly: true });
    using parentReclaim = vi.spyOn(database.walMaintenance, "reclaimFreePages");
    const ordering: string[] = [];
    const maintenance = { maxDiskBytes: 1, highWaterBytes: 1 };
    const params = { storePath: database.path, mode: "enforce" as const, maintenance };
    const budget = getBudgetKickState(params.storePath, params.maintenance);
    let commitRequestedAtNs: bigint | undefined;
    const observeAdmission = probe.admission(workerAdmission, (request, grant, admit) => {
      if (request.stage === "commit" && targetsDatabase(request.facts, databasePathKey)) {
        commitRequestedAtNs = process.hrtime.bigint();
      }
      admit(request, grant);
    });
    let completedAt: number | undefined;
    const relayedCompletions: number[] = [];
    const publish = walCheckpoint.publishSqliteWalCheckpointObservation;
    const relay = vi
      .spyOn(walCheckpoint, "publishSqliteWalCheckpointObservation")
      .mockImplementation((databasePath, snapshot) => {
        if (
          sqliteReaderDatabasePathKey(databasePath) !== databasePathKey ||
          snapshot.health.state !== "complete" ||
          completedAt === undefined
        ) {
          return publish(databasePath, snapshot);
        }
        relayedCompletions.push(completedAt);
        const at = completedAt;
        const health = { ...snapshot.health, observedAtMs: at, lastCompletedAtMs: at };
        return publish(databasePath, { ...snapshot, health });
      });
    let following: Promise<void> | undefined;
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT COUNT(*) FROM cache_entries").get();
      database.db.exec(`INSERT INTO cache_entries(scope, key, blob, updated_at)
      VALUES ('wal-proof', 'live', X'72657461696E6564', 1);`);
      const original = freePages();
      await withSqliteSessionPageReclamation(databaseOptions, (reclaim) =>
        sessionScope.runExclusiveSqliteSessionWrite(
          databaseOptions,
          async () => {
            ordering.push("archive-start");
            following = sessionScope.runExclusiveSqliteSessionWrite(
              databaseOptions,
              async () => void ordering.push("following-writer"),
              "session.transcript.batch",
            );
            const blocked = await reclaim();
            expect(blocked).toMatchObject({ checkpointCompleted: false, checkpointIncomplete: 1 });
            expect(blocked.checkpoint?.health.state).toBe("blocked");
            expect(blocked.vacuumPasses).toBe(0);
            expect(freePages()).toBe(original);
            deferPhysicalBudgetForCheckpoint(params, database.path, blocked.checkpoint);
            assert(blocked.checkpoint);
            completedAt = blocked.checkpoint.health.observedAtMs - 1;
            if (recovery === "reclaim") {
              reader.exec("ROLLBACK");
              const done = await reclaim(7);
              expect(done).toMatchObject({ checkpointCompleted: true, checkpointIncomplete: 0 });
              expect(done).toMatchObject({ vacuumPasses: 1, vacuumPagesRequested: 7 });
              assert(commitRequestedAtNs !== undefined);
              assert(done.checkpoint);
              expect(done.checkpoint.observedAtNs).toBeGreaterThanOrEqual(commitRequestedAtNs);
              expectReclaimed(original - freePages(), 7);
            }
            expect(ordering).toEqual(["archive-start"]);
            ordering.push("archive-complete");
          },
          "session.history.archive-prune",
        ),
      );
      await following;
      expect(ordering).toEqual(["archive-start", "archive-complete", "following-writer"]);
      expect(parentReclaim).not.toHaveBeenCalled();
      if (recovery !== "reclaim") {
        closeCachedOpenClawAgentDatabase(database);
        expect(database.db.isOpen).toBe(false);
        const deferredCheckpoint = budget.checkpointBlocked;
        assert(deferredCheckpoint);
        const observed: string[] = [];
        const unsubscribe = walCheckpoint.onSqliteWalCheckpoint(({ databasePath, health }) => {
          if (databasePath === databasePathKey) {
            observed.push(health.state);
          }
        });
        let closing: Promise<unknown> | undefined;
        try {
          reader.exec("ROLLBACK");
          reader.close();
          expect(budget.checkpointBlocked).toBe(deferredCheckpoint);
          if (recovery === "shared-state-close") {
            const { admission } = captureOpenClawStateWorkerContext({ env: databaseOptions.env });
            admission.assertCurrent();
            closing = closeOpenClawStateDatabaseByPathAsync(admission.databasePath);
            expect(() => admission.assertCurrent()).toThrow("admission is closed");
          } else {
            closing = drainAgentDatabaseResources(
              { path: database.path, agentId: databaseOptions.agentId },
              async () => undefined,
            );
          }
          await closing;
          const walPath = `${database.path}-wal`;
          expect(fs.existsSync(walPath) ? fs.statSync(walPath).size : 0).toBe(0);
          expect(observed).toContain("complete");
        } finally {
          await Promise.allSettled([closing]);
          unsubscribe();
        }
      }
      expect(relayedCompletions.length).toBeGreaterThan(0);
      expect(budget.checkpointBlocked).toBeUndefined();
    } finally {
      reader[Symbol.dispose]();
      relay.mockRestore();
      observeAdmission.mockRestore();
      await Promise.allSettled([following]);
    }
  },
);

test("periodic vacuum waits for an admitted reclamation to settle", async () => {
  const { database, databaseOptions, freePages } = createFixture();
  // sqlite-allow-raw -- Disposable free pages exercise the real incremental vacuum.
  database.db.exec(`CREATE TABLE reclamation_fixture (payload BLOB);
      INSERT INTO reclamation_fixture VALUES (zeroblob(8388608));
      DROP TABLE reclamation_fixture;`);
  const before = freePages();
  expect(before).toBeGreaterThan(512);
  const plan = createLifecycleArtifactReclamationPlan({
    agentId: databaseOptions.agentId,
    databaseOptions,
    entries: [],
    materializedPlans: [],
  });
  const maintenanceErrors: unknown[] = [];
  let nativeSettled = false;
  let reclamationWorker: Worker | undefined;
  using workerObservers = new DisposableStack();
  const observeWorker = (worker: Worker) => {
    const onMessage = (message: unknown) => {
      if (!isRecord(message)) {
        return;
      }
      if (message.type === "admission-request") {
        reclamationWorker = worker;
        nativeSettled = false;
      }
      const finished = message.type === "reclaimed" || message.type === "refused";
      if (worker === reclamationWorker && finished && message.settled === true) {
        nativeSettled = true;
      }
    };
    const onExit = () => (nativeSettled ||= worker === reclamationWorker);
    worker.on("message", onMessage);
    worker.once("exit", onExit);
    workerObservers.defer(() => worker.off("message", onMessage).off("exit", onExit));
  };
  process.on("worker", observeWorker);
  workerObservers.defer(() => process.off("worker", observeWorker));
  const maintenanceAdmissions: { stage: "transaction" | "commit"; nativeSettled: boolean }[] = [];
  const databasePathKey = sqliteReaderDatabasePathKey(database.path);
  using _ = probe.admission(workerAdmission, (request, grant, admit) => {
    if (
      (request.stage === "transaction" || request.stage === "commit") &&
      targetsDatabase(request.facts, databasePathKey)
    ) {
      maintenanceAdmissions.push({ stage: request.stage, nativeSettled });
    }
    admit(request, grant);
  });
  using execSpy = vi.spyOn(database.db, "exec");
  const scheduled = observeSqliteWalPeriodicWork();
  let maintenance: ReturnType<typeof configureSqliteWalMaintenance>;
  try {
    maintenance = configureSqliteWalMaintenance(requireNativeSqliteDatabase(database.db), {
      busyTimeoutMs: 1_000,
      onCheckpointError: (error) => maintenanceErrors.push(error),
    });
  } finally {
    scheduled.restore();
  }
  const periodic = scheduled.periodic;
  const periodicWork: Promise<unknown>[] = [];
  const write = sessionScope.runExclusiveSqliteSessionWrite;
  using writeObserver = vi
    .spyOn(sessionScope, "runExclusiveSqliteSessionWrite")
    .mockImplementation((scope, run, operation, ...rest) =>
      write(
        scope,
        async () => {
          if (operation === "session.reclamation.worker-commit") {
            // Join behind the writer whose admission is already held.
            periodicWork.push(Promise.resolve(periodic()));
          }
          return run();
        },
        operation,
        ...rest,
      ),
    );
  try {
    const result = await runSqliteSessionReclamation({ plan });
    expect(result).toMatchObject({ kind: "lifecycle-artifacts", value: { removedEntries: 0 } });
    expect(periodicWork.length).toBeGreaterThan(0);
    await Promise.all(periodicWork);
    expect(maintenanceAdmissions[0]).toEqual({ stage: "transaction", nativeSettled: true });
    expect(maintenanceAdmissions.some((request) => request.stage === "commit")).toBe(true);
    expect(maintenanceAdmissions.every((request) => request.nativeSettled)).toBe(true);
    const calls = execSpy.mock.calls;
    expect(calls.filter(([sql]) => sql.startsWith("PRAGMA incremental_vacuum("))).toEqual([]);
    expect(agentDb.getOpenClawAgentDatabaseIfOpen(databaseOptions)?.db === database.db).toBe(true);
    await maintenance.stop();
    maintenance.close({ checkpointMode: "PASSIVE" });
    await agentDb.closeOpenClawAgentDatabasesAsync();
    expect(reclamationWorker?.threadId).toBe(-1);
    const remaining = withOpenClawAgentDatabaseReadOnly(
      ({ db }) => Number(db.prepare("PRAGMA freelist_count").get()?.freelist_count),
      databaseOptions,
    );
    assert.ok(remaining.found);
    expectReclaimed(before - remaining.value, 512);
    expect(maintenanceErrors).toEqual([]);
  } finally {
    writeObserver.mockRestore();
    await maintenance.stop();
    await Promise.all(periodicWork);
    if (database.db.isOpen) {
      maintenance.close({ checkpointMode: "PASSIVE" });
    }
    await agentDb.closeOpenClawAgentDatabasesAsync();
  }
}, 20_000);
