// SQLite trajectory runtime store owns session-scoped runtime event rows.

import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../infra/kysely-sync.js";
import { assertSqliteJsonlReadBudget } from "../infra/sqlite-jsonl-budget.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES } from "./paths.js";
import type { TrajectoryRuntimeRetentionPlan } from "./runtime-retention.contract.js";
import {
  beginTrajectoryRuntimeRetention,
  captureTrajectoryRuntimeRetentionMutation,
  selectTrajectoryRuntimeRetentionBatch,
  deleteTrajectoryRuntimeRetention,
  prepareTrajectoryRuntimeRetention,
  trajectoryRuntimeRetentionDue,
  trajectoryRuntimeRetentionState,
} from "./runtime-retention.sqlite.js";
import type { TrajectoryEvent } from "./types.js";

type SqliteTrajectoryRuntimeDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "trajectory_runtime_events"
> & { pragma_encoding: { encoding: string } };

const TRAJECTORY_RUNTIME_INSERT_BATCH_SIZE = 32;

export type SqliteTrajectoryRuntimeScope = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  maxGlobalRuntimeBytes?: number;
  maxRuntimeBytes?: number;
  sessionId: string;
  storePath: string;
  assertCommitAllowed?: () => void;
};

export type SqliteTrajectoryRuntimeAppend = Pick<
  SqliteTrajectoryRuntimeScope,
  "sessionId" | "maxRuntimeBytes" | "maxGlobalRuntimeBytes"
> & {
  events: readonly TrajectoryEvent[];
  /** The queued prefix exceeded this session's rolling window before admission. */
  discardPrevious?: boolean;
};

type SqliteTrajectoryRuntimeReadScope = Omit<
  SqliteTrajectoryRuntimeScope,
  "maxGlobalRuntimeBytes" | "maxRuntimeBytes"
> & {
  /** Byte budget enforced via SQL before parsing rows; ignored for tail-bounded reads. */
  maxEventBytes?: number;
  /** Row-count budget enforced via SQL before parsing rows; ignored for tail-bounded reads. */
  maxEventCount?: number;
};

type SqliteTrajectoryRuntimeEventRow = {
  event: TrajectoryEvent;
  seq: number;
};

type TrajectoryRuntimeWriter = <T>(
  label: string,
  write: (database: OpenClawAgentDatabase) => T,
) => T;

const log = createSubsystemLogger("trajectory");

/** Appends runtime trajectory events to the per-agent SQLite session store. */
export function appendSqliteTrajectoryRuntimeEvents(
  scope: SqliteTrajectoryRuntimeScope & Pick<SqliteTrajectoryRuntimeAppend, "discardPrevious">,
  events: readonly TrajectoryEvent[],
): void {
  if (events.length === 0) {
    return;
  }
  const options = toDatabaseOptions(resolveSqliteReadScope(scope));
  const write: TrajectoryRuntimeWriter = (label, operation) =>
    runOpenClawAgentWriteTransaction(
      (database) => {
        scope.assertCommitAllowed?.();
        const result = operation(database);
        scope.assertCommitAllowed?.();
        return result;
      },
      options,
      { operationLabel: label },
    );
  const input = { ...scope, events };
  const database = appendSqliteTrajectoryRuntimeEventsWithWriter(input, write);
  const state = trajectoryRuntimeRetentionState(database);
  const now = Date.now();
  // A nested append cannot commit maintenance independently of its caller.
  if (!database.db.isTransaction && trajectoryRuntimeRetentionDue(state, now)) {
    const lease = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(lease, 0, 1);
    try {
      let refreshes = 0;
      let sweepId = beginTrajectoryRuntimeRetention(database.db, lease);
      let snapshot: TrajectoryRuntimeRetentionPlan | undefined = prepareTrajectoryRuntimeRetention(
        database.db,
        input,
        now,
      );
      for (;;) {
        const batch = selectTrajectoryRuntimeRetentionBatch(database.db, { sweepId, snapshot });
        snapshot = undefined;
        const result = batch.refresh
          ? deleteTrajectoryRuntimeRetention(database, batch)
          : write("trajectory.runtime.retention.delete", (current) =>
              deleteTrajectoryRuntimeRetention(current, batch),
            );
        if (result.complete) {
          state.sweptAt = now;
          break;
        }
        if (result.refresh) {
          if (++refreshes > 1) {
            break;
          }
          sweepId = beginTrajectoryRuntimeRetention(database.db, lease);
          snapshot = prepareTrajectoryRuntimeRetention(database.db, input, now);
        }
      }
    } catch (error) {
      log.warn(`Trajectory retention deferred until the next append: ${String(error)}`);
    } finally {
      Atomics.store(lease, 0, 0);
    }
  }
}

