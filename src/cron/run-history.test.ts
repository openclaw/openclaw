import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { ensureExecutionOwnerLifecycleBindingSchema } from "../audit/execution-owner-lifecycle-binding-store.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { withOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cronQuietTriggerDetail, cronRunLogEntryToDetail } from "./run-history-detail.js";
import {
  projectCronRunHistoryPage,
  selectCronRunHistoryPage,
  type ReadCronRunHistoryPageOptions,
} from "./run-history.js";
import type { CronRunLogEntry } from "./run-log-types.js";
import { findCronRunRecoveryInDatabase } from "./service/run-history-recovery.js";
import { cronStoreKey } from "./store/key.js";
import { readCronRunHistoryCandidates, readCronRunHistoryRecords } from "./store/read-only.js";
import {
  readCronRunHistoryCandidatesInDatabase,
  readCronRunHistoryRecordsInDatabase,
} from "./store/run-history-read.worker.js";
import { recordCronRun, maintainCronRunHistory } from "./store/run-history.js";
import {
  applyCronRunHistoryMaintenanceInDatabase,
  planCronRunHistoryMaintenance,
  readCronRunRecordsInDatabase,
  recordCronRunInDatabase,
} from "./store/run-history.kernel.js";
import type {
  CronJsonValue,
  CronRunHistoryWrite,
  CronRunRecord,
} from "./store/run-history.types.js";
import {
  prepareCronRunReceiptWriteSchema,
  type CronRunReceiptWriteSchema,
} from "./store/run-receipt-write-admission.js";

const DAY = 24 * 60 * 60_000;
const runIds = (rows: readonly { runId?: string }[]) => rows.map((row) => row.runId);
const taskIds = (rows: readonly { id: string }[]) => rows.map((row) => row.id);
function outcomeDetail(storeKey: string, fields: Partial<CronRunLogEntry>) {
  return cronRunLogEntryToDetail(
    { jobId: "job", action: "finished", ts: 20, status: "ok", ...fields },
    { storeKey },
  );
}
function withHistoryState(fn: (storeKey: string) => Promise<void>) {
  return withOpenClawTestState({ layout: "state-only", prefix: "cron-history-" }, (state) =>
    fn(cronStoreKey(state.statePath("cron/jobs.json"))),
  );
}
function withHistoryDatabase(fn: (db: EngineConnection, storeKey: string) => void) {
  return withHistoryState(async (storeKey) => {
    runOpenClawStateWriteTransaction(({ db }) => fn(db, storeKey));
  });
}
function trackHistoryReads(db: EngineConnection) {
  return trackSqliteStatementExecutions(requireNativeSqliteDatabase(db), ["history"], (sql) =>
    /^select\b/i.test(sql) && sql.includes('from "task_runs"') ? "history" : null,
  );
}
function recover(db: EngineConnection, storeKey: string, receiptId: string, startedAt = 10) {
  return findCronRunRecoveryInDatabase({
    database: db,
    storeKey,
    jobId: "job",
    startedAt,
    receiptId,
  });
}
function historyRecord(id: string, fields: Partial<CronRunRecord> = {}): CronRunRecord {
  return {
    id,
    jobId: "job",
    createdAt: 0,
    status: "succeeded",
    detail: runDetail("store", { runId: id }),
    ...fields,
  };
}
function runDetail(storeKey: string, fields: Record<string, CronJsonValue> = {}) {
  return { kind: "cron-run", storeKey, status: "ok", ...fields };
}
function expectTimestamps(records: CronRunRecord[], id: string, expected: (number | undefined)[]) {
  const row = records.find((record) => record.id === id);
  expect(
    row && [row.createdAt, row.startedAt, row.endedAt, row.lastEventAt, row.cleanupAfter],
  ).toEqual(expected);
}

function pruneHistory(
  db: EngineConnection,
  now: number,
  schema: CronRunReceiptWriteSchema = prepareCronRunReceiptWriteSchema(db),
) {
  const records = readCronRunRecordsInDatabase(db);
  const activeJobs = new Set(records.flatMap((row) => (row.jobId ? [row.jobId] : [])));
  const plan = planCronRunHistoryMaintenance(records, now, activeJobs);
  return applyCronRunHistoryMaintenanceInDatabase(db, plan, now, schema).pruned;
}

