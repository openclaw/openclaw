import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { jsonNativeFieldsValid, jsonPathValue } from "../../infra/database-engine/json-values.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { SqliteJsonlReadBudgetExceededError } from "../../infra/sqlite-jsonl-budget-error.js";
import { currentSqliteOperationTiming } from "../../infra/sqlite-reader-lifecycle.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import {
  readBoundedRetentionRanges,
  transcriptPositionSet,
} from "./session-accessor.sqlite-context-navigation.js";
import type {
  SessionTranscriptBoundedActiveContext,
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  getActiveTranscriptKysely,
  selectActiveTranscriptIdentityRows,
  selectActiveTranscriptMetadataRows,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import {
  readUnindexedHistoryControls,
  resolveTranscriptBoundaryWindow,
} from "./session-accessor.sqlite-reset-window.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import { fitBackgroundResultDependencies } from "./session-background-result-dependencies.js";
import {
  normalizeBoundedContextLimits,
  selectBoundedContextRows,
} from "./session-bounded-context-selection.js";
import { readCacheTtlProjectionPrefix } from "./session-cache-ttl-prefix.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import type { SessionTranscriptContextSelection } from "./session-history-read.types.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  readTranscriptPayload,
  transcriptEventDependencyNavigationSql,
  transcriptEventResetNavigationSql,
  transcriptPredicateSql,
} from "./transcript-payload.js";
import { assertTranscriptNavigationValid } from "./transcript-predicate-fields.js";

function readUnindexedLogicalParents(
  projection: CurrentTranscriptProjection,
  contextSequences: number[],
  payloads: Map<number, TranscriptEvent>,
): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  if (contextSequences.length === 0) {
    return parents;
  }
  const rows = executeSqliteQuerySync(
    projection.database.db,
    getActiveTranscriptKysely(projection.database)
      .selectFrom("session_transcript_active_events as active")
      .leftJoin("session_transcript_active_events as previous", (join) =>
        join
          .onRef("previous.session_id", "=", "active.session_id")
          .on((eb) => eb("previous.active_position", "=", eb("active.active_position", "-", 1))),
      )
      .leftJoin("transcript_events as parent", (join) =>
        join
          .onRef("parent.session_id", "=", "previous.session_id")
          .onRef("parent.seq", "=", "previous.event_seq"),
      )
      .select((eb) => [
        "active.event_seq",
        "previous.event_seq as parent_seq",
        eb.fn
          .coalesce(
            transcriptEventResetNavigationSql(projection.database.db, "parent"),
            eb.val("null"),
          )
          .as("parent_json"),
      ])
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where("active.event_seq", "in", transcriptPositionSet(projection, contextSequences)),
  ).rows;
  for (const row of rows) {
    const entry = asOptionalRecord(payloads.get(row.event_seq));
    if (typeof entry?.id !== "string") {
      continue;
    }
    const parent =
      row.parent_seq === null ? undefined : asOptionalRecord(JSON.parse(row.parent_json));
    parents.set(entry.id, typeof parent?.id === "string" ? parent.id : null);
  }
  return parents;
}

function readIndexedLogicalParents(
  projection: CurrentTranscriptProjection,
  contextSequences: number[],
): Map<string, string | null> {
  const actor = readSessionActorTransactionState(projection.database, projection.resolved);
  if (actor?.transcript.complete) {
    const idsByPosition = new Map<number, string>();
    for (const identity of actor.transcript.identities.values()) {
      const active = actor.transcript.active.get(identity.seq);
      if (active) {
        idsByPosition.set(active.active_position, identity.event_id);
      }
    }
    const parents = new Map<string, string | null>();
    for (const seq of contextSequences) {
      const active = actor.transcript.active.get(seq);
      if (!active) {
        continue;
      }
      const id = idsByPosition.get(active.active_position);
      if (id !== undefined) {
        parents.set(id, idsByPosition.get(active.active_position - 1) ?? null);
      }
    }
    return parents;
  }
  return new Map(
    (contextSequences.length === 0
      ? []
      : executeSqliteQuerySync(
          projection.database.db,
          getActiveTranscriptKysely(projection.database)
            .selectFrom("session_transcript_active_events as active")
            .innerJoin("transcript_event_identities as entry", (join) =>
              join
                .onRef("entry.session_id", "=", "active.session_id")
                .onRef("entry.seq", "=", "active.event_seq"),
            )
            .leftJoin("session_transcript_active_events as previous", (join) =>
              join
                .onRef("previous.session_id", "=", "active.session_id")
                .on((eb) =>
                  eb("previous.active_position", "=", eb("active.active_position", "-", 1)),
                ),
            )
            .leftJoin("transcript_event_identities as parent", (join) =>
              join
                .onRef("parent.session_id", "=", "previous.session_id")
                .onRef("parent.seq", "=", "previous.event_seq"),
            )
            .select(["entry.event_id", "parent.event_id as parent_id"])
            .where("active.session_id", "=", projection.resolved.sessionId)
            .where("active.event_seq", "in", transcriptPositionSet(projection, contextSequences)),
        ).rows
    ).map((row) => [row.event_id, row.parent_id]),
  );
}

