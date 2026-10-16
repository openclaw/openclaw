import { parseDateFirstTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
  prepareSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { assertSqliteJsonlReadBudget } from "../../infra/sqlite-jsonl-budget.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../infra/sqlite-number.js";
import { runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import {
  assertTransactionUsable,
  runSqliteDeferredTransactionSync,
} from "../../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { SessionMetadataUnavailableError } from "../../state/session-metadata-unavailable-error.js";
import type {
  LatestTranscriptAssistantText,
  SessionTranscriptReadScope,
  SessionTranscriptEventRow,
  SessionTranscriptStats,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { readSessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.js";
import type { SessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.types.js";
import {
  readTranscriptExportHead,
  toTranscriptExportSnapshot,
  type TranscriptExportOptions,
} from "./session-accessor.sqlite-export-head.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
  type SessionSqliteTargetResolutionCache,
  type ResolvedTranscriptReadScope,
} from "./session-accessor.sqlite-scope.js";
import { loadTranscriptEventRowsAfterSeqInDatabase } from "./session-accessor.sqlite-transcript-incremental-read.js";
import {
  findTranscriptEventInRows,
  readLatestAssistantTextFromDatabase,
  readTranscriptHeaderFromDatabase,
} from "./session-accessor.sqlite-transcript-metadata-read.js";
import { canRebasePreparedAssistantInTransaction } from "./session-accessor.sqlite-transcript-parent.js";
import {
  readTranscriptContextVersionInTransaction,
  readTranscriptMutationStateInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  readTranscriptStatsBatchFromDatabase,
  readTranscriptStatsFromDatabase,
} from "./session-accessor.sqlite-transcript-stats.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import { readHotSessionTranscriptSnapshot } from "./session-cold-storage-read.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import type { SessionTranscriptReadSnapshot } from "./session-history-read.types.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import {
  captureTranscriptPayloadChunk,
  isSameTranscriptContextVersion,
  readTranscriptEventsInSlices,
  TRANSCRIPT_PAYLOAD_CHUNK_BYTES,
  type TranscriptPayloadChunk,
  type TranscriptSliceTransaction,
} from "./session-transcript-payload-chunk.js";
import { SessionTranscriptStorageUnavailableError } from "./session-transcript-projection-error.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import {
  captureSessionTranscriptQuestionAnswers,
  resolveSqliteSessionTranscriptReadFence,
} from "./session-transcript-read-fence.js";
import {
  transcriptEventJsonSql,
  transcriptEventNavigationSql,
  transcriptEventResetNavigationSql,
} from "./transcript-payload.js";

export type SqliteTranscriptSnapshotRow = {
  eventJson: string;
  seq: number;
};

export type SqliteTranscriptSnapshotState =
  | { kind: "current"; rows: SqliteTranscriptSnapshotRow[] }
  | { kind: "stale" };

export type SqliteTranscriptStorageRow = SqliteTranscriptSnapshotRow & {
  createdAt: number;
};

export function createTranscriptIdentityReader(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
) {
  const actor = readSessionActorTransactionState(database, { sessionId });
  const db = getSessionKysely(database.db);
  let read: ReturnType<typeof prepareRead> | undefined;
  const prepareRead = () =>
    prepareSqliteQuerySync<
      string,
      {
        event_id: string | null;
        parent_id: string | null;
        seq: number | null;
        cold: boolean | number;
      }
    >(database.db, (parameter) =>
      db
        .selectFrom(db.selectNoFrom((eb) => eb.val(sessionId).as("session_id")).as("target"))
        .leftJoin("transcript_event_identities as identity", (join) =>
          join.onRef("identity.session_id", "=", "target.session_id").on(
            "identity.event_id",
            "=",
            parameter((eventId) => eventId),
          ),
        )
        .select(["identity.event_id", "identity.parent_id", "identity.seq"])
        .select((eb) =>
          eb
            .exists(
              eb
                .selectFrom("session_transcript_cold_archives")
                .select("session_id")
                .where("session_id", "=", sessionId),
            )
            .as("cold"),
        ),
    );
  return (eventId: string) => {
    if (actor) {
      if (actor.transcript.coldArchive) {
        throw new SessionTranscriptColdError(sessionId);
      }
      const row = actor.transcript.identities.get(eventId);
      if (row || actor.transcript.complete) {
        return row ? { eventId: row.event_id, parentId: row.parent_id, seq: row.seq } : undefined;
      }
    }
    return runSqliteReadOperationSync(database.db, () => {
      assertTransactionUsable(database.db);
      // The singleton keeps cold-state evidence even when this identity is absent.
      const row = (read ??= prepareRead())(eventId).rows[0]!;
      assertTransactionUsable(database.db);
      if (row.cold) {
        throw new SessionTranscriptColdError(sessionId);
      }
      return row.event_id !== null && row.seq !== null
        ? { eventId: row.event_id, parentId: row.parent_id, seq: row.seq }
        : undefined;
    });
  };
}

export function readTranscriptIdentityByEventId(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  eventId: string,
): { eventId: string; parentId: string | null; seq: number } | undefined {
  return createTranscriptIdentityReader(database, sessionId)(eventId);
}

export function loadTranscriptEventsSync(scope: SessionTranscriptReadScope): TranscriptEvent[] {
  return loadTranscriptReadSnapshotSync(scope).events;
}

/** Export head a batch transaction read for a transcript it left to a sliced read. */
export type TranscriptExportBatchHead = {
  head: ReturnType<typeof readTranscriptExportHead>;
  version: SessionTranscriptContextVersion;
};

/**
 * Snapshot export payloads and their identity without opening the writable lifecycle. A
 * `batchHead` is reused while the transcript context version still matches it.
 */
export function readTranscriptExportSnapshotReadOnlySync(
  scope: SessionTranscriptReadScope,
  options: TranscriptExportOptions = {},
  batchHead?: TranscriptExportBatchHead,
) {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const transaction: TranscriptReadTransaction = (read) =>
    withOpenClawAgentDatabaseReadOnly(
      (database) =>
        runSqliteDeferredTransactionSync(database.db, () => read(database), {
          operationLabel: "session transcript export snapshot",
        }),
      toDatabaseOptions(resolved),
    );
  // Reset navigation is a small native projection and stays in one transaction.
  const result =
    (options.projection === "reset-boundary"
      ? undefined
      : readTranscriptEventsInChunks({
          sessionId: resolved.sessionId,
          maxEventBytes: scope.maxEventBytes,
          projectEvent: options.projectEvent,
          transaction,
          head: (database, version) =>
            batchHead && isSameTranscriptContextVersion(version, batchHead.version)
              ? batchHead.head
              : readTranscriptExportHead(database, resolved, options),
        })) ??
    transaction((database) =>
      readTranscriptExportSnapshotFromDatabase(database, resolved, scope, options),
    );
  if (!result.found || "sliced" in result.value) {
    return undefined;
  }
  return "version" in result.value ? toTranscriptExportSnapshot(result.value) : result.value;
}

/**
 * The memory worker shares one read transaction across its bounded source batch. With
 * `sliceAboveBytes`, a transcript whose recorded size (`stats.sizeBytes`) exceeds it returns
 * its head unread as `sliced`, for `readTranscriptExportSnapshotReadOnlySync` after that
 * transaction.
 */
export function readTranscriptExportSnapshotFromDatabase(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  resolved: ResolvedTranscriptReadScope,
  scope: SessionTranscriptReadScope,
  options: TranscriptExportOptions,
  { sliceAboveBytes }: { sliceAboveBytes?: number } = {},
) {
  const head = readTranscriptExportHead(database, resolved, options);
  if (sliceAboveBytes !== undefined && !head.skipEvents && head.stats.sizeBytes > sliceAboveBytes) {
    const sliced: TranscriptExportBatchHead = {
      head,
      version: readTranscriptContextVersionInTransaction(database, resolved.sessionId),
    };
    return { sliced };
  }
  const events = head.skipEvents
    ? []
    : loadTranscriptEventsFromDatabase(database, resolved.sessionId, {
        ...options,
        beforeEventSeq: head.beforeEventSeq,
        afterEventSeq: head.afterEventSeq,
        maxEventBytes: scope.maxEventBytes,
      });
  return toTranscriptExportSnapshot({ ...head, events });
}

/** Pair loaded bytes with the watermark that also fences opaque navigation edits. */
export function loadTranscriptReadSnapshotSync(
  scope: SessionTranscriptReadScope,
  options: { readOnly?: boolean; resolvedScope?: ResolvedTranscriptReadScope } = {},
): SessionTranscriptReadSnapshot {
  const resolved = options.resolvedScope ?? resolveSqliteTranscriptReadScope(scope);
  const databaseOptions = toDatabaseOptions(resolved);
  const transaction: TranscriptReadTransaction = (read) => {
    const run = (database: TranscriptReadDatabase) =>
      runSqliteDeferredTransactionSync(database.db, () => read(database), {
        databaseLabel: database.path,
        operationLabel: "session transcript fenced read",
      });
    return options.readOnly
      ? withOpenClawAgentDatabaseReadOnly(run, databaseOptions)
      : { found: true, value: run(openOpenClawAgentDatabase(databaseOptions)) };
  };
  const head = (database: TranscriptReadDatabase) => ({
    beforeEventSeq: resolveSqliteSessionTranscriptReadFence({ database, ...resolved })
      ?.beforeRawSeq,
  });
  const result =
    readTranscriptEventsInChunks({
      sessionId: resolved.sessionId,
      maxEventBytes: scope.maxEventBytes,
      transaction,
      head,
    }) ??
    transaction((database) => ({
      events: loadTranscriptEventsFromDatabase(database, resolved.sessionId, {
        beforeEventSeq: head(database).beforeEventSeq,
        maxEventBytes: scope.maxEventBytes,
      }),
      version: readTranscriptContextVersionInTransaction(database, resolved.sessionId),
    }));
  if (!result.found) {
    throw new SessionTranscriptStorageUnavailableError(result.reason);
  }
  return { events: result.value.events, version: result.value.version };
}

/** Reads a complete maintenance transcript and its lifecycle snapshot from one transaction. */
export function inspectTranscriptEventsSync(scope: SessionTranscriptReadScope): {
  events: TranscriptEvent[];
  snapshot: SessionStateDeleteSnapshot;
} {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(
        database.db,
        () => ({
          events: readTranscriptSnapshot(database, resolved.sessionId).events,
          snapshot: readSessionStateDeleteSnapshot(database.db, resolved.sessionId),
        }),
        {
          databaseLabel: database.path,
          operationLabel: "session transcript inspection",
        },
      ),
    toDatabaseOptions(resolved),
  );
  if (!result.found) {
    throw new SessionTranscriptStorageUnavailableError(result.reason);
  }
  return result.value;
}

/** Validates a prepared assistant using indexed identities and returns its exact mutation fence. */
export function validatePreparedAssistantAppendSync(
  scope: SessionTranscriptReadScope,
  preparedParentId: string | null,
  admittedUserId?: string,
): number | null | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const questionAnswers = captureSessionTranscriptQuestionAnswers(
    database,
    resolved.sessionId,
    admittedUserId,
  );
  return runSqliteDeferredTransactionSync(
    database.db,
    () =>
      canRebasePreparedAssistantInTransaction(
        database,
        resolved.sessionId,
        preparedParentId,
        admittedUserId,
        questionAnswers?.answers,
      )
        ? readTranscriptMutationStateInTransaction(database, resolved.sessionId).updatedAt
        : undefined,
    {
      databaseLabel: database.path,
      operationLabel: "prepared assistant validation",
    },
  );
}

