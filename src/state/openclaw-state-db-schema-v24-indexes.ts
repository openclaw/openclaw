import type { EngineConnection } from "../infra/sql-connection.js";

export const TASK_RUN_INDEX_REPLACEMENTS_V24 = [
  "idx_task_runs_runtime_run",
  "idx_task_runs_cron_runtime_order",
  "idx_task_runs_cron_source_order",
] as const;

// Shared with the PostgreSQL forward-DDL generator; preserve unrelated local schema objects.
export const TASK_RUN_INDEX_RETIREMENT_V24_SQL = `
    DROP INDEX IF EXISTS idx_task_runs_run_id;
    DROP INDEX IF EXISTS idx_task_runs_status;
    DROP INDEX IF EXISTS idx_task_runs_runtime_status;
    DROP INDEX IF EXISTS idx_task_runs_cleanup_after;
    DROP INDEX IF EXISTS idx_task_runs_last_event_at;
    DROP INDEX IF EXISTS idx_task_runs_owner_key;
    DROP INDEX IF EXISTS idx_task_runs_parent_flow_id;
    DROP INDEX IF EXISTS idx_task_runs_child_session_key;
    DROP INDEX IF EXISTS idx_task_runs_requester_session_key;
    DROP INDEX IF EXISTS idx_task_runs_runtime_source_ended;
    DROP INDEX IF EXISTS idx_task_runs_runtime_ended;
`;

/** Canonical DDL installs the replacement indexes in the same migration transaction. */
export function migrateTaskRunIndexesV24(db: EngineConnection, previousVersion: number): boolean {
  if (previousVersion >= 24) {
    return false;
  }
  // sqlite-allow-raw -- Exact-name retirement belongs to the versioned schema owner.
  db.exec(TASK_RUN_INDEX_RETIREMENT_V24_SQL);
  return true;
}