async function readCronRunHistoryPage(options: ReadCronRunHistoryPageOptions) {
  const candidates = await readCronRunHistoryCandidates(
    options.storeKey,
    options.jobId,
    options.query,
    options.jobNameById,
  );
  const selected = selectCronRunHistoryPage(candidates.records, {
    ...options,
    queryMatchedTaskIds: candidates.queryMatches ? new Set(candidates.queryMatches) : undefined,
  });
  const records = await readCronRunHistoryRecords(
    options.storeKey,
    selected.records.map((record) => record.id),
    options.view,
  );
  return {
    ...selected.page,
    entries: projectCronRunHistoryPage(records, {
      ...options,
      offset: 0,
      query: undefined,
    }).entries,
  };
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
    detail: outcomeDetail(storeKey, {
      runAtMs: 10,
      completionStatus: "succeeded",
      sessionId: "recorded-generation",
      runId: receipt,
    }),
  };
}

it.each(["asc", "desc"] as const)("orders history timestamps and ties %s", (sortDir) => {
  const records: CronRunRecord[] = [
    historyRecord("tie-a", { createdAt: 5, endedAt: 20 }),
    historyRecord("created-only", { createdAt: 15 }),
    historyRecord("ended", { createdAt: 10, endedAt: 20, lastEventAt: 90 }),
    historyRecord("tie-b", { createdAt: 5, endedAt: 20 }),
    historyRecord("last-event", { lastEventAt: 30 }),
  ];
  const newestFirst = ["last-event", "ended", "tie-b", "tie-a", "created-only"];

  const page = projectCronRunHistoryPage(records, { storeKey: "store", sortDir });

  expect(runIds(page.entries)).toEqual(sortDir === "desc" ? newestFirst : newestFirst.toReversed());
});

it("seeks linked runs before pagination without confusing public ids or ambiguous aliases", () => {
  const record = (id: string, sessionId: string, runAtMs: number, jobId = "job"): CronRunRecord =>
    historyRecord(id, {
      jobId,
      createdAt: runAtMs,
      endedAt: runAtMs + 1,
      detail: runDetail("store", { runId: id, sessionId, runAtMs }),
    });
  const target = record("target", "target-session", 10);
  const records = [
    target,
    ...Array.from({ length: 50 }, (_, i) => record(`recent-${i}`, `session-${i}`, 100 + i)),
  ];
  const seek = (
    runId: string,
    extra: CronRunRecord[] = [],
    entryFilter?: ReadCronRunHistoryPageOptions["entryFilter"],
  ) =>
    runIds(
      projectCronRunHistoryPage([...records, ...extra], {
        storeKey: "store",
        jobId: "job",
        runId,
        limit: 1,
        entryFilter,
      }).entries,
    );
  for (const alias of ["target", "target-session", "cron:job:10"]) {
    expect(seek(alias)).toEqual(["target"]);
  }
  expect(seek("cron:other:10")).toEqual([]);
  expect(seek("target-session", [record("collision", "target-session", 20)])).toEqual([]);
  expect(seek("cron:job:10", [record("same-start", "another-session", 10)])).toEqual([]);
  expect(
    seek(
      "target-session",
      [record("hidden", "target-session", 20)],
      (entry) => entry.runId === "target",
    ),
  ).toEqual([]);
  expect(seek("target", [record("alias-collision", "target", 20)])).toEqual(["target"]);
  expect(seek("target-session", [record("other-job", "target-session", 20, "other")])).toEqual([
    "target",
  ]);
  expect(seek("target", [], () => false)).toEqual([]);
});

