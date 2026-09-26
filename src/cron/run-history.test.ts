import { expect, it, vi } from "vitest";
import { ensureExecutionOwnerLifecycleBindingSchema } from "../audit/execution-owner-lifecycle-binding-store.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  cronQuietTriggerDetail,
  cronRunLogEntryToDetail,
  cronRunRecordToRunLogEntry,
} from "./run-history-detail.js";
import { projectCronRunHistoryPage, type ReadCronRunHistoryPageOptions } from "./run-history.js";
import { findCronRunRecoveryInDatabase } from "./service/run-history-recovery.js";
import { cronStoreKey } from "./store/key.js";
import { readCronRunRecords } from "./store/read-only.js";
import { recordCronRun, maintainCronRunHistory } from "./store/run-history.js";
import {
  pruneCronRunHistoryInDatabase,
  readCronRunRecordsInDatabase,
  recordCronRunInDatabase,
} from "./store/run-history.kernel.js";
import type { CronRunHistoryWrite, CronRunRecord } from "./store/run-history.types.js";
import { prepareCronRunReceiptWriteSchema } from "./store/run-receipt-write-admission.js";

async function readCronRunHistoryPage(options: ReadCronRunHistoryPageOptions) {
  return projectCronRunHistoryPage(
    await readCronRunRecords(options.storeKey, options.jobId),
    options,
  );
}

function outcome(storeKey: string, receipt: string): CronRunHistoryWrite {
  return {
    storeKey,
    jobId: "job",
    runId: `cron:job:10:${receipt}`,
    agentId: "main",
    startedAt: 10,
    endedAt: 20,
    sessionKey: "agent:main:cron:job",
    status: "succeeded",
    detail: cronRunLogEntryToDetail(
      {
        jobId: "job",
        action: "finished",
        ts: 20,
        runAtMs: 10,
        status: "ok",
        completionStatus: "succeeded",
        sessionId: "recorded-generation",
        runId: receipt,
      },
      { storeKey },
    ),
  };
}

it("retains history across worker reads, isolates stores, and recovers only an exact receipt", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "cron-native-history-" },
    async (state) => {
      const storeKey = cronStoreKey(state.statePath("cron/jobs.json"));
      runOpenClawStateWriteTransaction(({ db }) => {
        recordCronRunInDatabase(db, outcome(storeKey, "first"));
        recordCronRunInDatabase(db, outcome(storeKey, "second"));
        recordCronRunInDatabase(db, outcome(storeKey + "-other", "first"));
        const recovered = findCronRunRecoveryInDatabase({
          database: db,
          storeKey,
          jobId: "job",
          startedAt: 10,
          receiptId: "second",
        });
        expect(recovered.finalized?.entry).toMatchObject({
          runId: "second",
          sessionId: "recorded-generation",
        });
        expect(
          findCronRunRecoveryInDatabase({
            database: db,
            storeKey,
            jobId: "job",
            startedAt: 10,
            receiptId: "missing",
          }).finalized,
        ).toBeUndefined();
        // A late result cannot replace the first durable outcome for this exact run.
        recordCronRunInDatabase(db, {
          ...outcome(storeKey, "first"),
          status: "failed",
          endedAt: 40,
        });
        expect(
          readCronRunRecordsInDatabase(db, "job").find((row) => row.runId === "cron:job:10:first")
            ?.endedAt,
        ).toBe(20);
      });
      const history = await readCronRunHistoryPage({
        storeKey,
        jobId: "job",
        limit: 1,
        sortDir: "asc",
      });
      expect(history).toMatchObject({ total: 2, limit: 1, hasMore: true, nextOffset: 1 });
      expect(history.entries[0]?.sessionId).toBe("recorded-generation");
      expect(
        (await readCronRunHistoryPage({ storeKey, jobId: "job", runId: "second" })).entries,
      ).toHaveLength(1);
    },
  );
});