/** Loads only the first transcript row for header metadata hot paths. */
export function loadTranscriptHeaderSync(scope: SessionTranscriptReadScope): unknown {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readTranscriptHeaderFromDatabase(database, resolved.sessionId);
}

/** Loads additive transcript rows after one durable sequence checkpoint. */
export function loadTranscriptEventRowsAfterSeqSync(
  scope: SessionTranscriptReadScope,
  afterSeq: number,
): SessionTranscriptEventRow[] {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return loadTranscriptEventRowsAfterSeqInDatabase(database, resolved.sessionId, afterSeq);
}

/** Reads one checkpoint row so incremental consumers can reject transcript rewrites. */
export function readTranscriptEventAtSeqSync(
  scope: SessionTranscriptReadScope,
  seq: number,
): SessionTranscriptEventRow | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readHotSessionTranscriptSnapshot(database, resolved.sessionId, "checkpoint", () => {
    return readTranscriptEventAtSeqInTransaction(database, resolved.sessionId, seq);
  });
}

/** Reads one raw row within the caller's already validated transcript snapshot. */
export function readTranscriptEventAtSeqInTransaction(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  seq: number,
): SessionTranscriptEventRow | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("transcript_events")
      .select([transcriptEventJsonSql(database.db).as("event_json"), "seq"])
      .where("session_id", "=", sessionId)
      .where("seq", "=", seq),
  );
  return row
    ? {
        event: JSON.parse(row.event_json) as TranscriptEvent,
        seq: sqliteNumber(row.seq),
      }
    : undefined;
}

