// SQLite trajectory runtime store owns session-scoped runtime event rows.

import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../infra/kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { withSqliteDatabaseWriteScope } from "../infra/sqlite-database-admission.js";
import { assertSqliteJsonlReadBudget } from "../infra/sqlite-jsonl-budget.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES } from "./paths.js";
import { captureTrajectoryRuntimeRetentionMutation } from "./runtime-retention.sqlite.js";
import type {
  SqliteTrajectoryRuntimeAppend,
  SqliteTrajectoryRuntimeReadScope,
  TrajectoryRuntimeWindowFacts,
} from "./runtime-store.contract.js";
import type { TrajectoryEvent } from "./types.js";

export type {
  SqliteTrajectoryRuntimeAppend,
  SqliteTrajectoryRuntimeReadScope,
  SqliteTrajectoryRuntimeScope,
} from "./runtime-store.contract.js";

type SqliteTrajectoryRuntimeDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "trajectory_runtime_events"
> & { pragma_encoding: { encoding: string } };

const TRAJECTORY_RUNTIME_INSERT_BATCH_SIZE = 32;

type SqliteTrajectoryRuntimeEventRow = {
  event: TrajectoryEvent;
  seq: number;
};

type TrajectoryRuntimeAppendResult = {
  database: OpenClawAgentDatabase;
  receipt: {
    kind: "trajectory-runtime-append";
    sessionId: string;
    appendedRange: { firstSeq: number; lastSeq: number } | undefined;
    removedThroughSeq: number | undefined;
    windowFacts: TrajectoryRuntimeWindowFacts;
  };
};

type TrajectoryRuntimeWriter = (
  label: string,
  write: (database: OpenClawAgentDatabase) => TrajectoryRuntimeAppendResult,
) => TrajectoryRuntimeAppendResult;