it("retains history across worker reads, isolates stores, and recovers only an exact receipt", () =>
  withHistoryState(async (storeKey) => {
    runOpenClawStateWriteTransaction(({ db }) => {
      recordCronRunInDatabase(db, outcome(storeKey, "first"));
      recordCronRunInDatabase(db, outcome(storeKey, "second"));
      recordCronRunInDatabase(db, outcome(storeKey + "-other", "first"));
      const recovered = recover(db, storeKey, "second");
      expect(recovered.finalized?.entry).toMatchObject({
        runId: "second",
        sessionId: "recorded-generation",
      });
      expect(recover(db, storeKey, "missing").finalized).toBeUndefined();
      // A late result cannot replace the first durable outcome for this exact run.
      const reads = trackHistoryReads(db);
      try {
        recordCronRunInDatabase(db, {
          ...outcome(storeKey, "first"),
          status: "failed",
          endedAt: 40,
        });
        // Both stores can retain this run ID; unrelated runs must stay in SQLite.
        expect(reads.rowCounts.history).toBe(2);
      } finally {
        reads.restore();
      }
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
    await recordCronRun(outcome(storeKey, "third"));
    const refreshed = await readCronRunHistoryPage({ storeKey, jobId: "job" });
    expect(refreshed.total).toBe(3);
    expect(runIds(refreshed.entries)).toEqual(expect.arrayContaining(["first", "second", "third"]));
    const updated = outcome(storeKey, "third");
    await recordCronRun({
      ...updated,
      detail: outcomeDetail(storeKey, {
        ts: updated.endedAt,
        runId: "third",
        summary: "Fresh delivery result",
        deliveryStatus: "delivered",
      }),
    });
    const delivered = await readCronRunHistoryPage({
      storeKey,
      jobId: "job",
      deliveryStatus: "delivered",
    });
    expect(delivered.total).toBe(1);
    expect(delivered.entries).toMatchObject([
      { runId: "third", summary: "Fresh delivery result", deliveryStatus: "delivered" },
    ]);
  }));

it("pages large history without reading off-page payloads or changing completion order", () =>
  withHistoryState(async (storeKey) => {
    const payload = "diagnostic-payload:" + "x".repeat(16 * 1024);
    runOpenClawStateWriteTransaction(({ db }) => {
      const insert = db.prepare(
        "INSERT INTO task_runs (task_id, runtime, owner_key, scope_kind, task, delivery_status, notify_policy, source_id, created_at, started_at, ended_at, status, detail_json) VALUES (?, 'cron', '', 'system', 'job', 'not_applicable', 'silent', ?, ?, ?, ?, 'succeeded', ?)",
      );
      // Cover a large history with ties and released timestamps whose
      // normalization differs from the raw indexed created_at.
      for (let index = 0; index < 520; index += 1) {
        const id = String(index).padStart(3, "0");
        insert.run(
          `run-${id}`,
          "job",
          1000 + Math.floor(index / 2),
          100 + Math.floor(index / 2),
          index === 0 ? 9000 : 3000 + Math.floor(index / 2),
          JSON.stringify(
            runDetail(storeKey, {
              runId: `public-${id}`,
              diagnostics: {
                summary: index === 7 ? "diagnostic-only-needle" : "Run diagnostics",
                entries: [{ ts: 1, source: "tool", severity: "error", message: payload }],
              },
              delivery: { intended: { channel: "test-channel" } },
              scriptState: "recovery-only:" + payload,
            }),
          ),
        );
      }
      for (const [id, partition] of [
        ["other-job", storeKey],
        ["other-store", "unrelated"],
      ] as const) {
        insert.run(
          id,
          "other",
          10_000,
          10_000,
          11_000,
          JSON.stringify(runDetail(partition, { runId: id })),
        );
      }
    });
    withOpenClawStateDatabaseReadOnly(({ db }) => {
      const reads = trackHistoryReads(db);
      try {
        const cases: [Partial<ReadCronRunHistoryPageOptions>, string[], number][] = [
          [{}, ["public-000", "public-519"], 520],
          [{ offset: 518, view: "summary" }, ["public-002", "public-001"], 520],
          [{ jobId: undefined, view: "summary" }, ["other-job", "public-000"], 521],
          [
            { view: "summary", entryFilter: (entry) => entry.runId !== "public-000" },
            ["public-519", "public-518"],
            519,
          ],
        ];
        for (const [overrides, expected, total] of cases) {
          const options = { storeKey, jobId: "job", limit: 2, ...overrides };
          const beforeCandidates = reads.textBytes.history;
          const beforeCandidateReads = reads.counts.history;
          const candidates = readCronRunHistoryCandidatesInDatabase(db, storeKey, options.jobId);
          expect(reads.counts.history - beforeCandidateReads).toBe(1);
          expect(reads.textBytes.history - beforeCandidates).toBeLessThan(256 * 1024);
          const selected = selectCronRunHistoryPage(candidates.records, options);
          expect(runIds(selected.page.entries)).toEqual(expected);
          expect(selected.page).toMatchObject({
            total,
            offset: options.offset ?? 0,
            hasMore: (options.offset ?? 0) + 2 < total,
          });
          const beforeDetails = reads.textBytes.history;
          const beforeRows = reads.rowCounts.history;
          const records = readCronRunHistoryRecordsInDatabase(
            db,
            storeKey,
            taskIds(selected.records),
            options.view,
          );
          expect(reads.rowCounts.history - beforeRows).toBe(2);
          expect(reads.textBytes.history - beforeDetails).toBeLessThan(
            options.view === "summary" ? 2048 : 40 * 1024,
          );
          expect(JSON.stringify(records)).not.toContain("recovery-only:");
          const page = projectCronRunHistoryPage(records, { ...options, offset: 0 });
          expect(runIds(page.entries)).toEqual(expected);
          if (options.view === "summary") {
            expect(JSON.stringify(records)).not.toContain("diagnostic-payload:");
            expect(page.entries.every((entry) => !entry.diagnostics && !entry.delivery)).toBe(true);
          } else {
            expect(page.entries[0]?.diagnostics?.entries[0]?.message).toContain(
              "diagnostic-payload:",
            );
          }
        }
        const beforeSearchReads = reads.counts.history;
        const search = readCronRunHistoryCandidatesInDatabase(
          db,
          storeKey,
          "job",
          "diagnostic-only-needle",
        );
        expect(reads.counts.history - beforeSearchReads).toBe(1);
        expect(JSON.stringify(search.records)).not.toContain("diagnostic-payload:");
        const matching = selectCronRunHistoryPage(search.records, {
          storeKey,
          jobId: "job",
          query: "diagnostic-only-needle",
          view: "summary",
          queryMatchedTaskIds: new Set(search.queryMatches),
        });
        expect(matching.page.total).toBe(1);
        expect(matching.page.entries).toMatchObject([{ runId: "public-007" }]);
      } finally {
        reads.restore();
      }
    });
  }));

it("bounds quiet evaluations separately without evicting payload history or active recovery markers", () =>
  withHistoryDatabase((db) => {
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
      pruneHistory(db, now, schema);
      const remaining = new Set(taskIds(readCronRunRecordsInDatabase(db)));
      return new Set(records.filter((row) => !remaining.has(row.id)).map((row) => row.id));
    };
    const records = Array.from({ length: 2001 }, (_, index) =>
      historyRecord(String(index), {
        createdAt: index,
        endedAt: index,
        detail: cronQuietTriggerDetail("store", { fired: false, stateChanged: false }),
      }),
    );
    const history = historyRecord("history", {
      endedAt: 0,
      detail: outcome("store", "history").detail,
    });
    const active = historyRecord("active", { status: "running", detail: undefined });
    const otherStore = {
      ...records[0]!,
      id: "other-store",
      detail: cronQuietTriggerDetail("other", { fired: false, stateChanged: false }),
    };
    const otherJob = { ...records[0]!, id: "other-job", jobId: "other" };
    expect(pruneRecords([...records, history, active, otherStore, otherJob], 3000)).toEqual(
      new Set(["0"]),
    );
    expect(pruneRecords([history, active], 7 * DAY)).toEqual(new Set(["history"]));
    const lost: CronRunRecord = {
      ...history,
      id: "lost",
      status: "lost",
      cleanupAfter: 7 * DAY,
    };
    expect(pruneRecords([history, lost], DAY - 1)).toEqual(new Set());
    expect(pruneRecords([history, lost], DAY)).toEqual(new Set(["lost"]));
    expect(
      projectCronRunHistoryPage([...records, history], { storeKey: "store", jobId: "job" }).total,
    ).toBe(1);
    for (const jobId of [null, ""]) {
      for (const record of records) {
        record.jobId = jobId;
      }
      expect(pruneRecords(records, 3000)).toEqual(new Set());
      expect(pruneRecords(records, 7 * DAY)).toEqual(new Set(["0"]));
    }
  }));

it("retains history when worker pruning fails and retries after storage recovers", () =>
  withHistoryState(async (storeKey) => {
    await recordCronRun(outcome(storeKey, "worker"));
    const before = await readCronRunHistoryPage({ storeKey });
    expect(before.total).toBe(1);
    const context = captureOpenClawStateWorkerContext();
    const maintain = () => maintainCronRunHistory(context, context.admission.assertCurrent);
    runOpenClawStateWriteTransaction(({ db }) => {
      db.exec(`
          CREATE TRIGGER reject_cron_history_pruning
          BEFORE DELETE ON task_runs
          BEGIN
            SELECT RAISE(ABORT, 'Cron history pruning refused');
          END;
        `);
    });
    try {
      await expect(maintain()).rejects.toThrow("Cron history pruning refused");
      expect(await readCronRunHistoryPage({ storeKey })).toEqual(before);
    } finally {
      runOpenClawStateWriteTransaction(({ db }) => {
        db.exec("DROP TRIGGER reject_cron_history_pruning");
      });
    }
    await maintain();
    expect((await readCronRunHistoryPage({ storeKey })).entries).toEqual([]);
  }));

it("retains legacy identities and raw details without inventing a store partition", () =>
  withHistoryDatabase((db) => {
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
    expect(projectCronRunHistoryPage(records, { storeKey: "current-store" }).entries).toEqual([]);
    expect(pruneHistory(db, 11)).toBe(0);
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
    expect(pruneHistory(db, 10 + 7 * DAY)).toBe(3);
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
  }));

it("normalizes released lifecycle rows before history, recovery, and retention", () =>
  withHistoryDatabase((db, storeKey) => {
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
        JSON.stringify(runDetail(storeKey)),
      );
    }
    insert.run("clamped", "cron:job:100:clamped", 80, 70, "succeeded", null);
    insert.run("running", "", null, 300, "running", null);
    const records = readCronRunRecordsInDatabase(db);
    for (const status of ["succeeded", "failed", "timed_out", "cancelled", "lost"]) {
      expectTimestamps(records, status, [100, 100, 200, undefined, undefined]);
      expect(records.find((row) => row.id === status)).toMatchObject({
        agentId: undefined,
        sessionKey: undefined,
        error: undefined,
        summary: "",
      });
    }
    expectTimestamps(records, "clamped", [70, 100, 100, 100, undefined]);
    expectTimestamps(records, "running", [100, 100, undefined, 300, undefined]);
    expect(records.find((row) => row.id === "running")?.runId).toBeUndefined();
    expect(recover(db, storeKey, "succeeded", 100).finalized?.entry.ts).toBe(200);
    expect(
      projectCronRunHistoryPage(records, { storeKey, jobId: "job" }).entries.map(
        (entry) => entry.ts,
      ),
    ).toEqual([200, 200, 200, 200, 200]);
    const schema = prepareCronRunReceiptWriteSchema(db);
    expect(pruneHistory(db, 200 + DAY, schema)).toBe(1);
    expect(taskIds(readCronRunRecordsInDatabase(db))).not.toContain("lost");
    expect(pruneHistory(db, 200 + 7 * DAY, schema)).toBe(5);
    expect(taskIds(readCronRunRecordsInDatabase(db))).toEqual(["running"]);
  }));

