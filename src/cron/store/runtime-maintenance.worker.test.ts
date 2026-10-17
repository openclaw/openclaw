import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { readSqliteDatabaseWriteRevision } from "../../infra/sqlite-database-admission.js";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { maintainCronRunHistoryInWorker } from "./runtime-maintenance.worker.js";

it.each(["empty", "retained", "expired"] as const)(
  "does not invalidate shared readers unless history maintenance changes rows: %s",
  async (history) => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "cron-history-no-recovery-" },
      async (state) => {
        const database = openOpenClawStateDatabase();
        const day = 24 * 60 * 60_000;
        const nowMs = 10 * day;
        if (history !== "empty") {
          const endedAt = nowMs - (history === "expired" ? 8 : 1) * day;
          database.db
            .prepare(
              "INSERT INTO task_runs (task_id, runtime, source_id, owner_key, scope_kind, task, delivery_status, notify_policy, created_at, ended_at, status) VALUES ('terminal', 'cron', 'job', '', 'system', 'legacy', 'not_applicable', 'silent', ?, ?, 'succeeded')",
            )
            .run(endedAt, endedAt);
        }
        const revision = readSqliteDatabaseWriteRevision(database.db);
        expect(revision).toBeTypeOf("number");
        const exec = vi.spyOn(database.db, "exec");
        const reads = trackSqliteStatementExecutions(
          requireNativeSqliteDatabase(database.db),
          ["history", "receipts"],
          (sql) => {
            if (!/^select\b/i.test(sql)) {
              return null;
            }
            if (sql.includes('from "cron_run_receipts"')) {
              return "receipts";
            }
            return sql.includes('from "task_runs"') ? "history" : null;
          },
        );
        try {
          const result = runWithSqliteWorkerStateContext(
            { environment: { OPENCLAW_STATE_DIR: state.stateDir } },
            () =>
              maintainCronRunHistoryInWorker(database, {
                snapshot: {
                  nowMs,
                  protectedJobIds: [],
                },
              }),
          );
          expect(result).toEqual({
            outcome: {
              reconciled: 0,
              pruned: history === "expired" ? 1 : 0,
              nextSweepAtMs: history === "retained" ? nowMs + 6 * day : null,
            },
          });
          expect(reads.counts).toEqual({ history: 1, receipts: 0 });
          expect(exec.mock.calls.some(([sql]) => /^\s*BEGIN\b/i.test(sql))).toBe(
            history === "expired",
          );
          if (history === "expired") {
            expect(readSqliteDatabaseWriteRevision(database.db)).not.toBe(revision);
          } else {
            expect(readSqliteDatabaseWriteRevision(database.db)).toBe(revision);
          }
          expect(database.db.prepare("SELECT task_id FROM task_runs").all()).toEqual(
            history === "retained" ? [{ task_id: "terminal" }] : [],
          );
        } finally {
          reads.restore();
          exec.mockRestore();
        }
      },
    );
  },
);

it("plans without retained payloads and reconciles with the full payloads of affected runs", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "cron-history-payload-bounded-" },
    async (state) => {
      const database = openOpenClawStateDatabase();
      const day = 24 * 60 * 60_000;
      const nowMs = 10 * day;
      const startedAt = nowMs - day;
      const detail = (fields: Record<string, unknown>) =>
        JSON.stringify({ kind: "cron-run", storeKey: "store", status: "ok", ...fields });
      const insert = database.db.prepare(
        "INSERT INTO task_runs (task_id, runtime, source_id, run_id, owner_key, scope_kind, task, delivery_status, notify_policy, created_at, started_at, ended_at, last_event_at, status, terminal_summary, detail_json) VALUES (?, 'cron', ?, ?, '', 'system', 'job', 'not_applicable', 'silent', ?, ?, ?, ?, ?, ?, ?)",
      );
      const retainedPayload = "x".repeat(2_000_000);
      const outcomeDetail = detail({ summary: "done", output: "y".repeat(1_000) });
      insert.run(
        "retained",
        "other",
        "run-0",
        startedAt,
        startedAt,
        startedAt + 1,
        null,
        "succeeded",
        retainedPayload,
        detail({ output: retainedPayload }),
      );
      // The finished outcome precedes its stale active marker, so recovery adopts its payload.
      insert.run(
        "outcome",
        "job",
        "run-1",
        startedAt,
        startedAt,
        startedAt + 1,
        null,
        "succeeded",
        "done",
        outcomeDetail,
      );
      insert.run(
        "marker",
        "job",
        "run-1",
        startedAt + 2,
        startedAt,
        null,
        startedAt,
        "running",
        null,
        detail({ marker: true }),
      );
      // Without a recovery candidate a stale active row becomes lost and keeps its own payload.
      const staleDetail = detail({ note: "partial output" });
      insert.run(
        "stale",
        "job-2",
        "run-2",
        startedAt,
        startedAt,
        null,
        startedAt,
        "running",
        "partial",
        staleDetail,
      );
      insert.run(
        "unkeyed",
        "job-3",
        null,
        startedAt,
        startedAt,
        null,
        startedAt,
        "running",
        "unkeyed partial",
        staleDetail,
      );
      const reads = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(database.db),
        ["history"],
        (sql) => (/^select\b/i.test(sql) && sql.includes('from "task_runs"') ? "history" : null),
      );
      try {
        const result = runWithSqliteWorkerStateContext(
          { environment: { OPENCLAW_STATE_DIR: state.stateDir } },
          () =>
            maintainCronRunHistoryInWorker(database, {
              snapshot: { nowMs, protectedJobIds: [] },
            }),
        );
        expect(result.outcome).toMatchObject({ reconciled: 3, pruned: 0 });
        // Planning plus one payload read for the reconciled runs; the retained payload stays put.
        expect(reads.textBytes.history).toBeLessThan(retainedPayload.length / 10);
        expect(reads.counts.history).toBe(2);
      } finally {
        reads.restore();
      }
      const rows = database.db
        .prepare(
          "SELECT task_id, status, terminal_summary, detail_json FROM task_runs ORDER BY task_id",
        )
        .all() as Array<{
        task_id: string;
        status: string;
        terminal_summary: string | null;
        detail_json: string | null;
      }>;
      const byId = new Map(rows.map((row) => [row.task_id, row]));
      expect(byId.get("marker")).toMatchObject({ status: "succeeded", terminal_summary: "done" });
      expect(JSON.parse(byId.get("marker")?.detail_json ?? "null")).toEqual(
        JSON.parse(outcomeDetail),
      );
      for (const [id, summary] of [
        ["stale", "partial"],
        ["unkeyed", "unkeyed partial"],
      ] as const) {
        expect(byId.get(id)).toMatchObject({ status: "lost", terminal_summary: summary });
        expect(JSON.parse(byId.get(id)?.detail_json ?? "null")).toEqual(JSON.parse(staleDetail));
      }
      expect(byId.get("retained")).toEqual({
        task_id: "retained",
        status: "succeeded",
        terminal_summary: retainedPayload,
        detail_json: detail({ output: retainedPayload }),
      });
    },
  );
});
