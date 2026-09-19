import assert from "node:assert/strict";
import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { configureSqliteWalMaintenance } from "../../infra/sqlite-wal.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import {
  createLifecycleArtifactReclamationPlan,
  runSqliteSessionReclamation,
} from "./session-accessor.sqlite-reclamation.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";

const hooks = vi.hoisted(() => ({ beforeAuthorization: undefined as (() => void) | undefined }));
vi.mock("./session-accessor.sqlite-reclamation-worker.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./session-accessor.sqlite-reclamation-worker.js")>();
  return {
    ...actual,
    withSqliteReclamationWorker: ((options, claim, run, assertRequestCurrent) =>
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
      expect(vacuumCalls).toEqual([
        {
          statement: "PRAGMA incremental_vacuum(512);",
          authorizationChecked: true,
          nativeSettled: true,
        },
      ]);
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