it("rejects corrupt released enums before reading or pruning history", () =>
  withHistoryDatabase((db) => {
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
      expect(() => pruneHistory(db, 7 * DAY)).toThrow(`Invalid persisted task ${label}: "invalid"`);
      db.prepare(`UPDATE task_runs SET ${column} = ?`).run(original!);
    }
    expect(readCronRunRecordsInDatabase(db)).toHaveLength(1);
  }));

it("normalizes native SQLite bigint timestamps without rounding unsafe values", () =>
  withHistoryDatabase((db) => {
    const insert = db.prepare(
      "INSERT INTO task_runs (task_id, runtime, owner_key, scope_kind, task, delivery_status, notify_policy, created_at, started_at, ended_at, last_event_at, cleanup_after, status) VALUES (?, 'cron', '', 'system', 'job', 'not_applicable', 'silent', ?, ?, 30, ?, ?, 'succeeded')",
    );
    insert.run("safe", 10, 20, 40, 50);
    const unsafe = 9007199254740992n;
    insert.run("unsafe", unsafe, -unsafe, unsafe, unsafe);
    const nativeDb = requireNativeSqliteDatabase(db);
    const prepare = nativeDb.prepare.bind(nativeDb);
    // Exercise the native integer mode supported by the released row decoder.
    const nativeBigInts = vi.spyOn(nativeDb, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      statement.setReadBigInts(true);
      return statement;
    });
    try {
      const records = readCronRunRecordsInDatabase(db);
      expectTimestamps(records, "safe", [10, 20, 30, 40, 50]);
      expectTimestamps(records, "unsafe", [0, undefined, 30, undefined, undefined]);
    } finally {
      nativeBigInts.mockRestore();
    }
  }));
