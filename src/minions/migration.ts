import { existsSync, renameSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveTaskRegistrySqlitePath } from "../tasks/task-registry.paths.js";
import { MinionStore } from "./store.js";

export type MigrationResult = {
  imported: number;
  skipped: number;
  errors: Array<{ taskId: string; error: string }>;
  legacyPath: string;
  renamedTo: string;
};

type LegacyTaskRow = {
  task_id: string;
  runtime: string;
  task: string;
  status: string;
  run_id: string | null;
  child_session_key: string | null;
  created_at: number | bigint;
  started_at: number | bigint | null;
  ended_at: number | bigint | null;
  last_event_at: number | bigint | null;
  error: string | null;
  progress_summary: string | null;
};

function coerceNum(v: number | bigint | null): number | null {
  if (v == null) {
    return null;
  }
  return typeof v === "bigint" ? Number(v) : v;
}

function isActiveStatus(status: string): boolean {
  return status === "queued" || status === "running";
}

/**
 * Migrate live tasks from the legacy tasks/*.sqlite into minion_jobs.
 *
 * Imported rows get status='attached' (non-claimable) so the orphan-detection
 * sweep at gateway startup can inspect liveness before marking them claimable
 * or dead. This prevents the split-brain where a live subprocess and a newly
 * claimed worker both run for the same job.
 *
 * The legacy file (+ WAL sidecars) is renamed to .legacy-YYYYMMDD after import.
 * Idempotent: skips if the legacy file is already renamed.
 */
export function migrateLegacyTasks(
  minionStore: MinionStore,
  env: NodeJS.ProcessEnv = process.env,
): MigrationResult | null {
  const legacyPath = resolveTaskRegistrySqlitePath(env);

  if (!existsSync(legacyPath)) {
    return null;
  }

  const dateSuffix = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const renamedTo = `${legacyPath}.legacy-${dateSuffix}`;

  if (existsSync(renamedTo)) {
    return null;
  }

  const { DatabaseSync } = requireNodeSqlite();
  const legacyDb: DatabaseSync = new DatabaseSync(legacyPath, { readOnly: true });

  let rows: LegacyTaskRow[];
  try {
    legacyDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    rows = legacyDb
      .prepare(
        "SELECT task_id, runtime, task, status, run_id, child_session_key, created_at, started_at, ended_at, last_event_at, error, progress_summary FROM task_runs",
      )
      .all() as LegacyTaskRow[];
  } catch {
    legacyDb.close();
    return null;
  }

  const result: MigrationResult = {
    imported: 0,
    skipped: 0,
    errors: [],
    legacyPath,
    renamedTo,
  };

  const now = Date.now();

  for (const row of rows) {
    if (!isActiveStatus(row.status)) {
      result.skipped++;
      continue;
    }

    try {
      const runtimeToHandler: Record<string, string> = {
        subagent: "subagent.spawn",
        acp: "acp.spawn",
        cli: "cli.spawn",
        cron: "cron.tick",
      };
      const handlerName = runtimeToHandler[row.runtime] ?? `subagent.spawn`;
      const createdAt = coerceNum(row.created_at) ?? now;

      minionStore.db
        .prepare(
          `INSERT INTO minion_jobs (
            name, queue, status, data, created_at, updated_at, error_text, progress
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          handlerName,
          "default",
          "waiting",
          JSON.stringify({
            legacyTaskId: row.task_id,
            runtime: row.runtime,
            task: row.task,
            runId: row.run_id,
            childSessionKey: row.child_session_key,
            reason: "imported_live",
          }),
          createdAt,
          now,
          row.error,
          row.progress_summary,
        );
      result.imported++;
    } catch (err) {
      result.errors.push({
        taskId: row.task_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  legacyDb.close();

  for (const suffix of ["", "-wal", "-shm"]) {
    const src = `${legacyPath}${suffix}`;
    const dst = `${renamedTo}${suffix}`;
    if (existsSync(src)) {
      try {
        renameSync(src, dst);
      } catch {
        // Best-effort rename; file may already be moved
      }
    }
  }

  return result;
}