it("bounds quiet evaluations separately without evicting payload history or active recovery markers", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "cron-history-retention-" },
    async () => {
      runOpenClawStateWriteTransaction(({ db }) => {
        const schema = prepareCronRunReceiptWriteSchema(db);
        const insert = db.prepare(
          "INSERT INTO task_runs (task_id, runtime, owner_key, scope_kind, task, delivery_status, notify_policy, source_id, created_at, ended_at, cleanup_after, status, detail_json) VALUES (?, 'cron', '', 'system', 'job', 'not_applicable', 'silent', ?, ?, ?, ?, ?, ?)",
        );
        const pruneRecords = (records: readonly CronRunRecord[], now: number) => {
          db.exec("DELETE FROM task_runs WHERE runtime = 'cron'");
          for (const row of records) {
            insert.run(
              row.id,
              row.jobId,
              row.createdAt,
              row.endedAt ?? null,
              row.cleanupAfter ?? null,
              row.status,
              row.detail === undefined ? null : JSON.stringify(row.detail),
            );
          }
          pruneCronRunHistoryInDatabase(db, now, schema);
          const remaining = new Set(readCronRunRecordsInDatabase(db).map((row) => row.id));
          return new Set(records.filter((row) => !remaining.has(row.id)).map((row) => row.id));
        };
        const records: CronRunRecord[] = Array.from({ length: 2001 }, (_, index) => ({
          id: String(index),
          jobId: "job",
          createdAt: index,
          endedAt: index,
          status: "succeeded",
          detail: cronQuietTriggerDetail("store", { fired: false, stateChanged: false }),
        }));
        const history: CronRunRecord = {
          id: "history",
          jobId: "job",
          createdAt: 0,
          endedAt: 0,
          status: "succeeded",
          detail: outcome("store", "history").detail,
        };
        const active: CronRunRecord = {
          id: "active",
          jobId: "job",
          createdAt: 0,
          status: "running",
        };
        const otherStore = {
          ...records[0]!,
          id: "other-store",
          detail: cronQuietTriggerDetail("other", { fired: false, stateChanged: false }),
        };
        const otherJob = { ...records[0]!, id: "other-job", jobId: "other" };
        expect(pruneRecords([...records, history, active, otherStore, otherJob], 3000)).toEqual(
          new Set(["0"]),
        );
        expect(pruneRecords([history, active], 7 * 24 * 60 * 60_000)).toEqual(new Set(["history"]));
        const lost: CronRunRecord = {
          ...history,
          id: "lost",
          status: "lost",
          cleanupAfter: 7 * 24 * 60 * 60_000,
        };
        expect(pruneRecords([history, lost], 24 * 60 * 60_000 - 1)).toEqual(new Set());
        expect(pruneRecords([history, lost], 24 * 60 * 60_000)).toEqual(new Set(["lost"]));
        expect(
          projectCronRunHistoryPage([...records, history], { storeKey: "store", jobId: "job" })
            .total,
        ).toBe(1);
        for (const jobId of [null, ""]) {
          for (const record of records) {
            record.jobId = jobId;
          }
          expect(pruneRecords(records, 3000)).toEqual(new Set());
          expect(pruneRecords(records, 7 * 24 * 60 * 60_000)).toEqual(new Set(["0"]));
        }
      });
    },
  );
});

