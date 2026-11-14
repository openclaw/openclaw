import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { groupPluginRecords as groupRecords } from "../../plugins/record-groups.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptReadScope,
  SessionTranscriptStats,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  openTranscriptExportInSlices,
  readTranscriptExportInSlices,
} from "./session-accessor.sqlite-export-slices.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
  type ResolvedTranscriptReadScope,
} from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { readTranscriptStatsBatchFromDatabase } from "./session-accessor.sqlite-transcript-stats.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import { assertTranscriptEventReadBudget } from "./session-transcript-read-bytes.js";
import {
  resolveSqliteSessionTranscriptReadFence,
  runWithSessionTranscriptReadFence,
} from "./session-transcript-read-fence.js";
import { transcriptEventJsonSql, transcriptEventResetNavigationSql } from "./transcript-payload.js";

// Memory exports and reset navigation read transcript snapshots without the writable lifecycle.

type TranscriptExportOptions = {
  projection?: "reset-boundary";
  /** Reduce each decoded event synchronously before retaining the snapshot. */
  projectEvent?: (event: TranscriptEvent) => TranscriptEvent;
  /** Worker-owned projection from the preceding export; null starts an incremental reader. */
  previous?: {
    events: TranscriptEvent[];
    generation: string | null;
    throughSeq: number;
  } | null;
};

type TranscriptExportSnapshot = {
  events: TranscriptEvent[];
  stats: SessionTranscriptStats;
  sessionKey: string | undefined;
  generation?: string | null;
  throughSeq?: number;
  /**
   * Rows after `afterSeq` through `throughSeq` that a sliced read still has to add, and the
   * transcript context version this head was read at.
   */
  deferred?: { afterSeq?: number; throughSeq: number; version: SessionTranscriptContextVersion };
};

type TranscriptExportRequest = {
  resolved: ResolvedTranscriptReadScope;
  scope: SessionTranscriptReadScope;
  options: TranscriptExportOptions;
  admission?: UserTurnTranscriptAdmissionReceipt;
};

type TranscriptExportRead = {
  request: TranscriptExportRequest;
  snapshot: TranscriptExportSnapshot;
  throughSeq: number;
  afterSeq?: number;
};

function transcriptExportSliceSource(
  scope: SessionTranscriptReadScope,
  options: TranscriptExportOptions,
  batchHead: TranscriptExportSnapshot | undefined,
) {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const request = { resolved, scope, options };
  return {
    ...options,
    sessionId: resolved.sessionId,
    batchHead,
    transaction: <T>(read: (database: Pick<OpenClawAgentDatabase, "db" | "path">) => T) =>
      withOpenClawAgentDatabaseReadOnly(
        (database) =>
          runSqliteReadSnapshotSync(database.db, () => read(database), {
            operationLabel: "session transcript export snapshot",
          }),
        toDatabaseOptions(resolved),
      ),
    readHead: (
      database: Pick<OpenClawAgentDatabase, "db" | "path">,
      slicing?: { deferAboveBytes: number },
    ) => readTranscriptExportSnapshotsFromDatabase(database, [request], slicing)[0]!,
  };
}

/**
 * Snapshot export payloads and their identity without opening the writable lifecycle, reading
 * the rows in bounded slices after the head. A deferred `batchHead` is reused while the
 * transcript context version still matches it.
 */
export function readTranscriptExportSnapshotReadOnlySync(
  scope: SessionTranscriptReadScope,
  options: TranscriptExportOptions = {},
  batchHead?: TranscriptExportSnapshot,
) {
  return readTranscriptExportInSlices(transcriptExportSliceSource(scope, options, batchHead));
}

/**
 * Opens a sliced export whose events are read lazily, one short transaction per slice. A
 * transcript change between slices throws `SessionTranscriptExportChangedError`.
 */
export function openTranscriptExportReadOnly(
  scope: SessionTranscriptReadScope,
  options: Omit<TranscriptExportOptions, "projection"> = {},
  batchHead?: TranscriptExportSnapshot,
) {
  return openTranscriptExportInSlices(transcriptExportSliceSource(scope, options, batchHead));
}

/**
 * Export metadata and only requested deltas within the caller's read transaction. With
 * `deferAboveBytes` on SQLite, a transcript whose recorded size exceeds it keeps its rows unread
 * and returns `deferred` for `readTranscriptExportSnapshotReadOnlySync` after that transaction.
 * PostgreSQL ignores it: the stalled checkpoint is a SQLite WAL problem, and PostgreSQL buffers
 * every query result, so unbounded slice queries would refetch the remaining rows.
 */