export function appendSqliteTrajectoryRuntimeEventsWithWriter(
  input: SqliteTrajectoryRuntimeAppend,
  write: TrajectoryRuntimeWriter,
) {
  const { sessionId } = input;
  const rows = input.events.map((event) => ({
    session_id: sessionId,
    run_id: event.runId ?? null,
    event_json: JSON.stringify(event),
    created_at: parseDateStringTimestampMs(event.ts) ?? Date.now(),
    seq: 0,
  }));
  const maxRuntimeBytes = Math.max(
    1,
    Math.floor(input.maxRuntimeBytes ?? TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES),
  );
  let retainedBytes = 0;
  let expiredThroughIndex = -1;
  for (const [index, row] of rows.toReversed().entries()) {
    retainedBytes += Buffer.byteLength(row.event_json, "utf8") + 1;
    if (!(retainedBytes <= maxRuntimeBytes)) {
      expiredThroughIndex = rows.length - index - 1;
      break;
    }
  }
  return write("trajectory.runtime.append", (database) => {
    const publishRetention = captureTrajectoryRuntimeRetentionMutation(database.db);
    const db = getTrajectoryKysely(database.db);
    const window = prepareSqliteTrajectoryRuntimeWindow(database, sessionId, {
      maxRuntimeBytes,
      retainedBytes,
      expiredThroughIndex,
      discardPrevious: input.discardPrevious,
    });
    let seq = window.nextSeq;
    for (const row of rows) {
      row.seq = seq++;
    }
    for (let index = 0; index < rows.length; index += TRAJECTORY_RUNTIME_INSERT_BATCH_SIZE) {
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("trajectory_runtime_events")
          .values(rows.slice(index, index + TRAJECTORY_RUNTIME_INSERT_BATCH_SIZE)),
      );
    }
    if (window.removeThroughSeq !== undefined) {
      executeSqliteQuerySync(
        database.db,
        db
          .deleteFrom("trajectory_runtime_events")
          .where("session_id", "=", sessionId)
          .where("seq", "<=", window.removeThroughSeq),
      );
    }
    publishRetention?.(sessionId);
    return database;
  });
}

/** Loads runtime trajectory events from per-agent SQLite rows in storage order. */
export async function loadSqliteTrajectoryRuntimeEvents(
  scope: SqliteTrajectoryRuntimeReadScope,
): Promise<TrajectoryEvent[]> {
  return loadSqliteTrajectoryRuntimeEventRowsSync(scope).map((row) => row.event);
}