type ActiveContextReadOptions = SessionTranscriptContextSelection & {
  /** Opt-in graph admission; exceeding it never truncates the semantic window. */
  maxMaterializedBytes?: number;
  ignoreReadFence?: boolean;
  readOnly?: boolean;
  resolvedScope?: ResolvedTranscriptReadScope;
  transaction?: CurrentTranscriptProjection["database"];
  /** Consume one decoded row inside this snapshot; retain facts, not its payload. */
  onEntry?: (event: TranscriptEvent, row: { rawSeq: number; serializedBytes: number }) => void;
  onRead?: (
    projection: CurrentTranscriptProjection,
    rows: Array<{ rawSeq: number; serializedBytes: number }>,
    messagePresence: true | undefined,
  ) => void;
};

/** Read an active branch bounded by replay limits or the complete compaction window. */
export function readSessionTranscriptBoundedActiveContextCore(
  scope: SessionTranscriptReadScope,
  options: ActiveContextReadOptions,
): SessionTranscriptBoundedActiveContext {
  return readActiveContext(scope, options, true);
}

/** Plan the same window without retaining message bodies in the hydration worker. */
export function readSessionTranscriptCompactionPlan(
  scope: SessionTranscriptReadScope,
  options: ActiveContextReadOptions,
): Omit<SessionTranscriptBoundedActiveContext, "events"> {
  const { events: _events, ...metadata } = readActiveContext(scope, options, false);
  return metadata;
}

