import type { DatabaseSync } from "node:sqlite";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB, UpdateRuns } from "../state/openclaw-state-db.generated.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { UpdateRunRecordSchema } from "./update-run-schema.js";

const JSON_FIELDS = [
  "origin",
  "target",
  "before",
  "after",
  "steps",
  "verification",
  "repair",
] as const;
export function decodeRun(row: UpdateRuns) {
  const metadata = Object.fromEntries(
    JSON_FIELDS.map((field) => [field, JSON.parse(row[`${field}_json`])]),
  );
  return UpdateRunRecordSchema.parse({
    ...metadata,
    runId: row.run_id,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    trigger: row.trigger,
    phase: row.phase,
    status: row.status,
    reason: row.reason,
    confirmedAtMs: row.confirmed_at_ms,
    finishedAtMs: row.finished_at_ms,
    downtimeMs: row.downtime_ms,
  });
}

export function readUpdateRunRecord(db: DatabaseSync, runId: string) {
  const query = getNodeSqliteKysely<Pick<DB, "update_runs">>(db)
    .selectFrom("update_runs")
    .selectAll()
    .where("run_id", "=", runId);
  const row = executeSqliteQueryTakeFirstSync(db, query);
  return row ? decodeRun(row) : undefined;
}

/** Read activity on the caller's connection so maintenance can fence its mutation. */
export function readActiveUpdateRun(db: DatabaseSync) {
  return readUpdateRuns(db, { limit: 1, active: true })[0];
}

export function readLatestUpdateRun(db: DatabaseSync) {
  return readUpdateRuns(db, { limit: 1 })[0];
}

export type UpdateRunListInput = {
  limit?: number;
  active?: boolean;
  reason?: string;
  includeRunId?: string;
};

export function readUpdateRuns(db: DatabaseSync, input: UpdateRunListInput) {
  if (!tableExists(db, "update_runs")) {
    return [];
  }
  let query = getNodeSqliteKysely<Pick<DB, "update_runs">>(db)
    .selectFrom("update_runs")
    .selectAll();
  if (input.active) {
    query = query.where("status", "=", "running");
  }
  if (input.reason) {
    query = query.where("reason", "=", input.reason);
  }
  const runs = executeSqliteQuerySync(
    db,
    query
      .orderBy("created_at_ms", "desc")
      .orderBy("run_id", "desc")
      .limit(Math.max(1, Math.min(100, Math.trunc(input.limit ?? 20)))),
  ).rows.map(decodeRun);
  // Restoration must retain its captured owner even after that row becomes terminal.
  if (input.includeRunId && !runs.some((run) => run.runId === input.includeRunId)) {
    const captured = readUpdateRunRecord(db, input.includeRunId);
    if (captured) {
      runs.push(captured);
    }
  }
  return runs;
}
