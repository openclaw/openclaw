import assert from "node:assert/strict";
import fs from "node:fs";
import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { sqliteReaderDatabasePathKey } from "../../infra/sqlite-reader-lifecycle.js";
import * as walCheckpoint from "../../infra/sqlite-wal-checkpoint.js";
import { configureSqliteWalMaintenance } from "../../infra/sqlite-wal.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeCachedOpenClawAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { drainAgentDatabaseResources } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import * as executionCleanup from "../../state/openclaw-agent-execution-cleanup.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import { withSqliteSessionPageReclamation } from "./session-accessor.sqlite-page-reclamation.js";
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
          const originalRun = worker.run.bind(worker);
          const spy = vi.spyOn(worker, "run").mockImplementation((params) =>
            originalRun({
              ...params,
              onCommitRequest: () => {
                hooks.beforeAuthorization?.();
                return params.onCommitRequest();
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

test.each([
  "reclaim",
  "resource-close",
  "shared-state-close",
  "resource-close-replaced",
  "resource-close-removed",
] as const)(
  "reclaims pages off-thread and applies current checkpoint receipts (%s)",
  async (recovery) => {
    const { database, databaseOptions } = createFixture();
    const staleReceipt =
      recovery === "resource-close-replaced" || recovery === "resource-close-removed";
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
    let commitRequestedAtNs: bigint | undefined;
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    const observeAdmission = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) =>
        createAdmission((request, grant) => {
          if (
            request.stage === "commit" &&
            isRecord(request.facts) &&
            isRecord(request.facts.identity) &&
            typeof request.facts.identity.nativeLocation === "string" &&
            sqliteReaderDatabasePathKey(request.facts.identity.nativeLocation) === databasePathKey
          ) {
            commitRequestedAtNs = process.hrtime.bigint();
          }
          admit(request, grant);
        }, attachment),
      );
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
              expect(completed).toMatchObject({
                checkpointCompleted: true,
                checkpointIncomplete: 0,
                vacuumPasses: 1,
                vacuumPagesRequested: 7,
              });
              assert(commitRequestedAtNs !== undefined);
              assert(completed.checkpoint);
              expect(completed.checkpoint.observedAtNs).toBeGreaterThanOrEqual(commitRequestedAtNs);
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
      if (recovery !== "reclaim") {
        closeCachedOpenClawAgentDatabase(database, { eviction: true });
        expect(database.db.isOpen).toBe(false);
        const deferredCheckpoint = budget.checkpointBlocked;
        assert(deferredCheckpoint);
        const observed: string[] = [];
        const unsubscribe = walCheckpoint.onSqliteWalCheckpoint(({ databasePath, health }) => {
          if (databasePath === databasePathKey) {
            observed.push(health.state);
          }
        });
        const cleanupFinished = createDeferredCore();
        const releaseReceipt = createDeferredCore();
        const cleanup = executionCleanup.cleanupRetiredAgentDatabaseLease;
        const delayReceipt = staleReceipt
          ? vi
              .spyOn(executionCleanup, "cleanupRetiredAgentDatabaseLease")
              .mockImplementation(async (cleanupParams) => {
                await cleanup(cleanupParams);
                if (sqliteReaderDatabasePathKey(cleanupParams.lease.path) === databasePathKey) {
                  cleanupFinished.resolve();
                  await releaseReceipt.promise;
                }
              })
          : undefined;
        let closing: Promise<void> | undefined;
        let closeSettled = false;
        try {
          reader.exec("ROLLBACK");
          reader.close();
          expect(budget.checkpointBlocked).toBe(deferredCheckpoint);
          if (recovery === "shared-state-close") {
            const { admission } = captureOpenClawStateWorkerContext({ env: databaseOptions.env });
            admission.assertCurrent();
            closing = closeOpenClawStateDatabaseByPathAsync(admission.databasePath).then(
              () => undefined,
            );
            expect(() => admission.assertCurrent()).toThrow("admission is closed");
          } else {
            closing = drainAgentDatabaseResources(
              { path: database.path, agentId: databaseOptions.agentId },
              async () => undefined,
            );
          }
          closing = closing.then(() => {
            closeSettled = true;
          });
          if (staleReceipt) {
            await Promise.race([cleanupFinished.promise, closing]);
            expect(closeSettled).toBe(false);
            expect(database.db.isOpen).toBe(false);
            expect(reader.isOpen).toBe(false);
            expect(getOpenClawAgentDatabaseIfOpen(databaseOptions)).toBeUndefined();
            // The real cleanup has closed native handles and released the exact lease.
            const retiredPath = `${database.path}.retired`;
            fs.renameSync(database.path, retiredPath);
            if (recovery === "resource-close-replaced") {
              fs.copyFileSync(retiredPath, database.path);
            }
            releaseReceipt.resolve();
          }
          await closing;
          expect(closeSettled).toBe(true);
          const walPath = `${database.path}-wal`;
          expect(fs.existsSync(walPath) ? fs.statSync(walPath).size : 0).toBe(0);
          if (staleReceipt) {
            expect(observed).not.toContain("complete");
            expect(relayedCompletions).toEqual([]);
            expect(budget.checkpointBlocked).toBe(deferredCheckpoint);
          } else {
            expect(observed).toContain("complete");
          }
        } finally {
          releaseReceipt.resolve();
          await Promise.allSettled([closing]);
          delayReceipt?.mockRestore();
          unsubscribe();
        }
      }
      if (!staleReceipt) {
        expect(relayedCompletions.length).toBeGreaterThan(0);
        expect(budget.checkpointBlocked).toBeUndefined();
      }
    } finally {
      if (reader.isOpen) {
        if (reader.isTransaction) {
          reader.exec("ROLLBACK");
        }
        reader.close();
      }
      parentReclaim.mockRestore();
      relay.mockRestore();
      observeAdmission.mockRestore();
      await Promise.allSettled([following]);
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
    let reclamationWorker: Worker | undefined;
    const stopObservingWorkers: Array<() => void> = [];
    const observeWorker = (worker: Worker) => {
      const onMessage = (message: unknown) => {
        if (isRecord(message) && message.type === "commit-request") {
          reclamationWorker = worker;
        }
        if (isRecord(message) && message.type === "reclaimed" && message.settled === true) {
          nativeSettled = true;
        }
      };
      const onExit = () => {
        if (worker === reclamationWorker) {
          nativeSettled = true;
        }
      };
      worker.on("message", onMessage);
      worker.once("exit", onExit);
      stopObservingWorkers.push(() => {
        worker.off("message", onMessage);
        worker.off("exit", onExit);
      });
    };
    process.on("worker", observeWorker);
    const maintenanceAdmissions: Array<{
      stage: "transaction" | "commit";
      authorizationChecked: boolean;
      nativeSettled: boolean;
    }> = [];
    const databasePathKey = sqliteReaderDatabasePathKey(database.path);
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    const observeAdmission = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) =>
        createAdmission((request, grant) => {
          if (
            (request.stage === "transaction" || request.stage === "commit") &&
            isRecord(request.facts) &&
            isRecord(request.facts.identity) &&
            typeof request.facts.identity.nativeLocation === "string" &&
            sqliteReaderDatabasePathKey(request.facts.identity.nativeLocation) === databasePathKey
          ) {
            maintenanceAdmissions.push({
              stage: request.stage,
              authorizationChecked,
              nativeSettled,
            });
          }
          admit(request, grant);
        }, attachment),
      );
    const execSpy = vi.spyOn(database.db, "exec");
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
      expect(maintenanceAdmissions[0]).toEqual({
        stage: "transaction",
        authorizationChecked: true,
        nativeSettled: true,
      });
      expect(maintenanceAdmissions.some((request) => request.stage === "commit")).toBe(true);
      expect(
        maintenanceAdmissions.every(
          (request) => request.authorizationChecked && request.nativeSettled,
        ),
      ).toBe(true);
      expect(
        execSpy.mock.calls.filter(([statement]) =>
          statement.startsWith("PRAGMA incremental_vacuum("),
        ),
      ).toEqual([]);
      expect(getOpenClawAgentDatabaseIfOpen(databaseOptions)?.db === database.db).toBe(true);
      maintenance.close({ checkpointMode: "PASSIVE" });
      vi.useRealTimers();
      await closeOpenClawAgentDatabasesAsync();
      expect(reclamationWorker?.threadId).toBe(-1);
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
      for (const stop of stopObservingWorkers) {
        stop();
      }
      observeAdmission.mockRestore();
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
