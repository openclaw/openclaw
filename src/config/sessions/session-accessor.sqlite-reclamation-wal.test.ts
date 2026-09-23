import assert from "node:assert/strict";
import fs from "node:fs";
import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import { sqliteReaderDatabasePathKey } from "../../infra/sqlite-reader-lifecycle.js";
import * as walCheckpoint from "../../infra/sqlite-wal-checkpoint.js";
import { configureSqliteWalMaintenance } from "../../infra/sqlite-wal.js";
import { closeCachedOpenClawAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import { withSqliteSessionPageReclamation } from "./session-accessor.sqlite-page-reclamation.js";
import type { SqliteReclamationWorker } from "./session-accessor.sqlite-reclamation-worker.js";
import {
  createLifecycleArtifactReclamationPlan,
  runSqliteSessionReclamation,
} from "./session-accessor.sqlite-reclamation.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import {
  deferPhysicalBudgetForCheckpoint,
  getBudgetKickState,
} from "./session-history-budget-state.js";

const hooks = vi.hoisted(() => ({
  beforeAuthorization: undefined as (() => void) | undefined,
  afterAuthorization: undefined as (() => void) | undefined,
  onWorker: undefined as ((worker: SqliteReclamationWorker) => void) | undefined,
}));
vi.mock("./session-accessor.sqlite-reclamation-worker.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./session-accessor.sqlite-reclamation-worker.js")>();
  return {
    ...actual,
    withSqliteReclamationWorker: ((options, claim, run, assertRequestCurrent, signal) =>
      actual.withSqliteReclamationWorker(
        options,
        claim,
        async (worker) => {
          hooks.onWorker?.(worker);
          const originalRun = worker.run.bind(worker);
          const spy = vi.spyOn(worker, "run").mockImplementation((params) =>
            originalRun({
              ...params,
              onCommitRequest: () => {
                hooks.beforeAuthorization?.();
                try {
                  return params.onCommitRequest();
                } finally {
                  hooks.afterAuthorization?.();
                }
              },
            }),
          );
          try {
            return await run(worker);
          } finally {
            spy.mockRestore();
          }
        },
        assertRequestCurrent,
        signal,
      )) satisfies typeof actual.withSqliteReclamationWorker,
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  hooks.beforeAuthorization = undefined;
  hooks.afterAuthorization = undefined;
  hooks.onWorker = undefined;
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function createFixture() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-reclamation-wal-") };
  const options = { agentId: "main", env };
  for (const sessionId of ["parent", "child"]) {
    ensureSessionEntrySync(
      { ...options, sessionKey: `agent:main:${sessionId}` },
      { sessionId, updatedAt: 1 },
    );
  }
  const database = openOpenClawAgentDatabase(options);
  return { database, databaseOptions: { ...options, path: database.path } };
}