it("admits actual worker writes and rolls back history pruning when commit is refused", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "cron-history-worker-admission-" },
    async (state) => {
      const storeKey = cronStoreKey(state.statePath("cron/jobs.json"));
      const stages: string[] = [];
      let refuseCommit = false;
      const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
      const admissionSpy = vi
        .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, attachment) =>
          createAdmission((request, grant) => {
            stages.push(request.stage);
            if (refuseCommit && request.stage === "commit") {
              throw new Error("Cron history commit refused");
            }
            admit(request, grant);
          }, attachment),
        );
      try {
        await recordCronRun(outcome(storeKey, "worker"));
        expect(stages).toEqual(["transaction", "commit"]);
        expect((await readCronRunHistoryPage({ storeKey })).total).toBe(1);
        stages.length = 0;
        refuseCommit = true;
        const context = captureOpenClawStateWorkerContext();
        const maintain = () => maintainCronRunHistory(context, context.admission.assertCurrent);
        await expect(maintain()).rejects.toThrow("Cron history commit refused");
        expect(stages).toEqual(["transaction", "commit"]);
        expect((await readCronRunHistoryPage({ storeKey })).total).toBe(1);
        stages.length = 0;
        refuseCommit = false;
        await maintain();
        expect(stages).toEqual(["transaction", "commit"]);
        expect((await readCronRunHistoryPage({ storeKey })).entries).toEqual([]);
      } finally {
        admissionSpy.mockRestore();
      }
    },
  );
});

it("reads released row fallback fields but never discloses internal recovery state", () => {
  const record: CronRunRecord = {
    id: "released",
    jobId: "job",
    createdAt: 1,
    endedAt: 2,
    status: "cancelled",
    error: "operator reason",
    summary: "old summary",
    sessionKey: "agent:main:cron:job",
    detail: {
      kind: "cron-run",
      status: "ok",
      storeKey: "store",
      sessionId: "old-generation",
      triggerState: { secret: true },
      futureInternal: "private",
    },
  };
  const entry = cronRunRecordToRunLogEntry(record);
  expect(entry).toMatchObject({
    error: "operator reason",
    summary: "old summary",
    sessionId: "old-generation",
  });
  expect(entry).not.toHaveProperty("triggerState");
  expect(entry).not.toHaveProperty("futureInternal");
  expect(entry).not.toHaveProperty("storeKey");
});

it("retains legacy identities and raw details without inventing a store partition", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "cron-history-legacy-" },
    async () => {
      runOpenClawStateWriteTransaction(({ db }) => {
        const rawDetail = '{ "kind": "cron-run", "status": "ok", "future": [1, 2] }';
        const insert = db.prepare(
          "INSERT INTO task_runs (task_id, runtime, owner_key, scope_kind, task, delivery_status, notify_policy, source_id, run_id, created_at, status, detail_json) VALUES (?, 'cron', '', 'system', 'job', 'not_applicable', 'silent', ?, ?, ?, ?, ?)",
        );
        insert.run("legacy-null", null, "shared-run", 10, "failed", rawDetail);
        insert.run("legacy-empty", "", "shared-run", 10, "failed", "{");
        insert.run("legacy-unpartitioned", "job", "shared-run", 10, "succeeded", rawDetail);
        // Retired feature rows share the physical table but never enter Cron retention.
        db.prepare(
          "INSERT INTO task_runs (task_id, runtime, owner_key, scope_kind, task, delivery_status, notify_policy, created_at, status) VALUES ('retired-task', 'subagent', 'owner', 'session', 'retired', 'pending', 'silent', 10, 'succeeded')",
        ).run();
        const insertDelivery = db.prepare(
          "INSERT INTO task_delivery_state (task_id, requester_origin_json) VALUES (?, ?)",
        );
        insertDelivery.run("legacy-null", "cron delivery");
        insertDelivery.run("retired-task", "retired delivery");
        const records = readCronRunRecordsInDatabase(db);
        expect(
          records
            .map(({ id, jobId, runId }) => ({ id, jobId, runId }))
            .toSorted((a, b) => a.id.localeCompare(b.id)),
        ).toEqual([
          { id: "legacy-empty", jobId: null, runId: "shared-run" },
          { id: "legacy-null", jobId: null, runId: "shared-run" },
          { id: "legacy-unpartitioned", jobId: "job", runId: "shared-run" },
        ]);
        expect(projectCronRunHistoryPage(records, { storeKey: "current-store" }).entries).toEqual(
          [],
        );
        expect(pruneCronRunHistoryInDatabase(db, 11, prepareCronRunReceiptWriteSchema(db))).toBe(0);
        expect(
          db.prepare("SELECT detail_json FROM task_runs WHERE task_id = ?").get("legacy-null"),
        ).toEqual({ detail_json: rawDetail });
        expect(
          db.prepare("SELECT detail_json FROM task_runs WHERE task_id = ?").get("legacy-empty"),
        ).toEqual({ detail_json: "{" });
        ensureExecutionOwnerLifecycleBindingSchema(db);
        const insertBinding = db.prepare(
          "INSERT INTO execution_owner_lifecycle_bindings (owner_kind, owner_id, context_id, execution_id) VALUES (?, ?, 'context', 'execution')",
        );
        insertBinding.run("task", "legacy-null");
        insertBinding.run("task", "retired-task");
        insertBinding.run("cron", "legacy-null");
        insertBinding.run("flow", "legacy-null");
        expect(
          pruneCronRunHistoryInDatabase(
            db,
            10 + 7 * 24 * 60 * 60_000,
            prepareCronRunReceiptWriteSchema(db),
          ),
        ).toBe(3);
        expect(readCronRunRecordsInDatabase(db)).toEqual([]);
        expect(db.prepare("SELECT task_id FROM task_runs").all()).toEqual([
          { task_id: "retired-task" },
        ]);
        expect(db.prepare("SELECT task_id FROM task_delivery_state").all()).toEqual([
          { task_id: "retired-task" },
        ]);
        expect(
          db
            .prepare(
              "SELECT owner_kind, owner_id FROM execution_owner_lifecycle_bindings ORDER BY owner_kind, owner_id",
            )
            .all(),
        ).toEqual([
          { owner_kind: "cron", owner_id: "legacy-null" },
          { owner_kind: "flow", owner_id: "legacy-null" },
          { owner_kind: "task", owner_id: "retired-task" },
        ]);
      });
    },
  );
});