export function readTranscriptExportSnapshotsFromDatabase(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  requests: readonly TranscriptExportRequest[],
  { deferAboveBytes = Number.POSITIVE_INFINITY }: { deferAboveBytes?: number } = {},
): Array<TranscriptExportSnapshot | "cold"> {
  const exportStats = readTranscriptStatsBatchFromDatabase(
    database,
    requests.map(({ resolved }) => resolved.sessionId),
    { includeGeneration: true },
  );
  const pending: TranscriptExportRead[] = [];
  const snapshots = requests.map((request, index) =>
    runWithSessionTranscriptReadFence(request.admission, () => {
      const { resolved, scope, options } = request;
      const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
      const { generation, cold, sessionKey, ...stats } = exportStats[index]!;
      // Cached rows must still enter the existing archive restoration path.
      if (cold) {
        return "cold" as const;
      }
      const throughSeq = Math.min(
        stats.eventCount === 0 ? -1 : stats.maxSeq,
        fence ? fence.beforeRawSeq - 1 : Number.POSITIVE_INFINITY,
      );
      const previous =
        generation !== null &&
        options.previous?.generation === generation &&
        options.previous.throughSeq <= throughSeq
          ? options.previous
          : undefined;
      const snapshot: TranscriptExportSnapshot = {
        events: [...(previous?.events ?? [])],
        stats,
        sessionKey: resolved.sessionKey ?? sessionKey ?? undefined,
        ...(options.previous !== undefined ? { generation, throughSeq } : {}),
      };
      if (stats.eventCount > 0 && previous?.throughSeq !== throughSeq) {
        assertTranscriptEventReadBudget(database, resolved.sessionId, {
          beforeEventSeq: fence?.beforeRawSeq,
          maxEventBytes: scope.maxEventBytes,
        });
        if (stats.sizeBytes > deferAboveBytes && !isPostgresSqlConnection(database.db)) {
          const version = readTranscriptContextVersionInTransaction(database, resolved.sessionId);
          snapshot.deferred = { afterSeq: previous?.throughSeq, throughSeq, version };
        } else {
          pending.push({ request, snapshot, throughSeq, afterSeq: previous?.throughSeq });
        }
      }
      return snapshot;
    }),
  );
  for (const projection of [undefined, "reset-boundary"] as const) {
    const reads = pending.filter(({ request }) => request.options.projection === projection);
    for (let start = 0; start < reads.length;) {
      let end = start;
      let bytes = 0;
      // PostgreSQL buffers results: pack by existing source sizes, with giant sessions alone.
      while (
        end < reads.length &&
        end - start < 32 &&
        (end === start || bytes + reads[end]!.snapshot.stats.sizeBytes <= 4 * 1024 * 1024)
      ) {
        bytes += reads[end]!.snapshot.stats.sizeBytes;
        end += 1;
      }
      const batch = reads.slice(start, end);
      const bySession = groupRecords(batch, (read) => read.request.resolved.sessionId);
      const rows = iterateSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("transcript_events")
          .select([
            "session_id",
            "seq",
            (projection === "reset-boundary"
              ? transcriptEventResetNavigationSql(database.db)
              : transcriptEventJsonSql(database.db)
            ).as("event_json"),
          ])
          .where((eb) =>
            eb.or(
              batch.map(({ request, throughSeq, afterSeq }) =>
                eb.and([
                  eb("session_id", "=", request.resolved.sessionId),
                  eb("seq", "<=", throughSeq),
                  ...(afterSeq === undefined ? [] : [eb("seq", ">", afterSeq)]),
                ]),
              ),
            ),
          )
          .orderBy("session_id", "asc")
          .orderBy("seq", "asc"),
      );
      for (const row of rows) {
        for (const read of bySession.get(row.session_id)!) {
          if (
            row.seq > read.throughSeq ||
            (read.afterSeq !== undefined && row.seq <= read.afterSeq)
          ) {
            continue;
          }
          // Separate decoded objects preserve independent projections for repeated requests.
          const event: TranscriptEvent = JSON.parse(row.event_json);
          read.snapshot.events.push(
            runWithSessionTranscriptReadFence(read.request.admission, () =>
              read.request.options.projectEvent ? read.request.options.projectEvent(event) : event,
            ),
          );
        }
      }
      start = end;
    }
  }
  return snapshots;
}
