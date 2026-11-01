import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { jsonArrayElements, jsonPathValue } from "../../infra/database-engine/json-values.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptBoundedActiveContext,
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { iterateUnindexedActiveTranscriptNavigation } from "./session-accessor.sqlite-history-navigation.js";
import {
  getActiveTranscriptKysely,
  selectActiveTranscriptEventRows,
  selectActiveTranscriptIdentityRows,
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
  transcriptEventModelNavigationSql,
  transcriptEventResetNavigationSql,
  transcriptPredicateSql,
} from "./transcript-payload.js";
import { assertTranscriptNavigationValid } from "./transcript-predicate-fields.js";

function transcriptPositionSet(projection: CurrentTranscriptProjection, positions: number[]) {
  // A complete current context can exceed SQLite's bound-parameter limit.
  return /* kysely-allow-raw: Numeric position sets use one binding on both database engines. */ sql<number>`(SELECT CAST(value AS BIGINT) FROM ${jsonArrayElements(projection.database.db, sql.val(JSON.stringify(positions)))})`;
}

function readBoundedRetentionRanges(
  projection: CurrentTranscriptProjection,
  rows: Array<{ event: TranscriptEvent; seq: number }>,
  headerOffset: number,
): SessionTranscriptBoundedActiveContext["firstKeptRanges"] {
  const sequences = new Map<string, number>();
  const cuts = rows.flatMap(({ event, seq }, endIndex) => {
    const entry = asOptionalRecord(event);
    if (typeof entry?.id !== "string") {
      return [];
    }
    if (!projection.hasUnindexedPrefix || !sequences.has(entry.id)) {
      sequences.set(entry.id, seq);
    }
    return (entry.type === "compaction" || entry.type === "reset") &&
      typeof entry.firstKeptEntryId === "string"
      ? [{ id: entry.id, firstKeptEntryId: entry.firstKeptEntryId, endIndex, seq }]
      : [];
  });
  const missing = [...new Set(cuts.map((cut) => cut.firstKeptEntryId))].filter(
    (id) => !sequences.has(id),
  );
  if (missing.length > 0) {
    const lastSelectedSeq = rows.reduce((maximum, row) => Math.max(maximum, row.seq), -Infinity);
    const anchors = executeSqliteQuerySync(
      projection.database.db,
      selectActiveTranscriptIdentityRows(projection.database)
        .select(["identity.event_id", "identity.seq"])
        .where("identity.session_id", "=", projection.resolved.sessionId)
        .where("identity.event_id", "in", missing)
        .where("identity.seq", "<=", lastSelectedSeq),
    ).rows;
    for (const anchor of anchors) {
      sequences.set(anchor.event_id, anchor.seq);
    }
  }
  if (projection.hasUnindexedPrefix && cuts.length > 0) {
    // Imported duplicates can precede an indexed owner or the selected byte window.
    const unresolved = new Set(cuts.map((cut) => cut.firstKeptEntryId));
    for (const row of iterateUnindexedActiveTranscriptNavigation(projection, {
      eventIds: [...unresolved],
      maxRawSeq: cuts.reduce((maximum, cut) => Math.max(maximum, cut.seq), -Infinity) - 1,
      first: true,
    })) {
      const id = typeof row.event.id === "string" ? row.event.id : undefined;
      if (id === undefined || !unresolved.delete(id)) {
        continue;
      }
      const selectedSeq = sequences.get(id);
      if (selectedSeq === undefined || row.event_seq < selectedSeq) {
        sequences.set(id, row.event_seq);
      }
      if (unresolved.size === 0) {
        break;
      }
    }
  }
  const ranges: SessionTranscriptBoundedActiveContext["firstKeptRanges"] = new Map();
  for (const cut of cuts) {
    const firstSeq = sequences.get(cut.firstKeptEntryId);
    if (firstSeq === undefined || (projection.hasUnindexedPrefix && firstSeq >= cut.seq)) {
      continue;
    }
    // An injected boundary can precede the sorted rows, so honor its first-match position.
    let start = cut.endIndex > 0 && rows[0]!.seq >= firstSeq ? 0 : Math.min(1, cut.endIndex);
    let end = start === 0 ? 0 : cut.endIndex;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (rows[middle]!.seq < firstSeq) {
        start = middle + 1;
      } else {
        end = middle;
      }
    }
    ranges.set(cut.id, {
      startIndex: start + headerOffset,
      endIndex: cut.endIndex + headerOffset,
    });
  }
  return ranges;
}

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