/** Select the same fenced rows for synchronous materialization and worker transfer. */
export function prepareTranscriptEventReadQuery(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  options: {
    beforeEventSeq?: number;
    afterEventSeq?: number;
    maxEventBytes?: number;
  } = {},
) {
  const { beforeEventSeq, maxEventBytes } = options;
  const db = getSessionKysely(database.db);
  if (maxEventBytes !== undefined && Number.isFinite(maxEventBytes) && maxEventBytes >= 0) {
    assertSqliteJsonlReadBudget(
      database.db,
      db
        .selectFrom("transcript_events")
        .select(["event_json", "event_utf8_bytes"])
        .where("session_id", "=", sessionId)
        .$if(beforeEventSeq !== undefined, (query) => query.where("seq", "<", beforeEventSeq!))
        .as("events"),
      Math.floor(maxEventBytes),
      "Trajectory transcript store",
      { hasExactUtf8Bytes: true },
    );
  }
  return db
    .selectFrom("transcript_events")
    .where("session_id", "=", sessionId)
    .$if(options.afterEventSeq !== undefined, (query) =>
      query.where("seq", ">", options.afterEventSeq!),
    )
    .$if(beforeEventSeq !== undefined, (query) => query.where("seq", "<", beforeEventSeq!));
}

export function loadTranscriptEventsFromDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  options: {
    beforeEventSeq?: number;
    afterEventSeq?: number;
    projection?: "reset-boundary";
    maxEventBytes?: number;
    projectEvent?: (event: TranscriptEvent) => TranscriptEvent;
  } = {},
): TranscriptEvent[] {
  return readHotSessionTranscriptSnapshot(database, sessionId, "events", () => {
    const rows = iterateSqliteQuerySync(
      database.db,
      prepareTranscriptEventReadQuery(database, sessionId, options)
        .select([
          options.projection === "reset-boundary"
            ? transcriptEventResetNavigationSql(database.db).as("event_json")
            : transcriptEventJsonSql(database.db).as("event_json"),
        ])
        .orderBy("seq", "asc"),
    );
    // Array.from closes the iterator on parse failure; no live cursor escapes a fenced read.
    return Array.from(rows, (row) => {
      const event: TranscriptEvent = JSON.parse(row.event_json);
      return options.projectEvent ? options.projectEvent(event) : event;
    });
  });
}

