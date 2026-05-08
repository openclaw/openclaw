import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db.js";
import type { TrajectoryEvent } from "./types.js";

export type RecordTrajectoryRuntimeEventOptions = OpenClawAgentDatabaseOptions & {
  event: TrajectoryEvent;
  createdAt?: number;
};

type TrajectoryRuntimeEventsTable = OpenClawAgentKyselyDatabase["trajectory_runtime_events"];
type TrajectoryRuntimeDatabase = Pick<OpenClawAgentKyselyDatabase, "trajectory_runtime_events">;

type TrajectoryRuntimeEventSqlRow = Pick<Selectable<TrajectoryRuntimeEventsTable>, "event_json">;

function normalizeRunId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

export function recordTrajectoryRuntimeEvent(options: RecordTrajectoryRuntimeEventOptions): void {
  const createdAt = options.createdAt ?? Date.now();
  runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<TrajectoryRuntimeDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db.insertInto("trajectory_runtime_events").values({
        session_id: options.event.sessionId,
        run_id: normalizeRunId(options.event.runId),
        seq: options.event.seq,
        event_json: JSON.stringify(options.event),
        created_at: createdAt,
      }),
    );
  }, options);
}

export function listTrajectoryRuntimeEvents(
  options: OpenClawAgentDatabaseOptions & {
    sessionId: string;
    runId?: string;
    limit?: number;
  },
): TrajectoryEvent[] {
  const database = openOpenClawAgentDatabase(options);
  const limit =
    typeof options.limit === "number" && Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : 200_000;
  const db = getNodeSqliteKysely<TrajectoryRuntimeDatabase>(database.db);
  const normalizedRunId = normalizeRunId(options.runId);
  const query = db
    .selectFrom("trajectory_runtime_events")
    .select(["event_json"])
    .where("session_id", "=", options.sessionId)
    .$if(Boolean(normalizedRunId), (qb) => qb.where("run_id", "=", normalizedRunId))
    .orderBy("event_id", "asc")
    .limit(limit);
  const rows = executeSqliteQuerySync<TrajectoryRuntimeEventSqlRow>(database.db, query).rows;
  return rows.flatMap((row) => {
    try {
      const parsed = JSON.parse(row.event_json) as unknown;
      return isTrajectoryEvent(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

function isTrajectoryEvent(value: unknown): value is TrajectoryEvent {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { traceSchema?: unknown }).traceSchema === "openclaw-trajectory" &&
    (value as { source?: unknown }).source === "runtime" &&
    typeof (value as { sessionId?: unknown }).sessionId === "string" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}
