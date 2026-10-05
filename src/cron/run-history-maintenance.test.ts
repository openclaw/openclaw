import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { StatementSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  observeSqliteReadSql,
  trackSqliteStatementExecutions,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resetCronActiveJobs } from "./active-jobs.js";
import { pruneCronRunHistoryBatchInDatabase } from "./store/run-history-maintenance.kernel.js";
import { maintainCronRunHistory } from "./store/run-history.js";
import {
  pruneCronRunHistoryInDatabase,
  readCronRunReconcileCandidatesInDatabase,
  readCronRunRecordsInDatabase,
  reconcileCronRunHistoryInDatabase,
} from "./store/run-history.kernel.js";
import type { CronRunOverflowCursor } from "./store/run-history.types.js";
import { prepareCronRunReceiptWriteSchema } from "./store/run-receipt-write-admission.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-04T12:00:00Z");

beforeEach(() => {
  resetCronActiveJobs();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  resetCronActiveJobs();
});

type Shape = { retained: number; expired: number; capExtra?: number; seed?: number };

/** Synthetic rows only: retained/expired history, one over-cap job, stale and legacy rows. */
function seedHistory(db: DatabaseSync, shape: Shape) {
  let state = (shape.seed ?? 7) >>> 0;
  const random = () => (state = (state * 1_664_525 + 1_013_904_223) >>> 0) / 2 ** 32;
  const insert = db.prepare(
    "INSERT INTO task_runs (task_id, runtime, source_id, run_id, owner_key, scope_kind, task, delivery_status, notify_policy, created_at, started_at, ended_at, last_event_at, cleanup_after, status, error, terminal_summary, detail_json) VALUES (?, 'cron', ?, ?, '', 'system', 'job', 'not_applicable', 'silent', ?, ?, ?, ?, ?, ?, ?, 'ok', ?)",
  );
  let seq = 0;
  const add = (row: {
    job: string | null;
    endedAt: number | null;
    status: string;
    cleanupAfter: number | null;
    startedAt?: number;
    lastEventAt?: number;
    runId?: string;
    error?: string;
  }) => {
    const id = `row-${String(seq).padStart(6, "0")}-${Math.floor(random() * 1e9)}`;
    const startedAt = row.startedAt ?? (row.endedAt ?? NOW) - 1_000 - Math.floor(random() * 60_000);
    insert.run(
      id,
      row.job,
      row.runId ?? `run-${seq}`,
      startedAt,
      startedAt,
      row.endedAt,
      row.lastEventAt ?? row.endedAt ?? startedAt,
      row.cleanupAfter,
      row.status,
      row.error ?? null,
      JSON.stringify({ kind: "cron-run", storeKey: "store", seq }),
    );
    seq += 1;
    return id;
  };
  const terminal = () => {
    const pick = random();
    return pick < 0.9
      ? "succeeded"
      : pick < 0.95
        ? "failed"
        : pick < 0.98
          ? "timed_out"
          : "cancelled";
  };
  for (let index = 0; index < shape.retained; index += 1) {
    const endedAt = NOW - Math.floor(random() * (7 * DAY - HOUR));
    add({ job: `job-${index % 40}`, endedAt, status: terminal(), cleanupAfter: endedAt + 7 * DAY });
  }
  for (let index = 0; index < shape.expired; index += 1) {
    const endedAt = NOW - 7 * DAY - HOUR - Math.floor(random() * 3 * DAY);
    add({ job: `job-${index % 40}`, endedAt, status: terminal(), cleanupAfter: endedAt + 7 * DAY });
  }
  for (let index = 0; index < 2_000 + (shape.capExtra ?? 60); index += 1) {
    const endedAt = NOW - Math.floor(random() * (7 * DAY - HOUR));
    add({ job: "job-capped", endedAt, status: "succeeded", cleanupAfter: endedAt + 7 * DAY });
  }
  for (let index = 0; index < 5; index += 1) {
    add({
      job: `job-${index}`,
      endedAt: null,
      status: "running",
      cleanupAfter: null,
      lastEventAt: NOW - HOUR,
    });
  }
  // Recovery: an old queued duplicate adopts its durable terminal result, which is already expired.
  add({
    job: "job-recover",
    endedAt: NOW - 9 * DAY,
    status: "succeeded",
    cleanupAfter: NOW - 2 * DAY,
    runId: "shared",
  });
  add({
    job: "job-recover",
    endedAt: null,
    status: "queued",
    cleanupAfter: null,
    lastEventAt: NOW - HOUR,
    runId: "shared",
  });
  // Lost rows use the shorter bound; released rows may lack cleanup_after or a job identity.
  add({
    job: "job-lost",
    endedAt: NOW - 2 * DAY,
    status: "lost",
    cleanupAfter: NOW + DAY,
    error: "backing session missing",
  });
  add({ job: "job-lost", endedAt: NOW - 2 * HOUR, status: "lost", cleanupAfter: null });
  add({ job: "job-undated", endedAt: NOW - 8 * DAY, status: "failed", cleanupAfter: null });
  add({
    job: "job-undated",
    endedAt: NOW - 8 * DAY,
    startedAt: NOW - 6 * DAY,
    status: "failed",
    cleanupAfter: null,
  });
  add({ job: null, endedAt: NOW - 8 * DAY, status: "succeeded", cleanupAfter: NOW - DAY });
}