/** Loads runtime trajectory event rows with storage seqs for follow/export cursors. */
export function loadSqliteTrajectoryRuntimeEventRowsSync(
  scope: SqliteTrajectoryRuntimeReadScope & {
    afterSeq?: number;
    maxEvents?: number;
    tailEvents?: number;
  },
): SqliteTrajectoryRuntimeEventRow[] {
  const read = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const db = getTrajectoryKysely(database.db);
      const tailEvents =
        scope.tailEvents !== undefined && Number.isFinite(scope.tailEvents)
          ? Math.max(0, Math.floor(scope.tailEvents))
          : undefined;
      const afterSeq = scope.afterSeq;
      const events = db
        .selectFrom("trajectory_runtime_events")
        .where("session_id", "=", scope.sessionId)
        .$if(afterSeq !== undefined && Number.isFinite(afterSeq), (query) =>
          query.where("seq", ">", Math.floor(afterSeq!)),
        );
      // Budget checks and payload reads must share one snapshot so a concurrent
      // writer cannot cross the budget between admission and materialization.
      return runSqliteDeferredTransactionSync(
        database.db,
        () => {
          if (
            tailEvents === undefined &&
            scope.maxEventCount !== undefined &&
            Number.isFinite(scope.maxEventCount) &&
            scope.maxEventCount >= 0
          ) {
            const eventLimit = Math.floor(scope.maxEventCount);
            const countRow: { event_count: number | null } | undefined =
              executeSqliteQueryTakeFirstSync(
                database.db,
                events.select((eb) => [eb.fn.countAll<number>().as("event_count")]),
              );
            const eventCount = countRow?.event_count ?? 0;
            if (eventCount > eventLimit) {
              throw new Error(
                `Trajectory runtime store has too many events to export (${eventCount}; limit ${eventLimit})`,
              );
            }
          }
          if (
            scope.maxEventBytes !== undefined &&
            Number.isFinite(scope.maxEventBytes) &&
            scope.maxEventBytes >= 0 &&
            tailEvents === undefined
          ) {
            assertSqliteJsonlReadBudget(
              database.db,
              events.select("event_json").as("events"),
              Math.floor(scope.maxEventBytes),
              "Trajectory runtime store",
            );
          }
          let query = events
            .select(["seq", "event_json"])
            .orderBy("seq", tailEvents === undefined ? "asc" : "desc");
          const normalizedMaxEvents =
            scope.maxEvents !== undefined && Number.isFinite(scope.maxEvents)
              ? Math.max(0, Math.floor(scope.maxEvents))
              : undefined;
          const maxEvents =
            tailEvents === undefined
              ? normalizedMaxEvents
              : normalizedMaxEvents === undefined
                ? tailEvents
                : Math.min(tailEvents, normalizedMaxEvents);
          if (maxEvents !== undefined) {
            query = query.limit(maxEvents);
          }
          const rows = executeSqliteQuerySync(database.db, query).rows.map((row) => ({
            event: JSON.parse(row.event_json) as TrajectoryEvent,
            seq: row.seq,
          }));
          return tailEvents === undefined ? rows : rows.toReversed();
        },
        {
          databaseLabel: database.path,
          operationLabel: "trajectory runtime budget read",
        },
      );
    },
    toDatabaseOptions(resolveSqliteReadScope(scope)),
  );
  return read.found ? read.value : [];
}

function getTrajectoryKysely(database: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<SqliteTrajectoryRuntimeDatabase>(database);
}

function prepareSqliteTrajectoryRuntimeWindow(
  database: OpenClawAgentDatabase,
  sessionId: string,
  input: {
    maxRuntimeBytes: number;
    retainedBytes: number;
    expiredThroughIndex: number;
    discardPrevious?: boolean;
  },
) {
  const db = getTrajectoryKysely(database.db);
  const rows = iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("trajectory_runtime_events")
      .select("seq")
      .select((eb) => {
        // octet_length reads stored byte sizes without loading overflow pages. Only
        // UTF-8 stores match the capture budget; preserve text decoding for UTF-16.
        const utf8 = eb(eb.selectFrom("pragma_encoding").select("encoding"), "=", "UTF-8");
        return [
          eb
            .case()
            .when(utf8)
            .then(eb.fn<number>("octet_length", ["event_json"]))
            .else(0)
            .end()
            .as("event_bytes"),
          eb.case().when(utf8).then(null).else(eb.ref("event_json")).end().as("event_json"),
        ];
      })
      .where("session_id", "=", sessionId)
      .orderBy("seq", "desc"),
  );
  let nextSeq: number | undefined;
  let retainedBytes = input.retainedBytes;
  let removeThroughSeq: number | undefined;
  // The same descending read supplies the next sequence and the persisted suffix.
  // Close it before inserting under this transaction's existing writer lock.
  for (const row of rows) {
    nextSeq ??= sqliteNumber(row.seq) + 1;
    if (input.discardPrevious || input.expiredThroughIndex >= 0) {
      break;
    }
    retainedBytes +=
      (row.event_json === null
        ? sqliteNumber(row.event_bytes)
        : Buffer.byteLength(row.event_json, "utf8")) + 1;
    if (!(retainedBytes <= input.maxRuntimeBytes)) {
      removeThroughSeq = row.seq;
      break;
    }
  }
  nextSeq ??= 0;
  if (input.expiredThroughIndex >= 0) {
    removeThroughSeq = nextSeq + input.expiredThroughIndex;
  } else if (input.discardPrevious) {
    // An evicted queued prefix also expires every row preceding this batch.
    removeThroughSeq = nextSeq - 1;
  }
  return { nextSeq, removeThroughSeq };
}