it("normalizes released lifecycle rows before history, recovery, and retention", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "cron-history-row-normalization-" },
    async (state) => {
      const storeKey = cronStoreKey(state.statePath("cron/jobs.json"));
      runOpenClawStateWriteTransaction(({ db }) => {
        const insert = db.prepare(
          "INSERT INTO task_runs (task_id, runtime, owner_key, scope_kind, task, delivery_status, notify_policy, source_id, run_id, agent_id, child_session_key, created_at, started_at, ended_at, last_event_at, status, error, terminal_summary, detail_json) VALUES (?, 'cron', '', 'system', 'job', 'not_applicable', 'silent', 'job', ?, '', '', 200, 100, ?, ?, ?, '', '', ?)",
        );
        for (const status of ["succeeded", "failed", "timed_out", "cancelled", "lost"]) {
          insert.run(
            status,
            `cron:job:100:${status}`,
            null,
            null,
            status,
            JSON.stringify({
              kind: "cron-run",
              status: "ok",
              storeKey,
            }),
          );
        }
        insert.run("clamped", "cron:job:100:clamped", 80, 70, "succeeded", null);
        insert.run("running", "", null, 300, "running", null);
        const records = readCronRunRecordsInDatabase(db);
        for (const status of ["succeeded", "failed", "timed_out", "cancelled", "lost"]) {
          expect(records.find((row) => row.id === status)).toMatchObject({
            createdAt: 100,
            startedAt: 100,
            endedAt: 200,
            agentId: undefined,
            sessionKey: undefined,
            error: undefined,
            summary: "",
          });
        }
        expect(records.find((row) => row.id === "clamped")).toMatchObject({
          createdAt: 70,
          startedAt: 100,
          endedAt: 100,
          lastEventAt: 100,
        });
        expect(records.find((row) => row.id === "running")).toMatchObject({
          createdAt: 100,
          startedAt: 100,
          endedAt: undefined,
          lastEventAt: 300,
          runId: undefined,
        });
        expect(
          findCronRunRecoveryInDatabase({
            database: db,
            storeKey,
            jobId: "job",
            startedAt: 100,
            receiptId: "succeeded",
          }).finalized?.entry.ts,
        ).toBe(200);
        expect(
          projectCronRunHistoryPage(records, { storeKey, jobId: "job" }).entries.map(
            (entry) => entry.ts,
          ),
        ).toEqual([200, 200, 200, 200, 200]);
        const schema = prepareCronRunReceiptWriteSchema(db);
        expect(pruneCronRunHistoryInDatabase(db, 200 + 24 * 60 * 60_000, schema)).toBe(1);
        expect(readCronRunRecordsInDatabase(db).map((row) => row.id)).not.toContain("lost");
        expect(pruneCronRunHistoryInDatabase(db, 200 + 7 * 24 * 60 * 60_000, schema)).toBe(5);
        expect(readCronRunRecordsInDatabase(db).map((row) => row.id)).toEqual(["running"]);
      });
    },
  );
});