type TranscriptReadDatabase = Pick<OpenClawAgentDatabase, "db" | "path">;
type TranscriptReadTransaction = TranscriptSliceTransaction<TranscriptReadDatabase>;

/** Captures fenced payload text after `afterEventSeq`, decoded by SQLite, up to the slice budget. */
function readTranscriptPayloadChunkFromDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  options: { afterEventSeq?: number; beforeEventSeq?: number; maxEventBytes?: number },
): TranscriptPayloadChunk {
  return readHotSessionTranscriptSnapshot(database, sessionId, "events", () =>
    captureTranscriptPayloadChunk(
      TRANSCRIPT_PAYLOAD_CHUNK_BYTES,
      iterateSqliteQuerySync(
        database.db,
        prepareTranscriptEventReadQuery(database, sessionId, options)
          .select([
            "seq",
            transcriptEventJsonSql(database.db).as("event_json"),
            transcriptEventReadBytesSql().as("payload_bytes"),
          ])
          .orderBy("seq", "asc"),
      ),
    ),
  );
}

/** Bounded slices of the whole transcript, each read in its own short transaction. */
function readTranscriptEventsInChunks<
  Head extends { beforeEventSeq?: number; afterEventSeq?: number; skipEvents?: boolean },
>(params: {
  sessionId: string;
  maxEventBytes?: number;
  projectEvent?: (event: TranscriptEvent) => TranscriptEvent;
  transaction: TranscriptReadTransaction;
  head: (database: TranscriptReadDatabase, version: SessionTranscriptContextVersion) => Head;
}) {
  const { sessionId, maxEventBytes } = params;
  return readTranscriptEventsInSlices({
    transaction: params.transaction,
    head: params.head,
    projectEvent: params.projectEvent,
    readVersion: (database) => readTranscriptContextVersionInTransaction(database, sessionId),
    // The byte admission check covers the whole fenced transcript once, in the first slice.
    readSlice: (database, { first, ...range }) =>
      readTranscriptPayloadChunkFromDatabase(database, sessionId, {
        ...range,
        maxEventBytes: first ? maxEventBytes : undefined,
      }),
  });
}

