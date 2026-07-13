/** One-shot import of legacy cron run history into the authoritative task ledger. */
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { parseStoredRunLogEntry } from "../cron/run-log/sqlite-store.js";
import { cronRunLogEntryToTaskDetail, cronRunStatusToTaskStatus } from "../cron/task-run-detail.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import { sha256HexPrefix } from "./crypto-digest.js";

export const CRON_RUN_LOG_TASK_IMPORT_MIGRATION_ID = "state:cron-run-logs-to-task-runs:v1";

type CronRunLogRow = Selectable<OpenClawStateDatabase["cron_run_logs"]>;
type MirroredTask = {
  source_id: string | null;
  ended_at: number | null;
  detail_json: string | null;
};
type MirroredIdentity = { endedAt: number | null; runId?: string };

export type CronRunLogTaskImportResult = {
  imported: number;
  alreadyMirrored: number;
  malformed: number;
  skipped: boolean;
};

function parseDetail(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function mirroredKey(sourceId: string, storeKey: string): string {
  return `${sourceId}\0${storeKey}`;
}

function collectMirroredTasks(db: DatabaseSync): Map<string, MirroredIdentity[]> {
  const rows = db
    .prepare(
      `SELECT source_id, ended_at, detail_json
       FROM task_runs
       WHERE runtime = 'cron' AND source_id IS NOT NULL AND detail_json IS NOT NULL`,
    )
    .all() as MirroredTask[];
  const bySource = new Map<string, MirroredIdentity[]>();
  for (const row of rows) {
    const detail = parseDetail(row.detail_json);
    const storeKey = typeof detail?.storeKey === "string" ? detail.storeKey : undefined;
    if (!row.source_id || !storeKey) {
      continue;
    }
    const key = mirroredKey(row.source_id, storeKey);
    const identities = bySource.get(key) ?? [];
    identities.push({
      endedAt: row.ended_at,
      ...(typeof detail?.runId === "string" ? { runId: detail.runId } : {}),
    });
    bySource.set(key, identities);
  }
  return bySource;
}

function consumeMirroredIdentity(
  identities: MirroredIdentity[],
  runId: string | undefined,
  endedAt: number,
): boolean {
  let index = runId ? identities.findIndex((identity) => identity.runId === runId) : -1;
  if (index < 0) {
    index = identities.findIndex(
      (identity) => identity.runId === undefined && identity.endedAt === endedAt,
    );
  }
  if (index < 0 && !runId) {
    index = identities.findIndex((identity) => identity.endedAt === endedAt);
  }
  if (index < 0) {
    return false;
  }
  identities.splice(index, 1);
  return true;
}

/** Runs inside the state schema transaction; completed receipt makes later opens no-ops. */
export function migrateLegacyCronRunLogsToTaskRuns(db: DatabaseSync): CronRunLogTaskImportResult {
  const receipt = db
    .prepare("SELECT status FROM migration_runs WHERE id = ?")
    .get(CRON_RUN_LOG_TASK_IMPORT_MIGRATION_ID) as { status?: unknown } | undefined;
  if (receipt?.status === "completed") {
    return { imported: 0, alreadyMirrored: 0, malformed: 0, skipped: true };
  }

  const rows = db
    .prepare("SELECT * FROM cron_run_logs ORDER BY store_key, job_id, seq")
    .all() as CronRunLogRow[];
  const mirrored = collectMirroredTasks(db);
  // Leave cleanup unset; follow-up source-aware retention owns imported cron history.
  const insert = db.prepare(`
    INSERT INTO task_runs (
      task_id, runtime, task_kind, source_id, requester_session_key, owner_key, scope_kind,
      child_session_key, parent_flow_id, parent_task_id, agent_id, requester_agent_id, run_id,
      label, task, status, delivery_status, notify_policy, created_at, started_at, ended_at,
      last_event_at, cleanup_after, error, progress_summary, terminal_summary, terminal_outcome,
      detail_json
    ) VALUES (
      @task_id, 'cron', NULL, @source_id, '', '', 'system', @child_session_key, NULL, NULL,
      NULL, NULL, @run_id, NULL, @task, @status, 'not_applicable', 'silent', @created_at,
      @started_at, @ended_at, @ended_at, NULL, @error, NULL, @terminal_summary,
      @terminal_outcome, @detail_json
    )
  `);
  let imported = 0;
  let alreadyMirroredCount = 0;
  let malformed = 0;
  for (const row of rows) {
    // No failover resolver is injected here on purpose: this migration runs inside the
    // synchronous state-db schema transaction, and the run-log error-reason classifier
    // pulls the agents/sandbox module tree (which state-db must not statically depend on).
    // Legacy rows that never stored an errorReason are imported without one; new runs
    // always author errorReason at write time, so the gap is bounded to pre-upgrade history.
    const entry = parseStoredRunLogEntry(row);
    if (!entry) {
      malformed++;
      continue;
    }
    const key = mirroredKey(row.job_id, row.store_key);
    const identities = mirrored.get(key) ?? [];
    if (consumeMirroredIdentity(identities, entry.runId, entry.ts)) {
      alreadyMirroredCount++;
      continue;
    }
    const taskId = `cron-runlog-import:${sha256HexPrefix(row.store_key, 16)}:${row.job_id}:${entry.ts}:${String(row.seq)}`;
    const status = cronRunStatusToTaskStatus(entry);
    insert.run({
      task_id: taskId,
      source_id: row.job_id,
      child_session_key: entry.sessionKey ?? null,
      run_id: taskId,
      task: row.job_id,
      status,
      created_at: entry.runAtMs ?? entry.ts,
      started_at: entry.runAtMs ?? null,
      ended_at: entry.ts,
      error: entry.error ?? null,
      terminal_summary: entry.summary ?? null,
      terminal_outcome: status === "succeeded" ? "succeeded" : null,
      detail_json: JSON.stringify(cronRunLogEntryToTaskDetail(entry, { storeKey: row.store_key })),
    });
    imported++;
  }

  const result = {
    imported,
    alreadyMirrored: alreadyMirroredCount,
    malformed,
    skipped: false,
  };
  const now = Date.now();
  db.prepare(
    `INSERT INTO migration_runs (id, started_at, finished_at, status, report_json)
     VALUES (?, ?, ?, 'completed', ?)
     ON CONFLICT(id) DO UPDATE SET
       finished_at = excluded.finished_at,
       status = excluded.status,
       report_json = excluded.report_json`,
  ).run(CRON_RUN_LOG_TASK_IMPORT_MIGRATION_ID, now, now, JSON.stringify(result));
  return result;
}
