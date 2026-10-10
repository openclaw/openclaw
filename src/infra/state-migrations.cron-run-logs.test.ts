import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
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
import { migrateLegacyCronRunLogsToTaskRuns } from "./state-migrations.cron-run-logs.js";

const CRON_RUN_LOG_TASK_IMPORT_MIGRATION_ID = "state:cron-run-logs-to-task-runs:v1";

describe("cron run-log task import", () => {
  it("preserves legacy cron history on runtime refusal, then Doctor imports it once", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-run-log-import-" },
      async (state) => {
        const storePath = state.path("cron", "jobs.json");
        const storeKey = cronStoreKey(storePath);
        const jobId = "legacy-history-job";
        const createEntry = (
          ts: number,
          overrides: Partial<CronRunLogEntry> = {},
        ): CronRunLogEntry => ({
          ts,
          jobId,
          action: "finished",
          status: "ok",
          runAtMs: ts - 100,
          durationMs: 100,
          ...overrides,
        });
        const mirroredWithRunId = createEntry(3_100, {
          status: "skipped",
          runId: "manual:mirrored:3",
          runAtMs: 3_001,
          durationMs: 99,
        });
        const entries = [
          createEntry(1_100, {
            summary: "legacy one",
            sessionKey: "agent:main:cron:legacy:run:1",
            runId: "manual:legacy:1",
          }),
          createEntry(2_100, { status: "error", error: "legacy failure" }),
          createEntry(2_100, {
            summary: "same millisecond legacy run",
            runAtMs: 2_001,
            durationMs: 99,
          }),
          createEntry(3_100, {
            status: "error",
            error: "different public run id",
            runId: "manual:legacy:same-ts",
          }),
          mirroredWithRunId,
          createEntry(4_100, { summary: "mirrored without public run id" }),
        ];
        const legacyRows = [...entries, { ...mirroredWithRunId }];

        const initial = openOpenClawStateDatabase();
        const databasePath = initial.path;
        closeOpenClawStateDatabaseForTest();
        const fixture = new DatabaseSync(databasePath);
        try {
          fixture.exec(`
            CREATE TABLE cron_run_logs (
              store_key TEXT NOT NULL,
              job_id TEXT NOT NULL,
              seq INTEGER NOT NULL,
              ts INTEGER NOT NULL,
              entry_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              PRIMARY KEY (store_key, job_id, seq)
            );
            CREATE INDEX idx_cron_run_logs_store_ts
              ON cron_run_logs(store_key, ts DESC, seq DESC);
          `);
          const insertLegacy = fixture.prepare(
            `INSERT INTO cron_run_logs
              (store_key, job_id, seq, ts, entry_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          );
          for (const [index, entry] of legacyRows.entries()) {
            insertLegacy.run(
              storeKey,
              entry.jobId,
              index + 1,
              entry.ts,
              JSON.stringify(entry),
              entry.ts,
            );
          }
          const insertMirrored = fixture.prepare(
            `INSERT INTO task_runs (
                task_id, runtime, source_id, requester_session_key, owner_key, scope_kind,
                child_session_key, run_id, task, status, delivery_status, notify_policy, created_at,
                started_at, ended_at, last_event_at, error, terminal_summary, terminal_outcome,
                detail_json
              ) VALUES (?, 'cron', ?, '', '', 'system', ?, ?, ?, ?, 'not_applicable', 'silent',
                ?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          for (const [index, mirrored] of entries.slice(4).entries()) {
            const mirroredStatus = cronRunStorageStatus(mirrored);
            insertMirrored.run(
              `already-mirrored-${index}`,
              jobId,
              mirrored.sessionKey ?? null,
              `cron:legacy-history-job:${mirrored.runAtMs}:mirrored`,
              jobId,
              mirroredStatus,
              mirrored.runAtMs ?? mirrored.ts,
              mirrored.runAtMs ?? null,
              mirrored.ts,
              mirrored.ts,
              mirrored.error ?? null,
              mirrored.summary ?? null,
              mirroredStatus === "succeeded" ? "succeeded" : null,
              JSON.stringify(cronRunLogEntryToDetail(mirrored, { storeKey })),
            );
          }
          fixture
            .prepare(
              `INSERT INTO cron_run_logs
                (store_key, job_id, seq, ts, entry_json, created_at)
               VALUES (?, ?, 8, 5100, '{', 5100)`,
            )
            .run(storeKey, jobId);
        } finally {
          fixture.close();
        }

        expect(await prepareOpenClawStateDatabaseSchema()).toEqual({
          changes: [],
          warnings: [expect.stringMatching(/legacy-cron-run-logs.*doctor --fix/u)],
        });
        expect(() => openOpenClawStateDatabase()).toThrow(/legacy-cron-run-logs.*doctor --fix/u);
        const preserved = new DatabaseSync(databasePath, { readOnly: true });
        try {
          expect(preserved.prepare("SELECT COUNT(*) AS count FROM cron_run_logs").get()).toEqual({
            count: 8,
          });
          expect(preserved.prepare("SELECT COUNT(*) AS count FROM task_runs").get()).toEqual({
            count: 2,
          });
        } finally {
          preserved.close();
        }
        expect(repairOpenClawStateDatabaseSchema().warnings).toEqual([]);
        const reopened = openOpenClawStateDatabase();
        const report = reopened.db
          .prepare("SELECT report_json FROM migration_runs WHERE id = ?")
          .get(CRON_RUN_LOG_TASK_IMPORT_MIGRATION_ID) as { report_json: string };
        expect(JSON.parse(report.report_json)).toEqual({
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
        const publicFields = ({
          ts,
          jobId: entryJobId,
          runId,
          summary,
          error,
        }: CronRunLogEntry) => ({
          ts,
          jobId: entryJobId,
          runId,
          summary,
          error,
        });
        expect(ledgerEntries.map(publicFields)).toEqual(entries.map(publicFields));
        expect(
          reopened.db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cron_run_logs'")
            .get(),
        ).toBeUndefined();
        const imported = reopened.db
          .prepare(
            "SELECT task_id, cleanup_after FROM task_runs WHERE task_id LIKE 'cron-runlog-import:%' ORDER BY task_id",
          )
          .all() as Array<{ task_id: string; cleanup_after: number | null }>;
        expect(imported.map((row) => row.task_id)).toEqual([
          "cron-runlog-import:legacy-history-job:1100:1",
          "cron-runlog-import:legacy-history-job:2100:1",
          "cron-runlog-import:legacy-history-job:2100:2",
          "cron-runlog-import:legacy-history-job:3100:1",
        ]);
        expect(imported.every((row) => row.cleanup_after === null)).toBe(true);

        closeOpenClawStateDatabaseForTest();
        const secondOpen = openOpenClawStateDatabase();
        expect(secondOpen.db.prepare("SELECT COUNT(*) AS count FROM task_runs").get()).toEqual({
          count: 6,
        });
        expect(
          secondOpen.db
            .prepare("SELECT report_json FROM migration_runs WHERE id = ?")
            .get(CRON_RUN_LOG_TASK_IMPORT_MIGRATION_ID),
        ).toEqual({ report_json: report.report_json });
      },
    );
  });

  it("imports legacy cron history when task_runs predates detail_json", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE task_runs (
          task_id TEXT NOT NULL PRIMARY KEY,
          runtime TEXT NOT NULL,
          task_kind TEXT,
          source_id TEXT,
          requester_session_key TEXT,
          owner_key TEXT NOT NULL,
          scope_kind TEXT NOT NULL,
          child_session_key TEXT,
          parent_flow_id TEXT,
          parent_task_id TEXT,
          agent_id TEXT,
          requester_agent_id TEXT,
          run_id TEXT,
          label TEXT,
          task TEXT NOT NULL,
          status TEXT NOT NULL,
          delivery_status TEXT NOT NULL,
          notify_policy TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          ended_at INTEGER,
          last_event_at INTEGER,
          cleanup_after INTEGER,
          error TEXT,
          progress_summary TEXT,
          terminal_summary TEXT,
          terminal_outcome TEXT
        );
        CREATE TABLE cron_run_logs (
          store_key TEXT NOT NULL,
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          ts INTEGER NOT NULL,
          entry_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (store_key, job_id, seq)
        );
        CREATE TABLE migration_runs (
          id TEXT NOT NULL PRIMARY KEY,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          status TEXT NOT NULL,
          report_json TEXT NOT NULL
        );
      `);
      database
        .prepare(
          `INSERT INTO task_runs (
             task_id, runtime, owner_key, scope_kind, task, status, delivery_status,
             notify_policy, created_at, error
           ) VALUES (?, 'subagent', 'owner', 'session', 'kept', 'succeeded', 'pending', 'silent', 10, ?)`,
        )
        .run("kept-subagent", "do-not-drop");
      database
        .prepare(
          `INSERT INTO task_runs (
             task_id, runtime, source_id, owner_key, scope_kind, task, status,
             delivery_status, notify_policy, created_at, ended_at
           ) VALUES (?, 'cron', 'legacy-job', '', 'system', 'legacy-job', 'succeeded',
             'not_applicable', 'silent', 1000, 1100)`,
        )
        .run("preexisting-cron");
      database
        .prepare(
          `INSERT INTO cron_run_logs (store_key, job_id, seq, ts, entry_json, created_at)
           VALUES ('store', 'legacy-job', 1, 2100, ?, 2100)`,
        )
        .run(
          JSON.stringify({
            action: "finished",
            jobId: "legacy-job",
            ts: 2100,
            status: "ok",
            summary: "legacy one",
            runAtMs: 2000,
            durationMs: 100,
          }),
        );

      database.exec("BEGIN IMMEDIATE");
      expect(migrateLegacyCronRunLogsToTaskRuns(database)).toEqual({
        imported: 1,
        alreadyMirrored: 0,
        malformed: 0,
        skipped: false,
      });
      database.exec("COMMIT");

      const columns = database.prepare("PRAGMA table_info(task_runs)").all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toContain("detail_json");
      expect(
        database.prepare("SELECT error FROM task_runs WHERE task_id = 'kept-subagent'").get(),
      ).toEqual({ error: "do-not-drop" });
      expect(
        database.prepare("SELECT task_id FROM task_runs WHERE task_id = 'preexisting-cron'").get(),
      ).toEqual({ task_id: "preexisting-cron" });
      const imported = database
        .prepare(
          "SELECT source_id, detail_json FROM task_runs WHERE task_id = 'cron-runlog-import:legacy-job:2100:1'",
        )
        .get() as { source_id: string; detail_json: string };
      expect(imported.source_id).toBe("legacy-job");
      expect(JSON.parse(imported.detail_json)).toMatchObject({
        kind: "cron-run",
        summary: "legacy one",
        storeKey: "store",
      });
      expect(
        database
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cron_run_logs'")
          .get(),
      ).toBeUndefined();
      expect(database.prepare("SELECT COUNT(*) AS count FROM task_runs").get()).toEqual({
        count: 3,
      });
    } finally {
      database.close();
    }
  });
});