function fingerprint(db: DatabaseSync) {
  const rows = db
    .prepare(
      "SELECT task_id, status, created_at, started_at, ended_at, last_event_at, cleanup_after, error, terminal_summary, detail_json FROM task_runs ORDER BY task_id",
    )
    .all();
  return {
    count: rows.length,
    hash: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
  };
}

function seed(shape: Shape) {
  runOpenClawStateWriteTransaction(({ db }) => {
    db.exec("DELETE FROM task_runs");
    seedHistory(db, shape);
  });
}

/** The former single-transaction sweep, evaluated and rolled back on the same rows. */
function baselineFingerprint() {
  return runOpenClawStateWriteTransaction(({ db }) => {
    db.exec("SAVEPOINT baseline");
    try {
      const records = readCronRunRecordsInDatabase(db);
      const reconciled = reconcileCronRunHistoryInDatabase(db, records, NOW, new Set());
      pruneCronRunHistoryInDatabase(
        db,
        NOW,
        prepareCronRunReceiptWriteSchema(db),
        records.filter((row) => !reconciled.has(row.id)),
      );
      return fingerprint(db);
    } finally {
      db.exec("ROLLBACK TO baseline");
      db.exec("RELEASE baseline");
    }
  });
}

function readExpired() {
  return runOpenClawStateWriteTransaction(({ db }) =>
    db
      .prepare(
        "SELECT task_id, cleanup_after FROM task_runs WHERE cleanup_after <= ? ORDER BY cleanup_after",
      )
      .all(NOW),
  ) as Array<{ task_id: string; cleanup_after: number }>;
}

const maintain = (options: Parameters<typeof maintainCronRunHistory>[2] = {}) =>
  maintainCronRunHistory(captureOpenClawStateWorkerContext(), () => {}, {
    batchSize: 64,
    budgetMs: Number.POSITIVE_INFINITY,
    ...options,
  });

/** Counts committed batches and lets a test act at the Nth commit request. */
function interceptCommits(onCommit: (count: number) => void) {
  const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
  let commits = 0;
  const spy = vi
    .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) =>
      createAdmission((request, grant) => {
        if (request.stage === "commit") {
          commits += 1;
          onCommit(commits);
        }
        admit(request, grant);
      }, attachment),
    );
  return { commits: () => commits, restore: () => spy.mockRestore() };
}

it("leaves the same rows as the single-transaction sweep across history shapes", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "cron-history-batches-" },
    async () => {
      for (const shape of [
        { retained: 300, expired: 20 },
        { retained: 200, expired: 900 },
        { retained: 900, expired: 150 },
        { retained: 1_500, expired: 700, capExtra: 200 },
      ]) {
        seed(shape);
        const seeded = runOpenClawStateWriteTransaction(({ db }) => fingerprint(db)).count;
        const expected = baselineFingerprint();
        // Expired rows and the over-cap job's oldest rows leave in both paths.
        expect(expected.count).toBeLessThanOrEqual(seeded - shape.expired - (shape.capExtra ?? 60));
        const commits = interceptCommits(() => {});
        try {
          await maintain();
          const actual = runOpenClawStateWriteTransaction(({ db }) => fingerprint(db));
          expect(actual).toEqual(expected);
          expect(commits.commits()).toBeGreaterThan(1);
        } finally {
          commits.restore();
        }
      }
    },
  );
});