export function readTranscriptSnapshot(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
): { events: TranscriptEvent[]; rows: SqliteTranscriptSnapshotRow[] } {
  const rows = readTranscriptEventRows(database, sessionId);
  return {
    events: rows.map((row) => JSON.parse(row.eventJson) as TranscriptEvent),
    rows,
  };
}

/** Reads canonical transcript text without parsing JSON for snapshot comparison. */
export function readTranscriptEventRows(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  options: { afterSeq?: number } = {},
): SqliteTranscriptSnapshotRow[] {
  return readHotSessionTranscriptSnapshot(database, sessionId, "raw rows", () => {
    const db = getSessionKysely(database.db);
    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_events")
        .select([transcriptEventJsonSql(database.db).as("event_json"), "seq"])
        .where("session_id", "=", sessionId)
        .$if(options.afterSeq !== undefined, (query) => query.where("seq", ">", options.afterSeq!))
        .orderBy("seq", "asc"),
    ).rows;
    return rows.map((row) => ({
      eventJson: row.event_json,
      seq: sqliteNumber(row.seq),
    }));
  });
}

/** Reads exact transcript storage rows for guarded doctor rewrites. */
export function readTranscriptStorageRows(
  database: OpenClawAgentDatabase,
  sessionId: string,
): SqliteTranscriptStorageRow[] {
  return readHotSessionTranscriptSnapshot(database, sessionId, "storage rows", () => {
    const db = getSessionKysely(database.db);
    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_events")
        .select(["created_at", transcriptEventJsonSql(database.db).as("event_json"), "seq"])
        .where("session_id", "=", sessionId)
        .orderBy("seq", "asc"),
    ).rows;
    return rows.map((row) => ({
      createdAt: sqliteNumber(row.created_at),
      eventJson: row.event_json,
      seq: sqliteNumber(row.seq),
    }));
  });
}

/** Reads transcript freshness and byte size without materializing event rows. */
export function readTranscriptStatsSync(scope: SessionTranscriptReadScope): SessionTranscriptStats {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readTranscriptStatsFromDatabase(database, resolved.sessionId);
}

/** Read transcript stats in database groups without joining the writable lifecycle. */
export function readTranscriptStatsBatchReadOnlySync(
  scopes: readonly SessionTranscriptReadScope[],
): Array<SessionTranscriptStats | null> {
  const results = scopes.map((): SessionTranscriptStats | null => null);
  const targetCache: SessionSqliteTargetResolutionCache = new Map();
  const groups = new Map<
    string,
    {
      options: ReturnType<typeof toDatabaseOptions>;
      items: Array<{ index: number; sessionId: string }>;
    }
  >();
  for (const [index, scope] of scopes.entries()) {
    const resolved = resolveSqliteTranscriptReadScope(scope, targetCache);
    const options = toDatabaseOptions(resolved);
    const pathname = resolveOpenClawAgentSqlitePath(options);
    const key = `${options.agentId}\0${pathname}`;
    const group = groups.get(key) ?? { options, items: [] };
    group.items.push({ index, sessionId: resolved.sessionId });
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    try {
      const read = withOpenClawAgentDatabaseReadOnly(
        (database) =>
          readTranscriptStatsBatchFromDatabase(
            database,
            group.items.map((item) => item.sessionId),
          ),
        group.options,
      );
      if (read.found) {
        for (const [index, item] of group.items.entries()) {
          results[item.index] = read.value[index]!;
        }
      }
    } catch (error) {
      if (!(error instanceof SessionMetadataUnavailableError)) {
        throw error;
      }
      // A missing table leaves the whole store unavailable, including earlier chunks.
    }
  }
  return results;
}

