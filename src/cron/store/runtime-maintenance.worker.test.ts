import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { readSqliteDatabaseWriteRevision } from "../../infra/sqlite-database-admission.js";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
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
          database.db,
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
                  locallyOwnedReceiptIds: [],
                },
              }),
          );
          expect(result).toEqual({
            outcome: { reconciled: 0, pruned: history === "expired" ? 1 : 0 },
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
