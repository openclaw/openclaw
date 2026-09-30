// Legacy cron JSONL run-log migration into the cron-owned history store.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseCronRunLogEntryObject } from "../../../cron/run-history-detail.js";
import type { CronRunLogEntry } from "../../../cron/run-log-types.js";
import { cronStoreKey } from "../../../cron/store/key.js";
import { migrateLegacyCronRunLogsToTaskRuns } from "../../../infra/state-migrations.cron-run-logs.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { archiveLegacyCronFile } from "./legacy-store-migration.js";

async function listLegacyCronRunLogFiles(storePath: string): Promise<string[]> {
  const runsDir = path.resolve(path.dirname(path.resolve(storePath)), "runs");
  const files = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  return files
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(runsDir, entry.name));
}

function parseCronRunLogEntriesFromJsonl(
  raw: string,
  opts?: { jobId?: string },
): CronRunLogEntry[] {
  const entries: CronRunLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const entry = parseCronRunLogEntryObject(JSON.parse(trimmed), opts);
      if (entry) {
        entries.push(entry);
      }
    } catch {
      // A malformed legacy line must not block import of the remaining history.
    }
  }
  return entries;
}

/** Import legacy per-job JSONL run logs into existing Cron history rows in task_runs and archive migrated files. */
export async function migrateLegacyCronRunLogsToSqlite(
  storePath: string,
): Promise<{ importedFiles: number }> {
  const resolvedStorePath = path.resolve(storePath);
  const jsonlFiles = await listLegacyCronRunLogFiles(resolvedStorePath);

  for (const filePath of jsonlFiles) {
    const jobId = path.basename(filePath, ".jsonl");
    const raw = await fs.readFile(filePath);
    const sourceSha256 = createHash("sha256").update(raw).digest("hex");
    const entries = parseCronRunLogEntriesFromJsonl(raw.toString("utf-8"), {
      jobId,
    });

    runOpenClawStateWriteTransaction(({ db }) => {
      db.exec(`
        CREATE TABLE cron_run_logs (
          store_key TEXT NOT NULL,
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          ts INTEGER NOT NULL,
          entry_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (store_key, job_id, seq)
        ) STRICT;
      `);
      const insert = db.prepare(
        `INSERT INTO cron_run_logs
          (store_key, job_id, seq, ts, entry_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const storeKey = cronStoreKey(resolvedStorePath);
      for (const [index, entry] of entries.entries()) {
        insert.run(storeKey, jobId, index + 1, entry.ts, JSON.stringify(entry), Date.now());
      }
      migrateLegacyCronRunLogsToTaskRuns(db);
    });
    const archive = await archiveLegacyCronFile(filePath, sourceSha256);
    if (!archive.ok) {
      throw new Error(`Cron history imported but could not archive ${filePath}: ${archive.reason}`);
    }
  }
  return { importedFiles: jsonlFiles.length };
}

export async function legacyCronRunLogFilesExist(storePath: string): Promise<boolean> {
  return (await listLegacyCronRunLogFiles(storePath)).length > 0;
}