it("skips rows the kernel cannot decode instead of failing every sweep", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "cron-history-poison-" },
    async () => {
      seed({ retained: 50, expired: 200, capExtra: 0 });
      runOpenClawStateWriteTransaction(({ db }) => {
        db.prepare(
          "INSERT INTO task_runs (task_id, runtime, source_id, owner_key, scope_kind, task, delivery_status, notify_policy, created_at, ended_at, cleanup_after, status) VALUES (?, 'cron', 'job-poison', '', 'system', 'job', ?, 'silent', 1, 1, 2, ?)",
        ).run("poison-status", "not_applicable", "paused");
        db.prepare(
          "INSERT INTO task_runs (task_id, runtime, source_id, owner_key, scope_kind, task, delivery_status, notify_policy, created_at, ended_at, cleanup_after, status) VALUES (?, 'cron', 'job-poison', '', 'system', 'job', ?, 'silent', 1, 1, 2, ?)",
        ).run("poison-delivery", "unknown", "succeeded");
        // The whole-table path still refuses the table, as before.
        expect(() => readCronRunRecordsInDatabase(db)).toThrow("Invalid persisted task");
      });
      await maintain();
      await maintain();
      const remaining = runOpenClawStateWriteTransaction(({ db }) =>
        db
          .prepare("SELECT task_id FROM task_runs WHERE cleanup_after <= ? ORDER BY task_id")
          .all(NOW),
      );
      expect(remaining).toEqual([{ task_id: "poison-delivery" }, { task_id: "poison-status" }]);
    },
  );
});

it("stops between batches on abort or budget and keeps retention monotonic", async () => {
  await withOpenClawTestState({ layout: "state-only", prefix: "cron-history-abort-" }, async () => {
    seed({ retained: 100, expired: 600, capExtra: 0 });
    const before = readExpired();
    const controller = new AbortController();
    const commits = interceptCommits((count) => {
      if (count === 2) {
        controller.abort();
      }
    });
    try {
      await maintain({ signal: controller.signal });
      expect(commits.commits()).toBe(2);
      await maintain({ budgetMs: 0 });
      expect(commits.commits()).toBe(3);
    } finally {
      commits.restore();
    }
    const remaining = new Set(readExpired().map((row) => row.task_id));
    const deleted = before.filter((row) => !remaining.has(row.task_id));
    const after = before.filter((row) => remaining.has(row.task_id));
    expect(after.length).toBeGreaterThan(0);
    expect(deleted.length).toBeGreaterThan(0);
    expect(Math.max(...deleted.map((row) => row.cleanup_after))).toBeLessThanOrEqual(
      Math.min(...after.map((row) => row.cleanup_after)),
    );
    expect(
      runOpenClawStateWriteTransaction(({ db }) => db.prepare("PRAGMA integrity_check").get()),
    ).toEqual({ integrity_check: "ok" });
    await maintain();
    expect(readExpired()).toEqual([]);
  });
});

it("keeps committed batches when a later batch fails and resumes on the next sweep", async () => {
  await withOpenClawTestState({ layout: "state-only", prefix: "cron-history-retry-" }, async () => {
    seed({ retained: 100, expired: 600, capExtra: 0 });
    const expected = baselineFingerprint();
    const before = readExpired().length;
    const commits = interceptCommits((count) => {
      if (count === 4) {
        throw new Error("injected batch failure");
      }
    });
    try {
      await expect(maintain()).rejects.toThrow("injected batch failure");
    } finally {
      commits.restore();
    }
    // The three batches committed before the failure stay committed.
    expect(readExpired().length).toBe(before - 3 * 64);
    await maintain();
    expect(runOpenClawStateWriteTransaction(({ db }) => fingerprint(db))).toEqual(expected);
  });
});

