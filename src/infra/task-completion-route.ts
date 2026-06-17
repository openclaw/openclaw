// Generic per-task completion route registry backed by the shared state SQLite database.
//
// Provides a route lookup path that survives gateway restart (vs. in-memory maps)
// and is independent of session identity (vs. session-deliveryContext persistence).
// Any task implementation (cron, subagent, acp, media) can register a route at task
// start and retire it after final delivery settles.
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

type TaskCompletionRouteDatabase = Pick<OpenClawStateKyselyDatabase, "task_completion_routes">;

export type TaskCompletionSource = "cron" | "subagent" | "acp" | "media";

export type TaskCompletionRouteInput = {
  taskId: string;
  source: TaskCompletionSource;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
};

export type TaskCompletionRouteRecord = TaskCompletionRouteInput & {
  registeredAt: number;
  retiredAt: number | null;
  deliveryAttempts: number;
  lastDeliveryStatus: string | null;
  lastDeliveryAt: number | null;
};

export type RegisterRouteResult =
  | { registered: true }
  | { registered: false; reason: "duplicate_task_id" };

function openDb(options: OpenClawStateDatabaseOptions = {}) {
  return openOpenClawStateDatabase(options);
}

function fingerprintOf(input: TaskCompletionRouteInput): string {
  return [input.channel ?? "", input.to ?? "", input.accountId ?? "", input.threadId ?? ""].join(
    "|",
  );
}

function toRecord(row: {
  task_id: string;
  source: string;
  channel: string | null;
  to_target: string | null;
  account_id: string | null;
  thread_id: string | null;
  registered_at: number;
  retired_at: number | null;
  delivery_attempts: number;
  last_delivery_status: string | null;
  last_delivery_at: number | null;
}): TaskCompletionRouteRecord {
  return {
    taskId: row.task_id,
    source: row.source as TaskCompletionSource,
    channel: row.channel ?? undefined,
    to: row.to_target ?? undefined,
    accountId: row.account_id ?? undefined,
    threadId: row.thread_id ?? undefined,
    registeredAt: row.registered_at,
    retiredAt: row.retired_at,
    deliveryAttempts: row.delivery_attempts,
    lastDeliveryStatus: row.last_delivery_status,
    lastDeliveryAt: row.last_delivery_at,
  };
}

/** Insert a completion route for a task. Idempotent on duplicate task_id. */
export function registerTaskCompletionRoute(
  input: TaskCompletionRouteInput,
  options: OpenClawStateDatabaseOptions = {},
): RegisterRouteResult {
  if (!input.taskId) {
    throw new Error("registerTaskCompletionRoute: taskId is required");
  }
  if (!input.source) {
    throw new Error("registerTaskCompletionRoute: source is required");
  }
  return runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<TaskCompletionRouteDatabase>(database.db);
    const existing = executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("task_completion_routes").select("task_id").where("task_id", "=", input.taskId),
    );
    if (existing) {
      return { registered: false, reason: "duplicate_task_id" as const };
    }
    executeSqliteQuerySync(
      database.db,
      db.insertInto("task_completion_routes").values({
        task_id: input.taskId,
        source: input.source,
        route_fingerprint: fingerprintOf(input),
        channel: input.channel ?? null,
        to_target: input.to ?? null,
        account_id: input.accountId ?? null,
        thread_id: input.threadId ?? null,
        registered_at: Date.now(),
      }),
    );
    return { registered: true };
  }, options);
}

/** Look up the active (non-retired) completion route for a task. */
export function resolveTaskCompletionRoute(
  taskId: string,
  options: OpenClawStateDatabaseOptions = {},
): TaskCompletionRouteRecord | null {
  const database = openDb(options);
  const db = getNodeSqliteKysely<TaskCompletionRouteDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("task_completion_routes")
      .select([
        "task_id",
        "source",
        "channel",
        "to_target",
        "account_id",
        "thread_id",
        "registered_at",
        "retired_at",
        "delivery_attempts",
        "last_delivery_status",
        "last_delivery_at",
      ])
      .where("task_id", "=", taskId)
      .where("retired_at", "is", null),
  );
  return row ? toRecord(row) : null;
}

/** Record the result of a single delivery attempt without retiring. */
export function noteRouteDeliveryAttempt(
  taskId: string,
  status: "delivered" | "failed",
  options: OpenClawStateDatabaseOptions = {},
): void {
  const database = openDb(options);
  const db = getNodeSqliteKysely<TaskCompletionRouteDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("task_completion_routes")
      .set({
        delivery_attempts: (eb) => eb("delivery_attempts", "+", 1),
        last_delivery_status: status,
        last_delivery_at: Date.now(),
      })
      .where("task_id", "=", taskId)
      .where("retired_at", "is", null),
  );
}

/** Mark a route as retired. Idempotent: re-retiring an already-retired route is a no-op. */
export function retireTaskCompletionRoute(
  taskId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const database = openDb(options);
  const db = getNodeSqliteKysely<TaskCompletionRouteDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("task_completion_routes")
      .set({ retired_at: Date.now() })
      .where("task_id", "=", taskId)
      .where("retired_at", "is", null),
  );
}

/** Delete orphaned (still-unretired) routes older than maxAgeMs. Returns deleted count. */
export function pruneOrphanedRoutes(
  maxAgeMs: number,
  options: OpenClawStateDatabaseOptions = {},
): { pruned: number } {
  if (maxAgeMs < 0) {
    throw new Error("pruneOrphanedRoutes: maxAgeMs must be non-negative");
  }
  const cutoff = Date.now() - maxAgeMs;
  const database = openDb(options);
  const db = getNodeSqliteKysely<TaskCompletionRouteDatabase>(database.db);
  const result = executeSqliteQuerySync(
    database.db,
    db
      .deleteFrom("task_completion_routes")
      .where("retired_at", "is", null)
      .where("registered_at", "<", cutoff),
  );
  return { pruned: Number(result.numAffectedRows ?? 0n) };
}