function readActiveContext(
  scope: SessionTranscriptReadScope,
  options: ActiveContextReadOptions,
  materializeEvents: boolean,
): SessionTranscriptBoundedActiveContext {
  const limits = normalizeBoundedContextLimits(options);
  const read = (projection: CurrentTranscriptProjection): SessionTranscriptBoundedActiveContext => {
    const fence = options.ignoreReadFence
      ? undefined
      : resolveSqliteSessionTranscriptReadFence({
          database: projection.database,
          ...projection.resolved,
        });
    const consume = (
      rows: Array<{ rawSeq: number; serializedBytes: number }>,
      messagePresence?: true,
    ) => {
      const consumed = options.onRead?.(projection, rows, messagePresence);
      if (isPromiseLike(consumed)) {
        void Promise.resolve(consumed).catch(() => {});
        throw new Error("Transcript snapshot consumers must remain synchronous");
      }
    };
    if (projection.version.rawSeq === null) {
      const activeLeafEntryId = fence
        ? fence.admission.effectiveParentId
        : projection.state.leafEventId;
      consume([]);
      return {
        version: projection.version,
        activeLeafEntryId,
        opaqueParents: activeLeafEntryId ? new Map([[activeLeafEntryId, null]]) : new Map(),
        parents: new Map(),
        firstKeptRanges: new Map(),
        persistedSuffixStartSeq: 0,
        boundaryCount: 0,
        events: [],
        cacheTtlProjectionPrefixes: [],
        serializedBytes: 0,
        totalEvents: 0,
        transcriptMutationAt: projection.version.updatedAt,
        truncated: false,
        ...(!fence ? { completeActivePath: true as const } : {}),
      };
    }
    const db = getActiveTranscriptKysely(projection.database);
    const transcript = db
      .selectFrom("transcript_events")
      .where("session_id", "=", projection.resolved.sessionId);
    const covered = limits ? projection.contextMetadata : undefined;
    // Migrated transcripts may place a delivery mirror before the header or lack the auxiliary
    // identity rows entirely. Select the canonical stored event by type so runtime keeps its version.
    const header = covered
      ? covered.header
      : executeSqliteQueryTakeFirstSync(
          projection.database.db,
          transcript
            .select([
              "seq",
              transcriptPredicateSql(projection.database.db, "navigation_valid").as(
                "navigation_valid",
              ),
              /* kysely-allow-raw: reject an oversized header before acquiring its JSON payload. */
              sql<number>`${transcriptEventReadBytesSql()} + 1`.as("serialized_bytes"),
            ])
            .where((eb) =>
              eb.or([
                eb(
                  transcriptPredicateSql(projection.database.db, "navigation_type"),
                  "=",
                  "session",
                ),
                eb(transcriptPredicateSql(projection.database.db, "navigation_valid"), "=", 0),
              ]),
            )
            .orderBy("seq", "asc")
            .limit(1),
        );
    assertTranscriptNavigationValid(header?.navigation_valid);
    const headerBytes = header?.serialized_bytes ?? 0;
    // Explicit reset retention wins over ordinary exclusion. The window owner
    // selects paired entries; only its newest candidates can fit this bounded read.
    const window = covered
      ? undefined
      : resolveTranscriptBoundaryWindow(projection, "context", fence?.beforeRawSeq);
    const retained =
      !limits && window?.boundaryType === "compaction" ? [] : (window?.keptMessagePositions ?? []);
    const retainedPositions = limits ? retained.slice(-(limits.maxEvents + 1)) : retained;
    // Compaction keeps custom/branch messages in its retained tail too. Reset
    // retention instead uses the owner's paired message selection.
    const startPosition =
      window?.boundaryType === "compaction"
        ? (window.firstKeptActivePosition ?? window.boundaryActivePosition)
        : window?.boundaryActivePosition;
    const activeMetadata = selectActiveTranscriptMetadataRows(projection.database);
    const metadata = covered
      ? covered.rows
          .filter((row) => !fence || row.event_seq < fence.beforeRawSeq)
          .slice(0, limits ? limits.maxEvents + 1 : undefined)
      : iterateSqliteQuerySync(
          projection.database.db,
          activeMetadata
            .where("active.session_id", "=", projection.resolved.sessionId)
            .$if(fence !== undefined, (query) =>
              query.where("active.event_seq", "<", fence!.beforeRawSeq),
            )
            .where((eb) => {
              const eligible = eb.and([
                eb("active.context_eligible", "=", 1),
                ...(!limits && startPosition !== undefined
                  ? [eb("active.active_position", ">=", startPosition)]
                  : []),
              ]);
              return retainedPositions.length > 0
                ? eb.or([
                    eligible,
                    eb(
                      "active.message_position",
                      "in",
                      transcriptPositionSet(projection, retainedPositions),
                    ),
                  ])
                : eligible;
            })
            .orderBy("active.active_position", "desc")
            .$if(limits !== undefined, (query) => query.limit(limits!.maxEvents + 1)),
        );
    const selection = selectBoundedContextRows(metadata, headerBytes, limits);
    const { selectedRows } = selection;
    const timing = currentSqliteOperationTiming();
    if (timing) {
      timing.hydrationActiveEvents = projection.state.activeEventCount;
      // Truncation consumed one rejected row; byte stops must not imply SQL exhaustion.
      timing.hydrationMetadataRows = covered
        ? undefined
        : selectedRows.length + Number(selection.truncated);
      timing.hydrationMetadataLimit = !covered && limits ? limits.maxEvents + 1 : undefined;
      timing.hydrationExhausted = !covered && limits ? Number(!selection.truncated) : undefined;
      timing.hydrationDependencyRows = undefined;
    }
    let { serializedBytes, truncated } = selection;
    const contextSequences = selectedRows.map((row) => row.event_seq);
    let boundary = covered
      ? undefined
      : executeSqliteQueryTakeFirstSync(
          projection.database.db,
          db
            .selectFrom(
              selectActiveTranscriptIdentityRows(projection.database)
                .select((eb) => [
                  "active.active_position",
                  "identity.seq",
                  eb.fn.count<number>("identity.seq").over().as("boundary_count"),
                ])
                .where("identity.session_id", "=", projection.resolved.sessionId)
                .where("identity.event_type", "in", ["compaction", "reset"])
                .$if(fence !== undefined, (query) =>
                  query.where("identity.seq", "<", fence!.beforeRawSeq),
                )
                .orderBy("active.active_position", "desc")
                .limit(1)
                .as("boundary"),
            )
            .crossJoin("transcript_events as event")
            .where("event.session_id", "=", projection.resolved.sessionId)
            .whereRef("event.seq", "=", "boundary.seq")
            .select([
              "boundary.active_position",
              "boundary.seq",
              "boundary.boundary_count",
              /* kysely-allow-raw: count boundaries without carrying payloads through the window query. */
              sql<number>`${transcriptEventReadBytesSql("event")} + 1`.as("serialized_bytes"),
            ]),
        );
    let boundaryCount = boundary?.boundary_count ?? 0;
    if (!covered && projection.hasUnindexedPrefix) {
      for (const row of readUnindexedHistoryControls(projection, fence?.beforeRawSeq)) {
        if (
          (row.event.type !== "compaction" && row.event.type !== "reset") ||
          (fence !== undefined && row.event_seq >= fence.beforeRawSeq)
        ) {
          continue;
        }
        boundaryCount += 1;
        if (!boundary || row.active_position > boundary.active_position) {
          boundary = {
            active_position: row.active_position,
            seq: row.event_seq,
            serialized_bytes: row.serialized_bytes,
            boundary_count: boundaryCount,
          };
        }
      }
    }
    contextSequences.sort((left, right) => left - right);
    let injectedBoundarySeq: number | undefined;
    if (boundary && !contextSequences.includes(boundary.seq)) {
      if (!limits || serializedBytes + boundary.serialized_bytes <= limits.maxBytes) {
        injectedBoundarySeq = boundary.seq;
        contextSequences.unshift(boundary.seq);
      } else {
        truncated = true;
      }
    }
    const dependencyNavigation =
      /* kysely-allow-raw: fixed materialized navigation column shared by dependency predicates. */ sql.ref<string>(
        "dependency.navigation_json",
      );
    // PostgreSQL rows JSONB cannot decode reach the JavaScript classifier below unfiltered;
    // SQLite decodes these escapes natively and keeps its covered-fact plan.
    const postgres = isPostgresSqlConnection(projection.database.db);
    const dependencyNative = jsonNativeFieldsValid(projection.database.db, dependencyNavigation);
    const dependencyField = <T = string | null>(path: string) => {
      const value = jsonPathValue<T>(projection.database.db, dependencyNavigation, sql.val(path));
      return postgres
        ? /* kysely-allow-raw: CASE fences native decoding of escapes JSONB rejects. */ sql<T>`CASE WHEN ${dependencyNative} THEN ${value} END`
        : value;
    };
    const dependencyCandidates = Array.from(
      iterateSqliteQuerySync(
        projection.database.db,
        db
          // Reuse each guarded navigation projection across the dependency predicates.
          .with(
            (cte) => cte("dependency").materialized(),
            () =>
              activeMetadata
                .select((eb) => [
                  "active.context_eligible",
                  /* kysely-allow-raw: covered facts never read payload navigation; legacy rows retain the exact guarded projection. */
                  sql<string>`CASE WHEN facts.seq IS NOT NULL THEN facts.dependency_navigation_json ELSE ${eb
                    .selectFrom("transcript_events as event")
                    .select(
                      transcriptEventDependencyNavigationSql(
                        projection.database.db,
                        eb.ref("active.context_eligible"),
                      ).as("navigation_json"),
                    )
                    .whereRef("event.session_id", "=", "active.session_id")
                    .whereRef("event.seq", "=", "active.event_seq")} END`.as("navigation_json"),
                ])
                .where("active.session_id", "=", projection.resolved.sessionId)
                // Exclude known ordinary identities as a set before reading payloads. Joining
                // identities here can rescan the event-type index once per active event.
                .where((eb) =>
                  eb.or([
                    eb("active.context_eligible", "=", 0),
                    eb(
                      "active.event_seq",
                      "not in",
                      db
                        .selectFrom("transcript_event_identities")
                        .select("seq")
                        .where("session_id", "=", projection.resolved.sessionId)
                        .where("event_type", "not in", ["custom", "reset", "branch_summary"]),
                    ),
                  ]),
                )
                .$if(fence !== undefined, (query) =>
                  query.where("active.event_seq", "<", fence!.beforeRawSeq),
                ),
          )
          .selectFrom("dependency")
          .select(["event_seq", "navigation_json", "serialized_bytes"])
          .where((eb) =>
            eb.or([
              ...(postgres ? [eb.not(dependencyNative)] : []),
              eb.and([
                eb("context_eligible", "=", 0),
                eb(
                  dependencyField<string | number>("$.message.excludeFromContext"),
                  "=",
                  jsonPathValue<string | number>(
                    projection.database.db,
                    sql.lit('{"value":true}'),
                    sql.lit("$.value"),
                  ),
                ),
                eb(dependencyField("$.type"), "=", "message"),
                eb(dependencyField("$.message.role"), "=", "assistant"),
                eb(dependencyField("$.message.provider"), "=", "openclaw"),
                eb(dependencyField("$.message.model"), "=", "automation-result"),
                eb(dependencyField("$.message.openclawModelPlacement"), "=", "pending"),
              ]),
              eb.and([
                eb(dependencyField("$.type"), "=", "custom"),
                eb(dependencyField("$.customType"), "=", BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE),
              ]),
              eb(dependencyField("$.type"), "in", ["reset", "branch_summary"]),
            ]),
          )
          .orderBy("active_position", "asc"),
      ),
      (row) => ({
        seq: row.event_seq,
        serialized_bytes: row.serialized_bytes,
        event: JSON.parse(row.navigation_json) as unknown,
      }),
    );
    const selectedBySeq = new Map(selectedRows.map((row) => [row.event_seq, row]));
    if (timing) {
      timing.hydrationDependencyRows = dependencyCandidates.length;
    }
    const fitted = fitBackgroundResultDependencies(
      contextSequences.map((seq) => ({
        seq,
        serialized_bytes:
          seq === boundary?.seq
            ? boundary.serialized_bytes
            : selectedBySeq.get(seq)!.serialized_bytes,
      })),
      dependencyCandidates,
      headerBytes,
      limits?.maxBytes,
    );
    contextSequences.splice(0, contextSequences.length, ...fitted.rows.map((row) => row.seq));
    serializedBytes = fitted.serializedBytes;
    if (
      materializeEvents &&
      options.maxMaterializedBytes !== undefined &&
      serializedBytes > options.maxMaterializedBytes
    ) {
      throw new SqliteJsonlReadBudgetExceededError(
        "Session transcript exceeds the materialized preparation byte limit",
      );
    }
    truncated ||= fitted.truncated;
    if (injectedBoundarySeq !== undefined && !contextSequences.includes(injectedBoundarySeq)) {
      injectedBoundarySeq = undefined;
    }
    const payloadSequences = header ? [header.seq, ...contextSequences] : contextSequences;
    const sizes = new Map(fitted.rows.map((row) => [row.seq, row.serialized_bytes]));
    if (header) {
      sizes.set(header.seq, headerBytes);
    }
    const payloads = new Map<number, TranscriptEvent>();
    let firstSelected: (typeof selectedRows)[number] | undefined;
    let anchorEntry: Record<string, unknown> | undefined;
    let injectedEntry: Record<string, unknown> | undefined;
    if (payloadSequences.length > 0) {
      for (const row of iterateSqliteQuerySync(
        projection.database.db,
        transcript
          .select(["seq", "event_json", "event_zstd", "event_utf8_bytes"])
          .where("seq", "in", transcriptPositionSet(projection, payloadSequences)),
      )) {
        const event: TranscriptEvent = JSON.parse(readTranscriptPayload(row));
        if (options.onEntry) {
          const rowBytes = sizes.get(row.seq);
          if (rowBytes === undefined) {
            throw new Error("Selected transcript row has no recorded payload size");
          }
          const consumed = options.onEntry(event, { rawSeq: row.seq, serializedBytes: rowBytes });
          if (isPromiseLike(consumed)) {
            void Promise.resolve(consumed).catch(() => {});
            throw new Error("Transcript snapshot consumers must remain synchronous");
          }
        }
        const entry = asOptionalRecord(event);
        const selected = selectedBySeq.get(row.seq);
        // Preserve only the two full anchors needed by cache-TTL projection; all
        // other payloads can be released as this cursor advances. Selection is
        // newest-first, independently of the payload cursor order.
        if (
          selected &&
          typeof entry?.id === "string" &&
          (!firstSelected || selected.active_position < firstSelected.active_position)
        ) {
          firstSelected = selected;
          anchorEntry = entry;
        }
        if (row.seq === injectedBoundarySeq) {
          injectedEntry = entry;
        }
        // Keep only facts used by ancestry and retention. In particular, do not retain
        // message content or compaction summaries beside the acknowledged byte stream.
        payloads.set(
          row.seq,
          materializeEvents
            ? event
            : entry
              ? {
                  type: typeof entry.type === "string" ? entry.type : undefined,
                  ...("id" in entry
                    ? { id: typeof entry.id === "string" ? entry.id : undefined }
                    : {}),
                  ...("parentId" in entry
                    ? { parentId: typeof entry.parentId === "string" ? entry.parentId : null }
                    : {}),
                  firstKeptEntryId:
                    typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined,
                }
              : undefined,
        );
      }
    }
    // Raw parent_id can enter an abandoned branch; retain logical parents across the cutoff.
    const parents = projection.hasUnindexedPrefix
      ? readUnindexedLogicalParents(projection, contextSequences, payloads)
      : readIndexedLogicalParents(projection, contextSequences);
    const events = materializeEvents && header ? [payloads.get(header.seq)!] : [];
    const rows = contextSequences.map((seq) => ({ event: payloads.get(seq)!, seq }));
    const opaqueParents = new Map<string, string | null>();
    let previousId: unknown;
    for (const { event, seq } of rows) {
      const entry = asOptionalRecord(event);
      if (seq === injectedBoundarySeq) {
        previousId = entry?.id;
      } else if (entry && "id" in entry && "parentId" in entry) {
        // Omitted display payloads retain an opaque ancestry link, never a fabricated event.
        if (
          typeof previousId === "string" &&
          typeof entry.parentId === "string" &&
          entry.parentId !== previousId
        ) {
          opaqueParents.set(entry.parentId, previousId);
        }
        previousId = entry.id;
      }
      if (materializeEvents) {
        events.push(event);
      }
    }

    const anchors = [
      ...(boundary && isIndexedSessionEntry(injectedEntry) && injectedEntry.type === "compaction"
        ? [{ activePosition: boundary.active_position, id: injectedEntry.id, entry: injectedEntry }]
        : []),
      ...(firstSelected && typeof anchorEntry?.id === "string"
        ? [
            {
              activePosition: firstSelected.active_position,
              id: anchorEntry.id,
              entry: anchorEntry,
            },
          ]
        : []),
    ];
    const cacheTtlProjectionPrefixes = anchors.flatMap((anchor) => {
      const prefix = readCacheTtlProjectionPrefix(projection, {
        ...anchor,
        beforeRawSeq: fence?.beforeRawSeq,
      });
      return prefix ? [prefix] : [];
    });
    const activeLeafEntryId = fence
      ? fence.admission.effectiveParentId
      : projection.state.leafEventId;
    if (activeLeafEntryId && previousId !== activeLeafEntryId) {
      opaqueParents.set(activeLeafEntryId, typeof previousId === "string" ? previousId : null);
    }
    // Retention moves forward from a cut; append ancestry moves backward. Keep both
    // outside the byte-counted events so excluded payloads cannot change either boundary.
    const firstKeptRanges = readBoundedRetentionRanges(projection, rows, header ? 1 : 0);
    const version = projection.version;
    consume(
      [
        ...(header ? [{ rawSeq: header.seq, serializedBytes: headerBytes }] : []),
        ...contextSequences.map((rawSeq) => ({ rawSeq, serializedBytes: sizes.get(rawSeq)! })),
      ],
      rows.some(({ event }) => asOptionalRecord(event)?.type === "message") ? true : undefined,
    );
    return {
      version,
      activeLeafEntryId,
      opaqueParents,
      parents,
      firstKeptRanges,
      persistedSuffixStartSeq: contextSequences[0] ?? (header ? header.seq + 1 : 0),
      boundaryCount,
      events,
      cacheTtlProjectionPrefixes,
      serializedBytes,
      totalEvents: projection.state.activeEventCount,
      transcriptMutationAt: version.updatedAt,
      truncated,
      ...(!truncated &&
      !fence &&
      !projection.hasUnindexedPrefix &&
      selectedRows.length === projection.state.activeEventCount
        ? { completeActivePath: true as const }
        : {}),
    };
  };
  return withCurrentProjectionSnapshot(scope, read, {
    readOnly: options.readOnly,
    resolvedScope: options.resolvedScope,
    transaction: options.transaction,
  });
}
