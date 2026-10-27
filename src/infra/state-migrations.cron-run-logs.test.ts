import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { cronRunLogEntryToDetail, cronRunStorageStatus } from "../cron/run-history-detail.js";
import { readCronRunHistoryPageForTests } from "../cron/run-history.test-support.js";
import type { CronRunLogEntry } from "../cron/run-log-types.js";
import { cronStoreKey } from "../cron/store/key.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
  prepareOpenClawStateDatabaseSchema,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const migrationId = "state:cron-run-logs-to-task-runs:v1";
const reportSql = "SELECT report_json FROM migration_runs WHERE id = ?";
function publicFields({ ts, jobId, runId, summary, error }: CronRunLogEntry) {
  return [ts, jobId, runId, summary, error];
}

it("preserves legacy cron history on runtime refusal, then Doctor imports it once", () =>
  withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-cron-run-log-import-" },
    async (state) => {
      const storePath = state.path("cron", "jobs.json");
      const storeKey = cronStoreKey(storePath);
      const jobId = "legacy-history-job";
      const defaults = { jobId, action: "finished", status: "ok" } as const;
      function entry(ts: number, overrides: Partial<CronRunLogEntry> = {}): CronRunLogEntry {
        const runAtMs = overrides.runAtMs ?? ts - 100;
        return { ...defaults, ts, runAtMs, durationMs: ts - runAtMs, ...overrides };
      }
      const mirrored = entry(3_100, { status: "skipped", runId: "mirror", runAtMs: 3_001 });
      const entries = [
        entry(1_100, {
          summary: "legacy one",
          sessionKey: "agent:main:cron:legacy:run:1",
          runId: "manual:legacy:1",
        }),
        entry(2_100, { status: "error", error: "legacy failure" }),
        entry(2_100, { summary: "same ms", runAtMs: 2_001 }),
        entry(3_100, { status: "error", error: "other run", runId: "same-ts" }),
        mirrored,
        entry(4_100, { summary: "no public run id" }),
      ];
      const legacyRows = [...entries, { ...mirrored }];

      const databasePath = openOpenClawStateDatabase().path;
      closeOpenClawStateDatabaseForTest();
      {
        using fixture = new DatabaseSync(databasePath);
        fixture.exec(`CREATE TABLE cron_run_logs (
          store_key TEXT NOT NULL, job_id TEXT NOT NULL, seq INTEGER NOT NULL,
          ts INTEGER NOT NULL, entry_json TEXT NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY (store_key, job_id, seq)
        );
        CREATE INDEX idx_cron_run_logs_store_ts ON cron_run_logs(store_key, ts DESC, seq DESC);`);
        const insertLegacy = fixture.prepare("INSERT INTO cron_run_logs VALUES (?, ?, ?, ?, ?, ?)");
        for (const [index, row] of legacyRows.entries()) {
          insertLegacy.run(storeKey, row.jobId, index + 1, row.ts, JSON.stringify(row), row.ts);
        }
        const insertMirrored = fixture.prepare(
          `INSERT INTO task_runs (
                task_id, runtime, source_id, owner_key, scope_kind, run_id, task, status,
                delivery_status, notify_policy, created_at, started_at, ended_at,
                terminal_summary, detail_json
              ) VALUES (?, 'cron', ?, '', 'system', ?, ?, ?, 'not_applicable', 'silent', ?, ?, ?, ?, ?)`,
        );
        for (const [index, row] of entries.slice(4).entries()) {
          insertMirrored.run(
            `already-mirrored-${index}`,
            jobId,
            `cron:legacy-history-job:${row.runAtMs}:mirrored`,
            jobId,
            cronRunStorageStatus(row),
            row.runAtMs ?? row.ts,
            row.runAtMs ?? null,
            row.ts,
            row.summary ?? null,
            JSON.stringify(cronRunLogEntryToDetail(row, { storeKey })),
          );
        }
        insertLegacy.run(storeKey, jobId, 8, 5100, "{", 5100);
      }
      expect(await prepareOpenClawStateDatabaseSchema()).toEqual({
        changes: [],
        warnings: [expect.stringMatching(/legacy-cron-run-logs.*doctor --fix/u)],
      });
      expect(() => openOpenClawStateDatabase()).toThrow(/legacy-cron-run-logs.*doctor --fix/u);
      {
        using preserved = new DatabaseSync(databasePath, { readOnly: true });
        const counts = preserved
          .prepare(`SELECT
            (SELECT COUNT(*) FROM cron_run_logs) AS legacy,
            (SELECT COUNT(*) FROM task_runs) AS mirrored`)
          .get();
        expect(counts).toEqual({ legacy: 8, mirrored: 2 });
      }
      expect(repairOpenClawStateDatabaseSchema().warnings).toEqual([]);
      const { db } = openOpenClawStateDatabase();
      const report = db.prepare(reportSql).get(migrationId);
      expect(JSON.parse(String(report?.report_json))).toEqual({
        imported: 4,
        alreadyMirrored: 3,
        malformed: 1,
        skipped: false,
      });
      const ledgerEntries = readCronRunHistoryPageForTests({
        storeKey,
        jobId,
        limit: 50,
        sortDir: "asc",
      }).entries;
      expect(ledgerEntries.map(publicFields)).toEqual(entries.map(publicFields));
      expect(
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cron_run_logs'")
          .get(),
      ).toBeUndefined();
      const imported = db
        .prepare(
          "SELECT task_id, cleanup_after FROM task_runs WHERE task_id LIKE 'cron-runlog-import:%' ORDER BY task_id",
        )
        .all();
      expect(imported.map(({ task_id, cleanup_after }) => [task_id, cleanup_after])).toEqual(
        ["1100:1", "2100:1", "2100:2", "3100:1"].map((suffix) => [
          `cron-runlog-import:legacy-history-job:${suffix}`,
          null,
        ]),
      );

      closeOpenClawStateDatabaseForTest();
      const { db: reopened } = openOpenClawStateDatabase();
      expect(reopened.prepare("SELECT COUNT(*) AS count FROM task_runs").get()).toEqual({
        count: 6,
      });
      expect(reopened.prepare(reportSql).get(migrationId)).toEqual({
        report_json: report?.report_json,
      });
    },
  ));
