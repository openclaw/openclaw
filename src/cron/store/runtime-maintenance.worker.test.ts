import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { readSqliteDatabaseWriteRevision } from "../../infra/sqlite-database-admission.js";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { maintainCronRunHistoryInWorker } from "./runtime-maintenance.worker.js";

const day = 24 * 60 * 60_000;
const nowMs = 10 * day;
function maintain(database: ReturnType<typeof openOpenClawStateDatabase>, stateDir: string) {
  return runWithSqliteWorkerStateContext({ environment: { OPENCLAW_STATE_DIR: stateDir } }, () =>
    maintainCronRunHistoryInWorker(database, { snapshot: { nowMs, protectedJobIds: [] } }),
  );
}
function trackReads(database: ReturnType<typeof openOpenClawStateDatabase>, receipts = false) {
  return trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    receipts ? ["history", "receipts"] : ["history"],
    (sql) => {
      if (!/^select\b/i.test(sql)) {
        return null;
      }
      if (receipts && sql.includes('from "cron_run_receipts"')) {
        return "receipts";
      }
      return sql.includes('from "task_runs"') ? "history" : null;
    },
  );
}

it.each(["empty", "retained", "expired"] as const)(
  "does not invalidate shared readers unless history maintenance changes rows: %s",
  async (history) => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "cron-history-no-recovery-" },
      async (state) => {
        const database = openOpenClawStateDatabase();
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
        const reads = trackReads(database, true);
        try {
          expect(maintain(database, state.stateDir)).toEqual({
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
          expect(Object.is(readSqliteDatabaseWriteRevision(database.db), revision)).toBe(
            history !== "expired",
          );
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
      const startedAt = nowMs - day;
      const detail = (fields: Record<string, unknown>) =>
        JSON.stringify({ kind: "cron-run", storeKey: "store", status: "ok", ...fields });
      const insert = database.db.prepare(
        "INSERT INTO task_runs (task_id, runtime, source_id, run_id, owner_key, scope_kind, task, delivery_status, notify_policy, created_at, started_at, ended_at, last_event_at, status, terminal_summary, detail_json) VALUES (?, 'cron', ?, ?, '', 'system', 'job', 'not_applicable', 'silent', ?, ?, ?, ?, ?, ?, ?)",
      );
      const terminal = [startedAt, startedAt + 1, null, "succeeded"] as const;
      const active = [startedAt, null, startedAt, "running"] as const;
      const retainedPayload = "x".repeat(2_000_000);
      const outcomeDetail = detail({ summary: "done", output: "y".repeat(1_000) });
      insert.run(
        "retained",
        "other",
        "run-0",
        startedAt,
        ...terminal,
        retainedPayload,
        detail({ output: retainedPayload }),
      );
      // The finished outcome precedes its stale active marker, so recovery adopts its payload.
      insert.run("outcome", "job", "run-1", startedAt, ...terminal, "done", outcomeDetail);
      insert.run(
        "marker",
        "job",
        "run-1",
        startedAt + 2,
        ...active,
        null,
        detail({ marker: true }),
      );
      // Without a recovery candidate a stale active row becomes lost and keeps its own payload.
      const staleDetail = detail({ note: "partial output" });
      insert.run("stale", "job-2", "run-2", startedAt, ...active, "partial", staleDetail);
      insert.run("unkeyed", "job-3", null, startedAt, ...active, "unkeyed partial", staleDetail);
      const reads = trackReads(database);
      try {
        expect(maintain(database, state.stateDir).outcome).toMatchObject({
          reconciled: 3,
          pruned: 0,
        });
        // Planning plus one payload read for the reconciled runs; the retained payload stays put.
        expect(reads.textBytes.history).toBeLessThan(retainedPayload.length / 10);
        expect(reads.counts.history).toBe(2);
      } finally {
        reads.restore();
      }
      const byId = new Map(
        database.db
          .prepare(
            "SELECT task_id, status, terminal_summary, detail_json FROM task_runs ORDER BY task_id",
          )
          .all()
          .map((row) => [row.task_id, row]),
      );
      const detailFor = (id: string) => JSON.parse(String(byId.get(id)?.detail_json ?? "null"));
      expect(byId.get("marker")).toMatchObject({ status: "succeeded", terminal_summary: "done" });
      expect(detailFor("marker")).toEqual(JSON.parse(outcomeDetail));
      for (const [id, summary] of [
        ["stale", "partial"],
        ["unkeyed", "unkeyed partial"],
      ] as const) {
        expect(byId.get(id)).toMatchObject({ status: "lost", terminal_summary: summary });
        expect(detailFor(id)).toEqual(JSON.parse(staleDetail));
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
