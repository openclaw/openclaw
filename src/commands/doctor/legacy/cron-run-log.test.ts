import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCronRunLogEntriesFromSqliteSync } from "../../../cron/run-log.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { importLegacyCronRunLogFilesToSqlite, legacyCronRunLogFilesExist } from "./cron-run-log.js";

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

describe("legacy cron run-log migration", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
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

      expect(await legacyCronRunLogFilesExist(storePath)).toBe(true);
      const result = await importLegacyCronRunLogFilesToSqlite({
        legacyStorePath: storePath,
        storeKey: storePath,
      });

      expect(result).toMatchObject({ imported: 1, files: 1 });
      expect(readCronRunLogEntriesFromSqliteSync(storePath, { jobId: "job-1" })).toEqual([
        expect.objectContaining({ ts: 1, status: "ok" }),
      ]);
      await expect(fs.stat(logPath)).rejects.toThrow();
      expect(await legacyCronRunLogFilesExist(storePath)).toBe(false);
    });
  });

  it("skips when the legacy runs directory is missing", async () => {
    await withRunLogDir("openclaw-cron-log-import-missing-", async (dir) => {
      const storePath = path.join(dir, "cron", "jobs.json");

      expect(await legacyCronRunLogFilesExist(storePath)).toBe(false);
      await expect(
        importLegacyCronRunLogFilesToSqlite({
          legacyStorePath: storePath,
          storeKey: storePath,
        }),
      ).resolves.toEqual({ imported: 0, files: 0 });
    });
  });
});