export function loadLatestAssistantText(
  scope: SessionTranscriptReadScope,
): LatestTranscriptAssistantText | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readLatestAssistantTextFromDatabase(database, resolved);
}

export function findTranscriptEventInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  match: (event: TranscriptEvent) => boolean,
  navigationMatch?: (event: TranscriptEvent) => boolean,
): { event: TranscriptEvent } | undefined {
  return readHotSessionTranscriptSnapshot(database, sessionId, "match", () => {
    const events = getSessionKysely(database.db)
      .selectFrom("transcript_events")
      .where("session_id", "=", sessionId);
    const selection = navigationMatch
      ? transcriptEventNavigationSql(database.db)
      : transcriptEventJsonSql(database.db);
    for (const row of iterateSqliteQuerySync(
      database.db,
      events
        .select(["seq", selection.as("event_json")])
        .select((eb) => eb("navigation_json", "is not", null).as("projected"))
        .orderBy("seq", "desc"),
    )) {
      const prefilter = row.projected ? navigationMatch : undefined;
      if (prefilter && !findTranscriptEventInRows([row], prefilter)) {
        continue;
      }
      // Identity TEXT already is the canonical payload, including exceptional JSON.
      const payload = prefilter
        ? executeSqliteQueryTakeFirstSync(
            database.db,
            events
              .select(transcriptEventJsonSql(database.db).as("event_json"))
              .where("seq", "=", row.seq),
          )
        : row;
      const found = payload && findTranscriptEventInRows([payload], match);
      if (found) {
        return found;
      }
    }
    return undefined;
  });
}

/** Match assistant identity without decoding unrelated message bodies under the writer lock. */
export function findAssistantTranscriptEventInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  idempotencyKey?: string,
): { event: TranscriptEvent } | undefined {
  const matches = (event: TranscriptEvent) => {
    const message = readTranscriptEventMessage(event);
    return (
      message?.role === "assistant" &&
      (idempotencyKey === undefined || message.idempotencyKey === idempotencyKey)
    );
  };
  return findTranscriptEventInDatabase(database, sessionId, matches, matches);
}

export function readTranscriptEventMessage(
  event: TranscriptEvent,
): Record<string, unknown> | undefined {
  return asOptionalRecord(asOptionalRecord(event)?.message);
}

export function readTranscriptEventId(event: TranscriptEvent): string | undefined {
  const id = asOptionalRecord(event)?.id;
  return typeof id === "string" && id.trim() ? id : undefined;
}

export function readEventTimestamp(event: unknown): number | undefined {
  return parseDateFirstTimestampMs(asOptionalRecord(event)?.timestamp);
}

export function isSqliteTranscriptSnapshotUnchanged(
  database: OpenClawAgentDatabase,
  sessionId: string,
  expected: readonly SqliteTranscriptSnapshotRow[],
): boolean {
  const current = readTranscriptEventRows(database, sessionId);
  return (
    current.length === expected.length &&
    current.every(
      (row, index) =>
        row.seq === expected[index]?.seq && row.eventJson === expected[index]?.eventJson,
    )
  );
}

export function assertSqliteTranscriptSnapshotUnchanged(
  database: OpenClawAgentDatabase,
  sessionId: string,
  expected: readonly SqliteTranscriptSnapshotRow[],
): void {
  if (!isSqliteTranscriptSnapshotUnchanged(database, sessionId, expected)) {
    throw new SqliteTranscriptMutationConflictError(sessionId);
  }
}
