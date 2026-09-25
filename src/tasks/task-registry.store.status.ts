import type { Selectable } from "kysely";
import { sql } from "kysely";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { createSubagentTaskBackingDetail } from "./task-backing-records.js";
import { normalizeTaskTimestamps } from "./task-registry-records.js";
import type { TaskAuditRecord } from "./task-registry.audit.js";
import {
  hasReadableTaskRegistrySchema,
  type TaskRegistryDatabase,
} from "./task-registry.store.kernel.js";
import {
  addTaskStatusSummaryRecord,
  createEmptyTaskStatusSummary,
  type TaskStatusSummary,
} from "./task-registry.summary.js";
import {
  parseTaskDeliveryStatus,
  parseTaskNotifyPolicy,
  parseTaskRuntime,
  parseTaskScopeKind,
  parseTaskStatus,
  type TaskRecord,
} from "./task-registry.types.js";

const AUDIT_COLUMNS = [
  "runtime",
  "status",
  "delivery_status",
  "notify_policy",
  "created_at",
  "started_at",
  "ended_at",
  "last_event_at",
  "cleanup_after",
] as const;
type AuditRow = Pick<Selectable<DB["task_runs"]>, (typeof AUDIT_COLUMNS)[number]>;
type CandidateRow = AuditRow &
  Pick<
    Selectable<DB["task_runs"]>,
    | "task_id"
    | "task_kind"
    | "source_id"
    | "owner_key"
    | "scope_kind"
    | "child_session_key"
    | "agent_id"
    | "run_id"
  > & { backing_generation: number | null };
type HistoryRow = AuditRow & Pick<Selectable<DB["task_runs"]>, "task_id" | "source_id" | "run_id">;
type CronRecoveryRow = { row: TaskRecord; createdAt: number };
type CronRecoveryLookups = {
  taskIds: Map<string, CronRecoveryRow | undefined>;
  runIds: Map<string, CronRecoveryRow | undefined>;
};

export type TaskRegistryStatusSnapshot = {
  state: "ready" | "migration-required";
  summary: TaskStatusSummary;
  candidates: TaskRecord[];
  cronRecoveryRows: Map<string, TaskRecord>;
};

function earlierCronRow(
  left: CronRecoveryRow | undefined,
  right: CronRecoveryRow,
): CronRecoveryRow {
  if (!left) {
    return right;
  }
  // The full reader sorts raw SQLite timestamps before normalizing legacy values.
  return right.createdAt < left.createdAt ||
    (right.createdAt === left.createdAt &&
      Buffer.compare(Buffer.from(right.row.taskId), Buffer.from(left.row.taskId)) < 0)
    ? right
    : left;
}

function auditRecord(row: AuditRow): TaskAuditRecord & Pick<TaskRecord, "runtime"> {
  return normalizeTaskTimestamps({
    runtime: parseTaskRuntime(row.runtime),
    status: parseTaskStatus(row.status),
    deliveryStatus: parseTaskDeliveryStatus(row.delivery_status),
    notifyPolicy: parseTaskNotifyPolicy(row.notify_policy),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    startedAt: normalizeSqliteNumber(row.started_at),
    endedAt: normalizeSqliteNumber(row.ended_at),
    lastEventAt: normalizeSqliteNumber(row.last_event_at),
    cleanupAfter: normalizeSqliteNumber(row.cleanup_after),
  });
}