it("bounds payload reads per batch for a concentrated backlog with large details", async () => {
  await withOpenClawTestState({ layout: "state-only", prefix: "cron-history-heavy-" }, async () => {
    const summary = "x".repeat(4_096);
    runOpenClawStateWriteTransaction(({ db }) => {
      db.exec("DELETE FROM task_runs");
      const insert = db.prepare(
        "INSERT INTO task_runs (task_id, runtime, source_id, run_id, owner_key, scope_kind, task, delivery_status, notify_policy, created_at, started_at, ended_at, last_event_at, cleanup_after, status, detail_json) VALUES (?, 'cron', ?, ?, '', 'system', 'job', 'not_applicable', 'silent', ?, ?, ?, ?, ?, 'succeeded', ?)",
      );
      const add = (id: string, job: string, endedAt: number, detail: unknown) =>
        insert.run(
          id,
          job,
          `run-${id}`,
          endedAt - 1_000,
          endedAt - 1_000,
          endedAt,
          endedAt,
          endedAt + 7 * DAY,
          JSON.stringify(detail),
        );
      // One job carries 2,000 retained rows plus a 1,508-row backlog, all with large details.
      for (let index = 0; index < 3_500; index += 1) {
        add(`heavy-${index}`, "job-heavy", NOW - HOUR - index * 1_000, {
          kind: "cron-run",
          storeKey: "store",
          summary,
        });
      }
      // Legacy undated rows normalize to their last event, so they are the oldest overflow.
      for (let index = 0; index < 8; index += 1) {
        const lastEventAt = NOW - 2 * DAY - index * 1_000;
        insert.run(
          `undated-${index}`,
          "job-heavy",
          `run-undated-${index}`,
          lastEventAt - 1_000,
          lastEventAt - 1_000,
          null,
          lastEventAt,
          lastEventAt + 7 * DAY,
          JSON.stringify({ kind: "cron-run", storeKey: "store", summary }),
        );
      }
      // Run history and quiet evaluations are separate partitions, each under the cap.
      for (let index = 0; index < 2_400; index += 1) {
        add(
          `split-${index}`,
          "job-split",
          NOW - HOUR - index * 1_000,
          index % 2 === 0
            ? { kind: "cron-run", storeKey: "store", summary }
            : { storeKey: "store", triggerFired: false, triggerStateChanged: false },
        );
      }
    });
    const expected = baselineFingerprint();
    const payloadRows: number[] = [];
    const rankedRows: number[] = [];
    const settled: string[] = [];
    let cursors: CronRunOverflowCursor[] = [];
    for (let more = true; more;) {
      more = runOpenClawStateWriteTransaction(({ db }) => {
        const counter = trackSqliteStatementExecutions(db, ["payload", "ranked"], (sql) =>
          sql.includes('"detail_json"')
            ? "payload"
            : sql.includes('"source_id" = ?') && !sql.includes("limit")
              ? "ranked"
              : null,
        );
        try {
          const batch = pruneCronRunHistoryBatchInDatabase(
            db,
            NOW,
            prepareCronRunReceiptWriteSchema(db),
            { limit: 256, exclude: [], settled, cursors },
          );
          settled.push(...batch.settled);
          ({ cursors } = batch);
          payloadRows.push(counter.rowCounts.payload);
          rankedRows.push(counter.rowCounts.ranked);
          return batch.more;
        } finally {
          counter.restore();
        }
      });
    }
    // The heavy job is ranked once, continued by index-ordered scans that rank nothing and
    // decode only the rows they delete, then ranked once more, without its backlog, to settle.
    expect(rankedRows).toEqual([3_508, 0, 0, 0, 0, 2_000, 2_400]);
    expect(payloadRows).toEqual([2_304, 264, 256, 256, 256, 229, 1_024]);
    expect(settled).toEqual(["job-heavy", "job-split"]);
    expect(runOpenClawStateWriteTransaction(({ db }) => fingerprint(db))).toEqual(expected);
    const remaining = runOpenClawStateWriteTransaction(({ db }) =>
      db
        .prepare(
          "SELECT source_id, count(*) AS count, min(ended_at) AS oldest FROM task_runs GROUP BY source_id ORDER BY source_id",
        )
        .all(),
    );
    expect(remaining).toEqual([
      // Only the backlog left: the heavy job keeps exactly its newest 2,000 rows.
      { source_id: "job-heavy", count: 2_000, oldest: NOW - HOUR - 1_999 * 1_000 },
      { source_id: "job-split", count: 2_400, oldest: NOW - HOUR - 2_399 * 1_000 },
    ]);
  });
});