/** Read an active branch bounded by replay limits or the complete compaction window. */
export function readSessionTranscriptBoundedActiveContextCore(
  scope: SessionTranscriptReadScope,
  options: SessionTranscriptContextSelection & {
    ignoreReadFence?: boolean;
    readOnly?: boolean;
    resolvedScope?: ResolvedTranscriptReadScope;
    transaction?: CurrentTranscriptProjection["database"];
    onRead?: (
      projection: CurrentTranscriptProjection,
      rows: Array<{ rawSeq: number; serializedBytes: number }>,
      messagePresence: true | undefined,
    ) => void;
  },
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
    const metadata = covered
      ? covered.rows
          .filter((row) => !fence || row.event_seq < fence.beforeRawSeq)
          .slice(0, limits ? limits.maxEvents + 1 : undefined)
      : iterateSqliteQuerySync(
          projection.database.db,
          selectActiveTranscriptEventRows(projection.database)
            .select([
              "active.event_seq",
              "active.active_position",
              /* kysely-allow-raw: active-context byte caps exclude rows before fetching or parsing. */
              sql<number>`${transcriptEventReadBytesSql("event")} + 1`.as("serialized_bytes"),
            ])
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
            .innerJoin("transcript_events as event", (join) =>
              join
                .on("event.session_id", "=", projection.resolved.sessionId)
                .onRef("event.seq", "=", "boundary.seq"),
            )
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
    const dependencyType = transcriptPredicateSql(
      projection.database.db,
      "navigation_type",
      "event",
    );
    const dependencyRole = transcriptPredicateSql(projection.database.db, "message_role", "event");
    // CASE fences payload projection: an ordinary old row may be outside this bounded read.
    const dependencyNavigation = /* kysely-allow-raw: recorded event classifications gate model navigation before any payload parser can run. */ sql<string>`CASE
      WHEN ${dependencyType} IN ('custom', 'reset') OR ${dependencyType} IS NULL
        OR (${dependencyType} = 'message' AND active.context_eligible = 0 AND ${dependencyRole} = 'assistant')
      THEN ${transcriptEventModelNavigationSql(projection.database.db, "event")}
      ELSE '{}' END`;
    const dependencyField = (path: string) =>
      jsonPathValue(projection.database.db, dependencyNavigation, sql.val(path));
    const dependencyCandidates = Array.from(
      iterateSqliteQuerySync(
        projection.database.db,
        selectActiveTranscriptEventRows(projection.database)
          .select([
            "active.event_seq",
            dependencyNavigation.as("navigation_json"),
            /* kysely-allow-raw: dependency sizes are admitted before fetching accepted result bodies. */
            sql<number>`${transcriptEventReadBytesSql("event")} + 1`.as("serialized_bytes"),
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
          )
          .where((eb) =>
            eb.or([
              eb.and([
                eb("active.context_eligible", "=", 0),
                eb(
                  jsonPathValue<string | number>(
                    projection.database.db,
                    dependencyNavigation,
                    sql.val("$.message.excludeFromContext"),
                  ),
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
          .orderBy("active.active_position", "asc"),
      ),
      (row) => ({ ...row, event: JSON.parse(row.navigation_json) as unknown }),
    );
    const selectedSizes = new Map(selectedRows.map((row) => [row.event_seq, row.serialized_bytes]));
    if (boundary) {
      selectedSizes.set(boundary.seq, boundary.serialized_bytes);
    }
    const fitted = fitBackgroundResultDependencies(
      contextSequences.map((seq) => ({ seq, serialized_bytes: selectedSizes.get(seq)! })),
      dependencyCandidates.map((row) => ({
        seq: row.event_seq,
        serialized_bytes: row.serialized_bytes,
        event: row.event,
      })),
      headerBytes,
      limits?.maxBytes,
    );
    contextSequences.splice(0, contextSequences.length, ...fitted.rows.map((row) => row.seq));
    serializedBytes = fitted.serializedBytes;
    truncated ||= fitted.truncated;
    if (injectedBoundarySeq !== undefined && !contextSequences.includes(injectedBoundarySeq)) {
      injectedBoundarySeq = undefined;
    }
    const payloadSequences = header ? [header.seq, ...contextSequences] : contextSequences;
    // One payload read follows all byte decisions; header-first ordering also supports migrated mirrors.
    const payloads = new Map<number, TranscriptEvent>();
    if (payloadSequences.length > 0) {
      for (const row of iterateSqliteQuerySync(
        projection.database.db,
        transcript
          .select(["seq", "event_json", "event_zstd", "event_utf8_bytes"])
          .where("seq", "in", transcriptPositionSet(projection, payloadSequences)),
      )) {
        payloads.set(row.seq, JSON.parse(readTranscriptPayload(row)));
      }
    }
    // Retain logical ancestry across the byte cutoff without loading parent payloads.
    // Raw parent_id can point into an abandoned branch after a leaf control.
    const parents = projection.hasUnindexedPrefix
      ? readUnindexedLogicalParents(projection, contextSequences, payloads)
      : readIndexedLogicalParents(projection, contextSequences);
    const events: TranscriptEvent[] = header ? [payloads.get(header.seq)!] : [];
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
      events.push(event);
    }
    const firstSelected = selectedRows.findLast(
      (row) => typeof asOptionalRecord(payloads.get(row.event_seq))?.id === "string",
    );
    const anchorEntry = firstSelected
      ? asOptionalRecord(payloads.get(firstSelected.event_seq))
      : undefined;
    const injectedEntry =
      injectedBoundarySeq === undefined
        ? undefined
        : asOptionalRecord(payloads.get(injectedBoundarySeq));
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
    const sizes = new Map(fitted.rows.map((row) => [row.seq, row.serialized_bytes]));
    consume(
      [
        ...(header ? [{ rawSeq: header.seq, serializedBytes: headerBytes }] : []),
        ...contextSequences.map((rawSeq) => ({ rawSeq, serializedBytes: sizes.get(rawSeq)! })),
      ],
      events.some((event) => asOptionalRecord(event)?.type === "message") ? true : undefined,
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