/** Fixed-size retained-history aggregates; only live reconciliation candidates leave the worker. */
export function readTaskRegistryStatusSnapshot(
  database: TaskRegistryDatabase,
  now: number,
): TaskRegistryStatusSnapshot {
  const result: TaskRegistryStatusSnapshot = {
    state: "ready",
    summary: createEmptyTaskStatusSummary(),
    candidates: [],
    cronRecoveryRows: new Map(),
  };
  const { db } = database;
  if (!hasReadableTaskRegistrySchema(db)) {
    result.state = "migration-required";
    return result;
  }
  return runSqliteDeferredTransactionSync(db, () => {
    const kysely = getNodeSqliteKysely<DB>(db);
    const candidate = sql`(status IN ('queued', 'running') OR
      (runtime = 'cron' AND status = 'lost' AND instr(lower(coalesce(error, '')), 'backing session missing') > 0))`;
    const columns = sql.join(
      AUDIT_COLUMNS.map((column) =>
        /* kysely-allow-raw: identifiers come only from the closed AUDIT_COLUMNS tuple. */ sql.ref(
          column,
        ),
      ),
    );
    const candidates = /* kysely-allow-raw: NOT INDEXED preserves completeness; project only candidate liveness metadata. */ sql<CandidateRow>`SELECT ${columns}, task_id, task_kind, source_id,
      owner_key, scope_kind, child_session_key, agent_id, run_id,
      CASE WHEN runtime = 'subagent' AND json_valid(detail_json) THEN
        CASE WHEN json_type(detail_json) = 'object'
          AND json_extract(detail_json, '$.kind') = 'task_backing_instance'
          AND json_extract(detail_json, '$.runtime') = 'subagent'
          AND json_type(detail_json, '$.generation') IN ('integer', 'real')
          AND json_extract(detail_json, '$.generation') BETWEEN 1 AND 9007199254740991
          AND json_extract(detail_json, '$.generation') = CAST(json_extract(detail_json, '$.generation') AS INTEGER)
        THEN json_extract(detail_json, '$.generation') END
      END AS backing_generation
      FROM task_runs NOT INDEXED WHERE ${candidate}`;
    for (const row of iterateSqliteQuerySync(db, { compile: () => candidates.compile(kysely) })) {
      const metadata = auditRecord(row);
      result.candidates.push({
        ...metadata,
        taskId: row.task_id,
        task: "",
        ownerKey: row.owner_key,
        requesterSessionKey: row.owner_key,
        scopeKind: parseTaskScopeKind(row.scope_kind),
        ...(row.task_kind ? { taskKind: row.task_kind } : {}),
        ...(row.source_id ? { sourceId: row.source_id } : {}),
        ...(row.child_session_key ? { childSessionKey: row.child_session_key } : {}),
        ...(row.agent_id ? { agentId: row.agent_id } : {}),
        ...(row.run_id ? { runId: row.run_id } : {}),
        ...(metadata.status === "lost" ? { error: "backing session missing" } : {}),
        ...(row.backing_generation !== null
          ? { detail: createSubagentTaskBackingDetail(row.backing_generation) }
          : {}),
      });
    }
    const candidateIds = new Set(result.candidates.map((task) => task.taskId));
    const cronLookups = new Map<string, CronRecoveryLookups>();
    for (const task of result.candidates) {
      const jobId = task.runtime === "cron" ? task.sourceId?.trim() : undefined;
      if (!jobId) {
        continue;
      }
      let lookup = cronLookups.get(jobId);
      if (!lookup) {
        lookup = { taskIds: new Map(), runIds: new Map() };
        cronLookups.set(jobId, lookup);
      }
      lookup.taskIds.set(task.taskId, undefined);
      if (task.runId) {
        lookup.runIds.set(task.runId, undefined);
      }
    }
    const history = /* kysely-allow-raw: complete metadata scans cannot trust a potentially stale secondary index. */ sql<HistoryRow>`SELECT ${columns}, task_id, source_id, run_id FROM task_runs NOT INDEXED`;
    for (const row of iterateSqliteQuerySync(db, { compile: () => history.compile(kysely) })) {
      const metadata = auditRecord(row);
      if (!candidateIds.has(row.task_id)) {
        addTaskStatusSummaryRecord(result.summary, metadata, now);
      }
      const lookup =
        row.runtime === "cron" && row.source_id ? cronLookups.get(row.source_id) : undefined;
      const runId = row.run_id;
      if (!lookup || (!lookup.taskIds.has(row.task_id) && !lookup.runIds.has(runId ?? ""))) {
        continue;
      }
      const match: CronRecoveryRow = {
        createdAt: row.created_at,
        row: {
          ...metadata,
          taskId: row.task_id,
          task: "",
          ownerKey: "",
          requesterSessionKey: "",
          scopeKind: "system",
        },
      };
      if (lookup.taskIds.has(row.task_id)) {
        lookup.taskIds.set(row.task_id, earlierCronRow(lookup.taskIds.get(row.task_id), match));
      }
      if (runId && lookup.runIds.has(runId)) {
        lookup.runIds.set(runId, earlierCronRow(lookup.runIds.get(runId), match));
      }
    }
    for (const task of result.candidates) {
      const lookup =
        task.runtime === "cron" ? cronLookups.get(task.sourceId?.trim() ?? "") : undefined;
      if (!lookup) {
        continue;
      }
      const direct = lookup.taskIds.get(task.taskId);
      const byRun = task.runId ? lookup.runIds.get(task.runId) : undefined;
      const match = byRun ? earlierCronRow(direct, byRun) : direct;
      if (match) {
        result.cronRecoveryRows.set(task.taskId, match.row);
      }
    }
    return result;
  });
}