test.each(["reclaim", "worker-close"] as const)(
  "reclaims pages off-thread and releases budget deferral through %s",
  async (recovery) => {
    const { database, databaseOptions } = createFixture();
    const databasePathKey = sqliteReaderDatabasePathKey(database.path);
    database.db.exec(`INSERT INTO cache_entries(scope, key, blob, updated_at)
    VALUES ('wal-proof', 'pages', zeroblob(4194304), 1);
    DELETE FROM cache_entries WHERE scope = 'wal-proof';`);
    expect(database.walMaintenance.checkpoint()).toBe(true);
    const { DatabaseSync } = requireNodeSqlite();
    const reader = new DatabaseSync(database.path, { readOnly: true });
    const freePages = () =>
      Number(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count);
    const parentReclaim = vi.spyOn(database.walMaintenance, "reclaimFreePages");
    const ordering: string[] = [];
    const params = {
      storePath: database.path,
      mode: "enforce" as const,
      maintenance: { maxDiskBytes: 1, highWaterBytes: 1 },
    };
    const budget = getBudgetKickState(params.storePath, params.maintenance);
    let capturingProbe = false;
    let parentReleaseNs: bigint | undefined;
    hooks.beforeAuthorization = () => {
      capturingProbe = true;
    };
    hooks.afterAuthorization = () => {
      capturingProbe = false;
    };
    const open = nodeSqlite.openNodeSqliteDatabase;
    const observeProbe = vi
      .spyOn(nodeSqlite, "openNodeSqliteDatabase")
      .mockImplementation((...args) => {
        const opened = open(...args);
        if (capturingProbe && sqliteReaderDatabasePathKey(args[0]) === databasePathKey) {
          const close = opened.close.bind(opened);
          vi.spyOn(opened, "close").mockImplementation(() => {
            close();
            parentReleaseNs = process.hrtime.bigint();
          });
        }
        return opened;
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
        return publish(databasePath, {
          ...snapshot,
          health: {
            ...snapshot.health,
            observedAtMs: completedAt,
            lastCompletedAtMs: completedAt,
          },
        });
      });
    let retainedWorker: SqliteReclamationWorker | undefined;
    hooks.onWorker = (worker) => {
      retainedWorker = worker;
    };
    let following: Promise<void> | undefined;
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT COUNT(*) FROM cache_entries").get();
      database.db.exec(`INSERT INTO cache_entries(scope, key, blob, updated_at)
      VALUES ('wal-proof', 'live', X'72657461696E6564', 1);`);
      const original = freePages();
      await withSqliteSessionPageReclamation(databaseOptions, (reclaim) =>
        runExclusiveSqliteSessionWrite(
          databaseOptions,
          async () => {
            ordering.push("archive-start");
            following = runExclusiveSqliteSessionWrite(
              databaseOptions,
              async () => {
                ordering.push("following-writer");
              },
              "session.transcript.batch",
            );
            const blocked = await reclaim();
            expect(blocked).toMatchObject({
              checkpointCompleted: false,
              checkpoint: { health: { state: "blocked" } },
              checkpointIncomplete: 1,
              vacuumPasses: 0,
            });
            expect(freePages()).toBe(original);
            deferPhysicalBudgetForCheckpoint(params, database.path, blocked.checkpoint);
            assert(blocked.checkpoint);
            completedAt = blocked.checkpoint.health.observedAtMs - 1;
            if (recovery === "reclaim") {
              reader.exec("ROLLBACK");
              const completed = await reclaim(7);
              expect(completed.vacuumPagesRequested).toBe(7);
              assert(parentReleaseNs !== undefined);
              assert(completed.checkpoint);
              expect(completed.checkpoint.observedAtNs).toBeGreaterThanOrEqual(parentReleaseNs);
              expect(original - freePages()).toBeGreaterThan(0);
              expect(original - freePages()).toBeLessThanOrEqual(7);
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
      if (recovery === "worker-close") {
        assert(retainedWorker);
        closeCachedOpenClawAgentDatabase(database, { eviction: true });
        expect(database.db.isOpen).toBe(false);
        expect(budget.checkpointBlocked).toBeDefined();
        const observed: string[] = [];
        const unsubscribe = walCheckpoint.onSqliteWalCheckpoint(({ databasePath, health }) => {
          if (databasePath === databasePathKey) {
            observed.push(health.state);
          }
        });
        try {
          reader.exec("ROLLBACK");
          await retainedWorker.close();
          const walPath = `${database.path}-wal`;
          expect(fs.existsSync(walPath) ? fs.statSync(walPath).size : 0).toBe(0);
          expect(observed).toContain("complete");
        } finally {
          unsubscribe();
        }
      }
      expect(relayedCompletions.length).toBeGreaterThan(0);
      expect(budget.checkpointBlocked).toBeUndefined();
    } finally {
      if (reader.isTransaction) {
        reader.exec("ROLLBACK");
      }
      reader.close();
      parentReclaim.mockRestore();
      relay.mockRestore();
      observeProbe.mockRestore();
    }
  },
);

test.each([false, true])(
  "periodic vacuum waits for reclamation settlement (rejected: %s)",
  async (rejected) => {
    const { database, databaseOptions } = createFixture();
    // sqlite-allow-raw -- Disposable free pages exercise the real incremental vacuum.
    database.db.exec(`CREATE TABLE reclamation_fixture (payload BLOB);
      INSERT INTO reclamation_fixture VALUES (zeroblob(8388608));
      DROP TABLE reclamation_fixture;`);
    const freePages = () =>
      Number(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count);
    const before = freePages();
    expect(before).toBeGreaterThan(512);
    const plan = createLifecycleArtifactReclamationPlan({
      agentId: databaseOptions.agentId,
      databaseOptions,
      entries: [],
      materializedPlans: [],
    });
    const maintenanceErrors: unknown[] = [];
    let commitChecks = 0;
    let commitRequested = false;
    let checksDuringMaintenance = 0;
    let authorizationChecked = false;
    let nativeSettled = false;
    const workers: Worker[] = [];
    const observeWorker = (worker: Worker) => {
      workers.push(worker);
      worker.on("message", (message: unknown) => {
        if (isRecord(message) && message.type === "reclaimed" && message.settled === true) {
          nativeSettled = true;
        }
      });
      worker.once("exit", () => {
        nativeSettled = true;
      });
    };
    process.on("worker", observeWorker);
    const vacuumCalls: Array<{
      statement: string;
      authorizationChecked: boolean;
      nativeSettled: boolean;
    }> = [];
    const execute = database.db.exec.bind(database.db);
    const execSpy = vi.spyOn(database.db, "exec").mockImplementation((statement) => {
      if (statement.startsWith("PRAGMA incremental_vacuum(")) {
        vacuumCalls.push({ statement, authorizationChecked, nativeSettled });
      }
      execute(statement);
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const maintenance = configureSqliteWalMaintenance(database.db, {
      busyTimeoutMs: 1_000,
      checkpointIntervalMs: 1,
      onCheckpointError: (error) => maintenanceErrors.push(error),
    });
    hooks.beforeAuthorization = () => {
      // Timer work must queue without synchronously servicing or delaying this approval.
      commitRequested = true;
      const checksBeforeMaintenance = commitChecks;
      vi.advanceTimersByTime(1);
      checksDuringMaintenance = commitChecks - checksBeforeMaintenance;
    };
    try {
      const reclamation = runSqliteSessionReclamation({
        forceInProcess: false,
        plan,
        assertCommitAllowed: () => {
          commitChecks += 1;
          if (commitRequested) {
            authorizationChecked = true;
          }
          if (rejected && commitRequested) {
            throw new Error("reclamation owner retired");
          }
        },
      });
      if (rejected) {
        await expect(reclamation).rejects.toThrow("reclamation owner retired");
      } else {
        await expect(reclamation).resolves.toMatchObject({
          kind: "lifecycle-artifacts",
          value: { removedEntries: 0 },
        });
      }
      await runExclusiveSqliteSessionWrite(
        databaseOptions,
        async () => undefined,
        "session.transcript.batch",
      );
      expect(checksDuringMaintenance).toBe(0);
      expect(authorizationChecked).toBe(true);
      expect(vacuumCalls[0]).toEqual({
        statement: "PRAGMA incremental_vacuum(8);",
        authorizationChecked: true,
        nativeSettled: true,
      });
      expect(vacuumCalls.every((call) => call.authorizationChecked && call.nativeSettled)).toBe(
        true,
      );
      expect(getOpenClawAgentDatabaseIfOpen(databaseOptions)?.db === database.db).toBe(true);
      maintenance.close({ checkpointMode: "PASSIVE" });
      vi.useRealTimers();
      await closeOpenClawAgentDatabasesAsync();
      expect(workers).toHaveLength(1);
      expect(workers[0]?.threadId).toBe(-1);
      const remaining = withOpenClawAgentDatabaseReadOnly(
        ({ db }) => Number(db.prepare("PRAGMA freelist_count").get()?.freelist_count),
        databaseOptions,
      );
      assert.ok(remaining.found);
      const reclaimed = before - remaining.value;
      expect(reclaimed).toBeGreaterThan(0);
      expect(reclaimed).toBeLessThanOrEqual(512);
      expect(maintenanceErrors).toEqual([]);
    } finally {
      process.off("worker", observeWorker);
      execSpy.mockRestore();
      if (database.db.isOpen) {
        maintenance.close({ checkpointMode: "PASSIVE" });
      }
      vi.useRealTimers();
      await closeOpenClawAgentDatabasesAsync();
    }
  },
  20_000,
);