export function appendSqliteTrajectoryRuntimeEventsWithWriter(
  input: SqliteTrajectoryRuntimeAppend,
  write: TrajectoryRuntimeWriter,
) {
  const { sessionId } = input;
  const rows = input.events.map((event) => ({
    session_id: sessionId,
    run_id: event.runId ?? null,
    event_json: event.line,
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
    const rowBytes = Buffer.byteLength(row.event_json, "utf8") + 1;
    if (!(retainedBytes + rowBytes <= maxRuntimeBytes)) {
      expiredThroughIndex = rows.length - index - 1;
      break;
    }
    retainedBytes += rowBytes;
  }
  return write("trajectory.runtime.append", (database) =>
    // Runtime event rows do not change session entries or transcript projections.
    withSqliteDatabaseWriteScope(database.db, [], () => {
      const publishRetention = captureTrajectoryRuntimeRetentionMutation(database.db);
      const db = getTrajectoryKysely(database.db);
      const window = prepareSqliteTrajectoryRuntimeWindow(database, sessionId, {
        maxRuntimeBytes,
        retainedBytes,
        expiredThroughIndex,
        discardPrevious: input.discardPrevious,
        windowFacts: input.windowFacts,
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
      return {
        database,
        receipt: {
          kind: "trajectory-runtime-append" as const,
          sessionId,
          appendedRange: rows.length ? { firstSeq: window.nextSeq, lastSeq: seq - 1 } : undefined,
          removedThroughSeq: window.removeThroughSeq,
          windowFacts: {
            nextSeq: window.removeThroughSeq === seq - 1 ? 0 : seq,
            retainedBytes: window.retainedBytes,
          },
        },
      };
    }),
  );
}

/** Loads runtime trajectory events from per-agent SQLite rows in storage order. */
export async function loadSqliteTrajectoryRuntimeEvents(
  scope: SqliteTrajectoryRuntimeReadScope & { sessionActor?: SessionActorStorageBinding },
): Promise<TrajectoryEvent[]> {
  const authority = { assertCurrent() {}, authorize() {} };
  const memory = captureSessionActorStorageOwner(scope, authority);
  if (memory) {
    return (
      (await withSessionActorStorage(
        scope,
        {
          authority,
          lifetime: { assertCurrent() {}, assertReadable() {} },
        },
        ({ actor, authority: current }) =>
          actor.storage.read(
            {
              type: "session.trajectory.read",
              input: {
                sessionId: scope.sessionId,
                maxEventBytes: scope.maxEventBytes,
                maxEventCount: scope.maxEventCount,
              },
            },
            current,
          ),
      )) ?? []
    );
  }
  const options = toDatabaseOptions(resolveSqliteReadScope(scope));
  return withSessionHistoryWorkerDatabase(options, (reader) =>
    reader.readTrajectoryEvents({ scope }),
  );
}

/** Loads runtime trajectory event rows with storage seqs for follow/export cursors. */
export function loadSqliteTrajectoryRuntimeEventRowsSync(
  scope: SqliteTrajectoryRuntimeReadScope & {
    sessionActor?: SessionActorStorageBinding;
    afterSeq?: number;
    maxEvents?: number;
    tailEvents?: number;
  },
): SqliteTrajectoryRuntimeEventRow[] {
  const source = captureSessionActorStorageOwner(scope, { assertCurrent() {}, authorize() {} });
  if (source) {
    const query = {
      type: "session.trajectory.rows" as const,
      input: {
        sessionId: scope.sessionId,
        maxEventBytes: scope.maxEventBytes,
        maxEventCount: scope.maxEventCount,
        afterSeq: scope.afterSeq,
        maxEvents: scope.maxEvents,
        tailEvents: scope.tailEvents,
      },
    };
    if (!source.owner) {
      return source.binding?.actor.storage?.readCurrent(query, source.authority) ?? [];
    }
    const session = source.owner.readSessionById(scope.sessionId, source.authority);
    return session
      ? (source.owner.readStorage(session.sessionKey, query, source.authority) ?? [])
      : [];
  }
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

function getTrajectoryKysely(database: EngineConnection) {
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
    windowFacts?: TrajectoryRuntimeWindowFacts;
  },
) {
  const known = input.windowFacts;
  if (
    known &&
    (input.discardPrevious ||
      input.expiredThroughIndex >= 0 ||
      known.retainedBytes + input.retainedBytes <= input.maxRuntimeBytes)
  ) {
    const removeThroughSeq =
      input.expiredThroughIndex >= 0
        ? known.nextSeq + input.expiredThroughIndex
        : input.discardPrevious
          ? known.nextSeq - 1
          : undefined;
    return {
      nextSeq: known.nextSeq,
      removeThroughSeq,
      retainedBytes:
        removeThroughSeq === undefined
          ? known.retainedBytes + input.retainedBytes
          : input.retainedBytes,
    };
  }
  const db = getTrajectoryKysely(database.db);
  const rows = iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("trajectory_runtime_events")
      .select("seq")
      .select((eb) => {
        // octet_length reads stored byte sizes without loading overflow pages. Only
        // UTF-8 stores match the capture budget; preserve text decoding for UTF-16.
        const utf8 = isPostgresSqlConnection(database.db)
          ? eb.lit(true)
          : eb(eb.selectFrom("pragma_encoding").select("encoding"), "=", "UTF-8");
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
    const rowBytes =
      (row.event_json === null
        ? sqliteNumber(row.event_bytes)
        : Buffer.byteLength(row.event_json, "utf8")) + 1;
    if (!(retainedBytes + rowBytes <= input.maxRuntimeBytes)) {
      removeThroughSeq = row.seq;
      break;
    }
    retainedBytes += rowBytes;
  }
  nextSeq ??= 0;
  if (input.expiredThroughIndex >= 0) {
    removeThroughSeq = nextSeq + input.expiredThroughIndex;
  } else if (input.discardPrevious) {
    // An evicted queued prefix also expires every row preceding this batch.
    removeThroughSeq = nextSeq - 1;
  }
  return { nextSeq, removeThroughSeq, retainedBytes };
}
