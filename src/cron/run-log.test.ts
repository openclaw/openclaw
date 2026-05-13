import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  appendCronRunLogToSqlite,
  DEFAULT_CRON_RUN_LOG_KEEP_LINES,
  DEFAULT_CRON_RUN_LOG_MAX_BYTES,
  readCronRunLogEntriesFromSqliteSync,
  readCronRunLogEntriesPageAllFromSqlite,
  readCronRunLogEntriesPageFromSqlite,
  resolveCronRunLogPruneOptions,
} from "./run-log.js";

describe("cron run log", () => {
  type CronRunLogTestDatabase = Pick<OpenClawStateKyselyDatabase, "cron_run_logs">;

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("resolves prune options from config with defaults", () => {
    expect(resolveCronRunLogPruneOptions()).toEqual({
      maxBytes: DEFAULT_CRON_RUN_LOG_MAX_BYTES,
      keepLines: DEFAULT_CRON_RUN_LOG_KEEP_LINES,
    });
    expect(
      resolveCronRunLogPruneOptions({
        maxBytes: "5mb",
        keepLines: 123,
      }),
    ).toEqual({
      maxBytes: 5 * 1024 * 1024,
      keepLines: 123,
    });
    expect(
      resolveCronRunLogPruneOptions({
        maxBytes: "invalid",
        keepLines: -1,
      }),
    ).toEqual({
      maxBytes: DEFAULT_CRON_RUN_LOG_MAX_BYTES,
      keepLines: DEFAULT_CRON_RUN_LOG_KEEP_LINES,
    });
  });

  async function withRunLogDir(prefix: string, run: (dir: string) => Promise<void>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = path.join(dir, "state");
    try {
      await run(dir);
    } finally {
      closeOpenClawStateDatabaseForTest();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it("stores and pages SQLite run-log entries", async () => {
    await withRunLogDir("openclaw-cron-log-sqlite-", async () => {
      const storeKey = "cron-run-log-sqlite";
      await appendCronRunLogToSqlite(storeKey, {
        ts: 1,
        jobId: "job-1",
        action: "finished",
        status: "ok",
        summary: "first",
      });
      await appendCronRunLogToSqlite(storeKey, {
        ts: 2,
        jobId: "job-1",
        action: "finished",
        status: "error",
        error: "boom",
      });

      expect(readCronRunLogEntriesFromSqliteSync(storeKey, { jobId: "job-1" })).toEqual([
        expect.objectContaining({ ts: 1, summary: "first" }),
        expect.objectContaining({ ts: 2, error: "boom" }),
      ]);
      const page = await readCronRunLogEntriesPageFromSqlite(storeKey, {
        jobId: "job-1",
        status: "error",
      });
      expect(page.entries).toEqual([expect.objectContaining({ ts: 2, status: "error" })]);
      const all = await readCronRunLogEntriesPageAllFromSqlite({
        storeKey,
        query: "Nightly Backup",
        status: "error",
        jobNameById: { "job-1": "Nightly Backup" },
      });
      expect(all.entries).toEqual([expect.objectContaining({ ts: 2 })]);
      expect(all.entries[0]).toMatchObject({ jobName: "Nightly Backup" });
    });
  });

  it("stores hot run-log metadata in typed columns", async () => {
    await withRunLogDir("openclaw-cron-log-sqlite-hot-", async () => {
      const storeKey = "cron-run-log-sqlite-hot";
      await appendCronRunLogToSqlite(storeKey, {
        ts: 10,
        jobId: "job-hot",
        action: "finished",
        status: "error",
        error: "boom",
        summary: "failed run",
        diagnostics: {
          summary: "diagnostic summary",
          entries: [],
        },
        delivered: false,
        deliveryStatus: "not-delivered",
        deliveryError: "no target",
        sessionId: "session-1",
        sessionKey: "telegram:chat",
        runId: "run-1",
        runAtMs: 9,
        durationMs: 123,
        nextRunAtMs: 1000,
        model: "gpt-5.5",
        provider: "openai",
        usage: { total_tokens: 42 },
      });

      const database = openOpenClawStateDatabase();
      const db = getNodeSqliteKysely<CronRunLogTestDatabase>(database.db);
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("cron_run_logs")
          .select([
            "status",
            "error",
            "summary",
            "diagnostics_summary",
            "delivery_status",
            "delivery_error",
            "delivered",
            "session_id",
            "session_key",
            "run_id",
            "run_at_ms",
            "duration_ms",
            "next_run_at_ms",
            "model",
            "provider",
            "total_tokens",
          ])
          .where("store_key", "=", storeKey)
          .where("job_id", "=", "job-hot"),
      );
      expect(row).toMatchObject({
        status: "error",
        error: "boom",
        summary: "failed run",
        diagnostics_summary: "diagnostic summary",
        delivery_status: "not-delivered",
        delivery_error: "no target",
        delivered: 0,
        session_id: "session-1",
        session_key: "telegram:chat",
        run_id: "run-1",
        run_at_ms: 9,
        duration_ms: 123,
        next_run_at_ms: 1000,
        model: "gpt-5.5",
        provider: "openai",
        total_tokens: 42,
      });
    });
  });

  it("reads hot run-log metadata from typed columns", async () => {
    await withRunLogDir("openclaw-cron-log-sqlite-typed-read-", async () => {
      const storeKey = "cron-run-log-sqlite-typed-read";
      await appendCronRunLogToSqlite(storeKey, {
        ts: 10,
        jobId: "job-hot",
        action: "finished",
        status: "error",
        error: "typed boom",
        summary: "typed summary",
        diagnostics: {
          summary: "typed diagnostic",
          entries: [],
        },
        delivered: false,
        deliveryStatus: "not-delivered",
        deliveryError: "typed no target",
        sessionId: "session-typed",
        sessionKey: "telegram:typed",
        runId: "run-typed",
        runAtMs: 9,
        durationMs: 123,
        nextRunAtMs: 1000,
        model: "gpt-5.5",
        provider: "openai",
        usage: { total_tokens: 42 },
      });

      const database = openOpenClawStateDatabase();
      const db = getNodeSqliteKysely<CronRunLogTestDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("cron_run_logs")
          .set({ entry_json: "{not-json" })
          .where("store_key", "=", storeKey)
          .where("job_id", "=", "job-hot"),
      );

      expect(readCronRunLogEntriesFromSqliteSync(storeKey, { jobId: "job-hot" })).toEqual([
        expect.objectContaining({
          ts: 10,
          jobId: "job-hot",
          status: "error",
          error: "typed boom",
          summary: "typed summary",
          diagnostics: {
            summary: "typed diagnostic",
            entries: [],
          },
          delivered: false,
          deliveryStatus: "not-delivered",
          deliveryError: "typed no target",
          sessionId: "session-typed",
          sessionKey: "telegram:typed",
          runId: "run-typed",
          runAtMs: 9,
          durationMs: 123,
          nextRunAtMs: 1000,
          model: "gpt-5.5",
          provider: "openai",
          usage: { total_tokens: 42 },
        }),
      ]);
    });
  });
});
