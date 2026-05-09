import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importLegacyCronRunLogFilesToSqlite } from "../commands/doctor/legacy/cron-run-log.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
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
    await withRunLogDir("openclaw-cron-log-sqlite-", async (dir) => {
      const storePath = path.join(dir, "cron", "jobs.json");
      await appendCronRunLogToSqlite(storePath, {
        ts: 1,
        jobId: "job-1",
        action: "finished",
        status: "ok",
        summary: "first",
      });
      await appendCronRunLogToSqlite(storePath, {
        ts: 2,
        jobId: "job-1",
        action: "finished",
        status: "error",
        error: "boom",
      });

      expect(readCronRunLogEntriesFromSqliteSync(storePath, { jobId: "job-1" })).toEqual([
        expect.objectContaining({ ts: 1, summary: "first" }),
        expect.objectContaining({ ts: 2, error: "boom" }),
      ]);
      const page = await readCronRunLogEntriesPageFromSqlite(storePath, {
        jobId: "job-1",
        status: "error",
      });
      expect(page.entries).toEqual([expect.objectContaining({ ts: 2, status: "error" })]);
      const all = await readCronRunLogEntriesPageAllFromSqlite({
        storePath,
        query: "Nightly Backup",
        status: "error",
        jobNameById: { "job-1": "Nightly Backup" },
      });
      expect(all.entries).toEqual([expect.objectContaining({ ts: 2 })]);
      expect(all.entries[0]).toMatchObject({ jobName: "Nightly Backup" });
    });
  });

  it("imports legacy JSONL run-log files into SQLite and removes them", async () => {
    await withRunLogDir("openclaw-cron-log-import-", async (dir) => {
      const storePath = path.join(dir, "cron", "jobs.json");
      const logPath = path.join(dir, "cron", "runs", "job-1.jsonl");
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(
        logPath,
        `${JSON.stringify({ ts: 1, jobId: "job-1", action: "finished", status: "ok" })}\n`,
        "utf-8",
      );

      const result = await importLegacyCronRunLogFilesToSqlite({
        legacyStorePath: storePath,
        storeKey: storePath,
      });

      expect(result).toMatchObject({ imported: 1, files: 1 });
      expect(readCronRunLogEntriesFromSqliteSync(storePath, { jobId: "job-1" })).toEqual([
        expect.objectContaining({ ts: 1, status: "ok" }),
      ]);
      await expect(fs.stat(logPath)).rejects.toThrow();
    });
  });
});