it("keeps every maintenance select on its narrow index without table statistics", async () => {
  await withOpenClawTestState({ layout: "state-only", prefix: "cron-history-plan-" }, async () => {
    seed({ retained: 20, expired: 20, capExtra: 3 });
    runOpenClawStateWriteTransaction(({ db }) => {
      const observation = observeSqliteReadSql(StatementSync.prototype);
      try {
        readCronRunReconcileCandidatesInDatabase(db);
        const schema = prepareCronRunReceiptWriteSchema(db);
        // A full first batch leaves a cursor, so the second batch runs the overflow scan.
        const { cursors } = pruneCronRunHistoryBatchInDatabase(db, NOW, schema, {
          limit: 1,
          exclude: ["excluded"],
        });
        expect(cursors).toHaveLength(1);
        pruneCronRunHistoryBatchInDatabase(db, NOW, schema, {
          limit: 1_000,
          exclude: ["excluded"],
          cursors,
        });
      } finally {
        observation.restore();
      }
      const plans = observation.queries.map((sql) => ({
        sql,
        plan: (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
          .map((row) => row.detail)
          .join("\n"),
      }));
      const planFor = (fragment: string) => plans.find(({ sql }) => sql.includes(fragment))?.plan;
      // Without the unary-plus pins SQLite picks (runtime, status) and walks every Cron row.
      expect({
        reconcile: planFor('"status" in (?, ?, ?)'),
        sharedRuns: planFor('"run_id" in'),
        cappedJobs: planFor('group by "source_id"'),
        cappedRows: planFor('"source_id" = ?'),
        cappedDetails: planFor('select "task_id", "detail_json"'),
        undatedScan: planFor('"ended_at" is null'),
        datedScan: planFor('"ended_at" <= ?'),
        expired: planFor('"cleanup_after" <='),
        lost: planFor('"status" = ?'),
        undated: planFor('"cleanup_after" is null'),
      }).toEqual({
        reconcile: expect.stringContaining("idx_task_runs_runtime_status (runtime=? AND status=?)"),
        sharedRuns: expect.stringContaining("idx_task_runs_run_id (run_id=?)"),
        cappedJobs: expect.stringContaining("COVERING INDEX idx_task_runs_runtime_source_ended"),
        cappedRows: expect.stringContaining("idx_task_runs_runtime_source_ended (runtime=? AND"),
        cappedDetails: expect.stringContaining("sqlite_autoindex_task_runs_1 (task_id=?)"),
        undatedScan: expect.stringContaining(
          "idx_task_runs_runtime_source_ended (runtime=? AND source_id=? AND ended_at=?)",
        ),
        datedScan: expect.stringContaining(
          "idx_task_runs_runtime_source_ended (runtime=? AND source_id=? AND ended_at<?)",
        ),
        expired: expect.stringContaining("idx_task_runs_cleanup_after (cleanup_after<?)"),
        lost: expect.stringContaining("idx_task_runs_runtime_status (runtime=? AND status=?)"),
        undated: expect.stringContaining("idx_task_runs_cleanup_after (cleanup_after=?)"),
      });
      expect(plans.filter(({ plan }) => /SCAN task_runs(?! USING COVERING)/.test(plan))).toEqual(
        [],
      );
      // The overflow scan reads in index order, so continuing a job never sorts its backlog.
      expect([planFor('"ended_at" is null'), planFor('"ended_at" <= ?')]).not.toContainEqual(
        expect.stringContaining("TEMP B-TREE"),
      );
    });
  });
});