it("rejects corrupt released enums before reading or pruning history", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "cron-history-row-enums-" },
    async () => {
      runOpenClawStateWriteTransaction(({ db }) => {
        const columns = [
          ["status", "succeeded", "status"],
          ["scope_kind", "system", "scope kind"],
          ["delivery_status", "not_applicable", "delivery status"],
          ["notify_policy", "silent", "notify policy"],
          ["terminal_outcome", "", "terminal outcome"],
        ];
        db.prepare(
          "INSERT INTO task_runs (task_id, runtime, owner_key, scope_kind, task, delivery_status, notify_policy, created_at, status) VALUES ('corrupt', 'cron', '', 'system', 'job', 'not_applicable', 'silent', 0, 'succeeded')",
        ).run();
        for (const [column, original, label] of columns) {
          db.prepare(`UPDATE task_runs SET ${column} = ?`).run("invalid");
          expect(() => readCronRunRecordsInDatabase(db)).toThrow(
            `Invalid persisted task ${label}: "invalid"`,
          );
          expect(() =>
            pruneCronRunHistoryInDatabase(
              db,
              7 * 24 * 60 * 60_000,
              prepareCronRunReceiptWriteSchema(db),
            ),
          ).toThrow(`Invalid persisted task ${label}: "invalid"`);
          db.prepare(`UPDATE task_runs SET ${column} = ?`).run(original!);
        }
        expect(readCronRunRecordsInDatabase(db)).toHaveLength(1);
      });
    },
  );
});

it("normalizes native SQLite bigint timestamps without rounding unsafe values", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "cron-history-row-bigints-" },
    async () => {
      runOpenClawStateWriteTransaction(({ db }) => {
        const insert = db.prepare(
          "INSERT INTO task_runs (task_id, runtime, owner_key, scope_kind, task, delivery_status, notify_policy, created_at, started_at, ended_at, last_event_at, cleanup_after, status) VALUES (?, 'cron', '', 'system', 'job', 'not_applicable', 'silent', ?, ?, 30, ?, ?, 'succeeded')",
        );
        insert.run("safe", 10, 20, 40, 50);
        insert.run(
          "unsafe",
          9007199254740992n,
          -9007199254740992n,
          9007199254740992n,
          9007199254740992n,
        );
        const prepare = db.prepare.bind(db);
        // Exercise the native integer mode supported by the released row decoder.
        const nativeBigInts = vi.spyOn(db, "prepare").mockImplementation((sql) => {
          const statement = prepare(sql);
          statement.setReadBigInts(true);
          return statement;
        });
        try {
          const records = readCronRunRecordsInDatabase(db);
          expect(records.find((row) => row.id === "safe")).toMatchObject({
            createdAt: 10,
            startedAt: 20,
            endedAt: 30,
            lastEventAt: 40,
            cleanupAfter: 50,
          });
          expect(records.find((row) => row.id === "unsafe")).toMatchObject({
            createdAt: 0,
            startedAt: undefined,
            endedAt: 30,
            lastEventAt: undefined,
            cleanupAfter: undefined,
          });
        } finally {
          nativeBigInts.mockRestore();
        }
      });
    },
  );
});
