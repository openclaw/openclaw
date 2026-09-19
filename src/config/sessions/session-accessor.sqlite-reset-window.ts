// Reset boundaries project a logical message window without rewriting raw cursor positions.
import type { SessionTreeEntry } from "@openclaw/agent-core";
import { sql } from "kysely";
import { selectResetKeptEntries } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import {
  iterateUnindexedActiveTranscriptNavigation,
  iterateUnindexedTranscriptNavigation,
} from "./session-accessor.sqlite-history-navigation.js";
import type {
  UnindexedActiveTranscriptNavigation,
  UnindexedHistoryControl,
  UnindexedTranscriptNavigation,
} from "./session-accessor.sqlite-history-navigation.types.js";
import {
  getActiveTranscriptKysely,
  getMessageRangeReaders,
  selectMessageRows,
  selectMessagePayload,
  selectMessageMetadata,
  type MessageRangeSelection,
  parseActiveTranscriptMessageRow,
  type CurrentTranscriptProjection,
  type SessionTranscriptMessageEvent,
} from "./session-accessor.sqlite-projection-read.js";
import {
  projectModelContextNavigationSql,
  projectResetBoundaryNavigationSql,
} from "./session-model-context-projection.js";

type VisibleMessagePositions = {
  boundaryActivePosition?: number;
  kept: number[];
  postStart: number;
  total: number;
};

type ResetMessageWindow = {
  boundarySeq: number;
  contextPrefixEventCount: number;
  keptMessagePositions: number[];
  contextPrefixSizeBytes: number;
  postBoundaryMessagePosition: number;
  boundaryActivePosition: number;
};

type ResetMessageWindowCacheEntry = {
  generation: string | undefined;
  indexedSeq: number;
} & (
  | { window: ResetMessageWindow | null }
  | { controls: readonly UnindexedTranscriptNavigation[] }
);

// History readers span compactions (their window closes only at a reset). The preflight
// fuse must measure the transcript the model will actually see, which a compaction rewrites
// too; measuring it on the history scope keeps the fuse latched after the first compaction.
type BoundaryWindowScope = "history" | "context";

function isWindowBoundary(eventType: unknown, scope: BoundaryWindowScope): boolean {
  return eventType === "reset" || (scope === "context" && eventType === "compaction");
}

const resetMessageWindowCache = new Map<string, ResetMessageWindowCacheEntry>();
const MAX_RESET_MESSAGE_WINDOW_CACHE = 64;
const MAX_CACHED_UNINDEXED_CONTROLS = 4096;

type VisibleMessageRange = MessageRangeSelection & {
  logicalPosition: (position: number) => number;
};

function cacheResetMessageWindow(key: string, entry: ResetMessageWindowCacheEntry): void {
  resetMessageWindowCache.delete(key);
  resetMessageWindowCache.set(key, entry);
  pruneMapToMaxSize(resetMessageWindowCache, MAX_RESET_MESSAGE_WINDOW_CACHE);
}

/** Imported controls keep raw identity; resolve their active positions in each read snapshot. */
export function readUnindexedHistoryControls(
  projection: CurrentTranscriptProjection,
  beforeRawSeq?: number,
): readonly UnindexedHistoryControl[] {
  if (!projection.hasUnindexedPrefix) {
    return [];
  }
  const coveredThrough = Math.min(projection.state.indexedSeq, (beforeRawSeq ?? Infinity) - 1);
  const snapshot = projection.unindexedHistoryControls;
  if (snapshot && snapshot.coveredThrough >= coveredThrough) {
    return snapshot.coveredThrough === coveredThrough
      ? snapshot.rows
      : snapshot.rows.filter((row) => row.event_seq <= coveredThrough);
  }
  const key = `${projection.database.path}\0${projection.resolved.sessionId}\0unindexed-controls`;
  const cached = resetMessageWindowCache.get(key);
  const reusable =
    cached &&
    "controls" in cached &&
    cached.generation === projection.generation &&
    cached.indexedSeq <= projection.state.indexedSeq
      ? cached
      : undefined;
  const controls = [...(reusable?.controls ?? [])];
  if (!reusable || reusable.indexedSeq < coveredThrough) {
    for (const row of iterateUnindexedTranscriptNavigation(projection, {
      afterRawSeq: reusable?.indexedSeq,
      maxRawSeq: coveredThrough,
      controlsOnly: true,
    })) {
      const eventType = row.event.type;
      if (eventType === "reset" || eventType === "compaction" || eventType === "custom_message") {
        controls.push(row);
      }
    }
    if (controls.length <= MAX_CACHED_UNINDEXED_CONTROLS) {
      cacheResetMessageWindow(key, {
        generation: projection.generation,
        indexedSeq: coveredThrough,
        controls,
      });
    } else {
      resetMessageWindowCache.delete(key);
    }
  }
  const eligible = controls.filter((row) => row.event_seq <= coveredThrough);
  const active = new Map<
    number,
    {
      active_position: number;
      message_position: number | null;
      following_message_position: number | null;
    }
  >();
  for (let offset = 0; offset < eligible.length; offset += 500) {
    const positions = executeSqliteQuerySync(
      projection.database.db,
      getActiveTranscriptKysely(projection.database)
        .selectFrom("session_transcript_active_events as active")
        .leftJoin("transcript_event_identities as identity", (join) =>
          join
            .onRef("identity.session_id", "=", "active.session_id")
            .onRef("identity.seq", "=", "active.event_seq"),
        )
        .leftJoin("session_transcript_active_events as following", (join) =>
          join
            .onRef("following.session_id", "=", "active.session_id")
            .on((eb) => eb("following.active_position", "=", eb("active.active_position", "+", 1))),
        )
        .select([
          "active.event_seq",
          "active.active_position",
          "active.message_position",
          "following.message_position as following_message_position",
        ])
        .where("active.session_id", "=", projection.resolved.sessionId)
        .where("identity.seq", "is", null)
        .where(
          "active.event_seq",
          "in",
          eligible.slice(offset, offset + 500).map((row) => row.event_seq),
        ),
    ).rows;
    for (const row of positions) {
      active.set(row.event_seq, row);
    }
  }
  const rows = eligible
    .flatMap((row) => {
      const position = active.get(row.event_seq);
      return position ? [{ ...row, ...position }] : [];
    })
    .toSorted((left, right) => left.active_position - right.active_position);
  projection.unindexedHistoryControls = { coveredThrough, rows };
  return rows;
}

function readLatestActiveBoundaryMetadataByType(
  projection: CurrentTranscriptProjection,
  eventType: "compaction" | "reset",
  beforeRawSeq?: number,
) {
  const db = getActiveTranscriptKysely(projection.database);
  const indexed = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_event_identities as identity", (join) =>
        join
          .onRef("identity.session_id", "=", "active.session_id")
          .onRef("identity.seq", "=", "active.event_seq"),
      )
      .select(["active.active_position", "identity.event_type", "identity.seq"])
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where("identity.event_type", "=", eventType)
      .$if(beforeRawSeq !== undefined, (query) => query.where("identity.seq", "<", beforeRawSeq!))
      .orderBy("identity.seq", "desc")
      .limit(1),
  );
  let unindexed: UnindexedActiveTranscriptNavigation | undefined;
  for (const row of readUnindexedHistoryControls(projection, beforeRawSeq)) {
    if (
      row.event.type === eventType &&
      (beforeRawSeq === undefined || row.event_seq < beforeRawSeq) &&
      (!unindexed || row.event_seq > unindexed.event_seq)
    ) {
      unindexed = row;
    }
  }
  return unindexed && (!indexed || unindexed.event_seq > indexed.seq)
    ? {
        active_position: unindexed.active_position,
        event_type: eventType,
        seq: unindexed.event_seq,
      }
    : indexed;
}

function readLatestActiveBoundaryMetadata(
  projection: CurrentTranscriptProjection,
  scope: BoundaryWindowScope,
  beforeRawSeq?: number,
) {
  const reset = readLatestActiveBoundaryMetadataByType(projection, "reset", beforeRawSeq);
  if (scope === "history") {
    return reset;
  }
  const compaction = readLatestActiveBoundaryMetadataByType(projection, "compaction", beforeRawSeq);
  return reset && (!compaction || reset.seq > compaction.seq) ? reset : compaction;
}

function readBoundaryWindowFacts(
  projection: CurrentTranscriptProjection,
  seq: number,
  scope: BoundaryWindowScope,
) {
  const row = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    getActiveTranscriptKysely(projection.database)
      .selectFrom("transcript_events")
      .select((eb) => [
        projectResetBoundaryNavigationSql(eb.ref("event_json")).as("event_json"),
        /* kysely-allow-raw: window accounting needs original bytes, not summary or reset payloads. */
        sql<number>`OCTET_LENGTH(event_json) + 1`.as("serialized_bytes"),
      ])
      .where("session_id", "=", projection.resolved.sessionId)
      .where("seq", "=", seq)
      .limit(1),
  );
  if (!row) {
    throw new Error("Active transcript boundary is missing");
  }
  const parsed = JSON.parse(row.event_json) as { firstKeptEntryId?: unknown; type?: unknown };
  if (!isWindowBoundary(parsed.type, scope)) {
    throw new Error("Active transcript boundary has invalid payload");
  }
  return { firstKeptEntryId: parsed.firstKeptEntryId, sizeBytes: row.serialized_bytes };
}

function findLatestResetMessageWindow(
  projection: CurrentTranscriptProjection,
  scope: BoundaryWindowScope,
  beforeRawSeq?: number,
): ResetMessageWindow | null {
  const db = getActiveTranscriptKysely(projection.database);
  const latestBoundary = readLatestActiveBoundaryMetadata(projection, scope, beforeRawSeq);
  if (!latestBoundary) {
    return null;
  }
  const boundary = readBoundaryWindowFacts(projection, latestBoundary.seq, scope);
  const postBoundaryMessagePosition =
    executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("session_transcript_active_events")
        .select("message_position")
        .where("session_id", "=", projection.resolved.sessionId)
        .where("active_position", ">", latestBoundary.active_position)
        .where("message_position", "is not", null)
        .orderBy("active_position", "asc")
        .limit(1),
    )?.message_position ?? projection.state.activeMessageCount;
  const keptMessagePositions: number[] = [];
  const includesBoundary = latestBoundary.event_type === "compaction";
  let contextPrefixEventCount = includesBoundary ? 1 : 0;
  let contextPrefixSizeBytes = includesBoundary ? boundary.sizeBytes : 0;
  if (typeof boundary.firstKeptEntryId === "string") {
    const indexedFirstKept = executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("session_transcript_active_events as active", (join) =>
          join
            .onRef("active.session_id", "=", "identity.session_id")
            .onRef("active.event_seq", "=", "identity.seq"),
        )
        .select("active.active_position")
        .where("identity.session_id", "=", projection.resolved.sessionId)
        .where("identity.event_id", "=", boundary.firstKeptEntryId)
        .where("active.active_position", "<", latestBoundary.active_position),
    );
    let unindexedFirstKept: UnindexedActiveTranscriptNavigation | undefined;
    for (const row of iterateUnindexedActiveTranscriptNavigation(projection, {
      beforeActivePosition: indexedFirstKept?.active_position ?? latestBoundary.active_position,
      eventIds: [boundary.firstKeptEntryId],
      first: true,
    })) {
      if (row.event.id === boundary.firstKeptEntryId) {
        unindexedFirstKept = row;
        break;
      }
    }
    const firstKept = unindexedFirstKept ?? indexedFirstKept;
    if (firstKept && firstKept.active_position < latestBoundary.active_position) {
      const candidateRows = iterateSqliteQuerySync(
        projection.database.db,
        db
          .selectFrom("session_transcript_active_events as active")
          .innerJoin("transcript_events as event", (join) =>
            join
              .onRef("event.session_id", "=", "active.session_id")
              .onRef("event.seq", "=", "active.event_seq"),
          )
          .select((eb) => [
            "active.message_position",
            /* kysely-allow-raw: preserve JS-readable overdepth rows for existing tool-pairing validation. */
            sql<string>`CASE WHEN json_valid(event.event_json)
              THEN ${projectModelContextNavigationSql(eb.ref("event.event_json"))}
              ELSE event.event_json END`.as("event_json"),
            /* kysely-allow-raw: raw-byte accounting stays independent of the transient projection. */
            sql<number>`OCTET_LENGTH(event.event_json) + 1`.as("serialized_bytes"),
          ])
          .where("active.session_id", "=", projection.resolved.sessionId)
          .where("active.active_position", ">=", firstKept.active_position)
          .where("active.active_position", "<", latestBoundary.active_position)
          .where("active.message_position", "is not", null)
          .$if(scope === "context" && latestBoundary.event_type !== "reset", (query) =>
            query.where("active.context_eligible", "=", 1),
          )
          .orderBy("active.active_position", "asc"),
      );
      const candidates = [];
      for (const row of candidateRows) {
        try {
          candidates.push({
            message_position: row.message_position,
            serialized_bytes: row.serialized_bytes,
            event: JSON.parse(row.event_json) as SessionTreeEntry,
          });
        } catch {
          continue;
        }
      }
      // A compaction keeps its whole tail; a reset replays only the paired subset.
      let keptRows = candidates;
      if (latestBoundary.event_type === "reset") {
        const keptEntries = new Set(selectResetKeptEntries(candidates.map((row) => row.event)));
        keptRows = candidates.filter((row) => keptEntries.has(row.event));
      }
      contextPrefixEventCount += keptRows.length;
      contextPrefixSizeBytes += keptRows.reduce((total, row) => total + row.serialized_bytes, 0);
      // History presentation exposes user/assistant rows, while fresh-thread context
      // also retains paired tool results. The fuse stats above must cover that context.
      for (const row of keptRows) {
        if (row.message_position === null || row.event.type !== "message") {
          continue;
        }
        const role = row.event.message.role;
        if (scope === "context" || role === "user" || role === "assistant") {
          keptMessagePositions.push(row.message_position);
        }
      }
    }
  }
  return {
    boundarySeq: latestBoundary.seq,
    contextPrefixEventCount,
    keptMessagePositions,
    contextPrefixSizeBytes,
    postBoundaryMessagePosition,
    boundaryActivePosition: latestBoundary.active_position,
  };
}

export function resolveTranscriptBoundaryWindow(
  projection: CurrentTranscriptProjection,
  scope: BoundaryWindowScope = "history",
  beforeRawSeq?: number,
): ResetMessageWindow | null {
  // A current-turn read cannot reuse a window from a later reset or compaction.
  if (beforeRawSeq !== undefined) {
    return findLatestResetMessageWindow(projection, scope, beforeRawSeq);
  }
  const key = `${projection.database.path}\0${projection.resolved.sessionId}\0${scope}`;
  const cached = resetMessageWindowCache.get(key);
  const generation = projection.generation;
  if (cached && "window" in cached) {
    if (cached.generation === generation && cached.indexedSeq === projection.state.indexedSeq) {
      return cached.window;
    }
    if (cached.generation === generation && cached.window) {
      const latestBoundary = readLatestActiveBoundaryMetadata(projection, scope);
      if (latestBoundary?.seq === cached.window.boundarySeq) {
        cacheResetMessageWindow(key, { ...cached, indexedSeq: projection.state.indexedSeq });
        return cached.window;
      }
    }
  }
  const window = findLatestResetMessageWindow(projection, scope);
  cacheResetMessageWindow(key, {
    generation,
    indexedSeq: projection.state.indexedSeq,
    window,
  });
  return window;
}

export type ClosedResetInterval = {
  startExclusiveActivePosition: number;
  endInclusiveActivePosition: number;
};

function selectActiveResetRows(projection: CurrentTranscriptProjection) {
  return getActiveTranscriptKysely(projection.database)
    .selectFrom("session_transcript_active_events as active")
    .innerJoin("transcript_event_identities as identity", (join) =>
      join
        .onRef("identity.session_id", "=", "active.session_id")
        .onRef("identity.seq", "=", "active.event_seq"),
    )
    .select("active.active_position")
    .where("active.session_id", "=", projection.resolved.sessionId)
    .where("identity.event_type", "=", "reset");
}

/** Closed interval (previous reset, this reset] for an active-path event outside the latest window. */
export function resolveClosedResetInterval(
  projection: CurrentTranscriptProjection,
  target: { activePosition: number; eventType: string },
): ClosedResetInterval | undefined {
  let closing =
    target.eventType === "reset"
      ? { active_position: target.activePosition }
      : executeSqliteQueryTakeFirstSync(
          projection.database.db,
          selectActiveResetRows(projection)
            .where("active.active_position", ">", target.activePosition)
            .orderBy("active.active_position", "asc")
            .limit(1),
        );
  const unindexedResets = readUnindexedHistoryControls(projection).filter(
    (row) => row.event.type === "reset",
  );
  if (target.eventType !== "reset") {
    const unindexedClosing = unindexedResets.find(
      (row) => row.active_position > target.activePosition,
    );
    if (
      unindexedClosing &&
      (!closing || unindexedClosing.active_position < closing.active_position)
    ) {
      closing = unindexedClosing;
    }
  }
  if (!closing) {
    return undefined;
  }
  let opening = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    selectActiveResetRows(projection)
      .where("active.active_position", "<", closing.active_position)
      .orderBy("active.active_position", "desc")
      .limit(1),
  );
  const unindexedOpening = unindexedResets.findLast(
    (row) => row.active_position < closing.active_position,
  );
  if (
    unindexedOpening &&
    (!opening || unindexedOpening.active_position > opening.active_position)
  ) {
    opening = unindexedOpening;
  }
  return {
    startExclusiveActivePosition: opening?.active_position ?? -1,
    endInclusiveActivePosition: closing.active_position,
  };
}

export function resolveVisibleMessagePositions(
  projection: CurrentTranscriptProjection,
): VisibleMessagePositions {
  const window = resolveTranscriptBoundaryWindow(projection);
  if (!window) {
    return { kept: [], postStart: 0, total: projection.state.activeMessageCount };
  }
  return {
    boundaryActivePosition: window.boundaryActivePosition,
    kept: window.keptMessagePositions,
    postStart: window.postBoundaryMessagePosition,
    total:
      window.keptMessagePositions.length +
      Math.max(0, projection.state.activeMessageCount - window.postBoundaryMessagePosition),
  };
}

function selectVisibleMessageRanges(
  projection: CurrentTranscriptProjection,
  start: number,
  endExclusive: number,
) {
  const ranges: VisibleMessageRange[] = [];
  if (endExclusive <= start) {
    return ranges;
  }
  const visible = resolveVisibleMessagePositions(projection);
  const boundedStart = Math.min(Math.max(0, start), visible.total);
  const boundedEnd = Math.min(Math.max(boundedStart, endExclusive), visible.total);
  const keptEnd = Math.min(boundedEnd, visible.kept.length);
  // Reset tails have holes where tool results were discarded. Batch exact retained
  // positions below SQLite's binding limit; sparse tails must not become N+1 reads.
  for (let offset = boundedStart; offset < keptEnd; offset += 500) {
    const positions = visible.kept.slice(offset, Math.min(offset + 500, keptEnd));
    const ordinals = new Map(positions.map((position, index) => [position, offset + index]));
    ranges.push({
      positions,
      logicalPosition: (position) => ordinals.get(position)!,
    });
  }
  const logicalStart = Math.max(boundedStart, visible.kept.length);
  if (boundedEnd > logicalStart) {
    const rawStart = visible.postStart + logicalStart - visible.kept.length;
    ranges.push({
      start: rawStart,
      endExclusive: rawStart + boundedEnd - logicalStart,
      logicalPosition: (position) => logicalStart + position - rawStart,
    });
  }
  return ranges;
}

export function readVisibleMessageRange(
  projection: CurrentTranscriptProjection,
  start: number,
  endExclusive: number,
): SessionTranscriptMessageEvent[] {
  return Array.from(iterateVisibleMessageRange(projection, start, endExclusive));
}

export function* iterateVisibleMessageRange(
  projection: CurrentTranscriptProjection,
  start: number,
  endExclusive: number,
): IterableIterator<SessionTranscriptMessageEvent> {
  for (const range of selectVisibleMessageRanges(projection, start, endExclusive)) {
    const rows =
      "positions" in range
        ? iterateSqliteQuerySync(
            projection.database.db,
            selectMessagePayload(
              selectMessageRows(projection.database, projection.resolved.sessionId, range),
            ),
          )
        : getMessageRangeReaders(projection.database).messages({
            sessionId: projection.resolved.sessionId,
            start: range.start,
            endExclusive: range.endExclusive,
          });
    for (const row of rows) {
      yield parseActiveTranscriptMessageRow(row);
    }
  }
}

export function hasUnindexedVisibleMessages(
  projection: CurrentTranscriptProjection,
  start: number,
  endExclusive: number,
): boolean {
  return selectVisibleMessageRanges(projection, start, endExclusive).some(
    (range) =>
      executeSqliteQueryTakeFirstSync(
        projection.database.db,
        selectMessageRows(projection.database, projection.resolved.sessionId, range)
          .leftJoin("transcript_event_identities as identity", (join) =>
            join
              .onRef("identity.session_id", "=", "active.session_id")
              .onRef("identity.seq", "=", "active.event_seq"),
          )
          .select("active.event_seq")
          .where("identity.seq", "is", null)
          .limit(1),
      ) !== undefined,
  );
}

/** Validate the whole selected history without materializing ordinary payloads in JavaScript. */
export function assertVisibleMessageRangeJson(
  projection: CurrentTranscriptProjection,
  start: number,
  endExclusive: number,
): void {
  for (const range of selectVisibleMessageRanges(projection, start, endExclusive)) {
    for (const row of iterateSqliteQuerySync(
      projection.database.db,
      selectMessagePayload(
        selectMessageRows(projection.database, projection.resolved.sessionId, range),
      ).where((eb) => {
        // The raw check rejects extra values; the enclosing array cannot end at a NUL.
        const enclosed = eb(eb.val("["), "||", eb("event.event_json", "||", eb.val("]")));
        return eb.or([
          eb(eb.fn<number>("json_valid", ["event.event_json"]), "=", 0),
          eb(eb.fn<number>("json_valid", [enclosed]), "=", 0),
        ]);
      }),
    )) {
      // SQLite's nesting limit is stricter than JSON.parse. Keep readable deep
      // rows and let the existing parser own actual malformed-row failures.
      parseActiveTranscriptMessageRow(row);
    }
  }
}

/** Sizes the same logical ranges without fetching or parsing excluded payloads. */
export function readVisibleMessageMetadata(
  projection: CurrentTranscriptProjection,
  start: number,
  endExclusive: number,
) {
  return Array.from(iterateVisibleMessageMetadata(projection, start, endExclusive));
}

/** Byte-bounded tails can stop sizing at their first excluded predecessor. */
export function* iterateVisibleMessageMetadata(
  projection: CurrentTranscriptProjection,
  start: number,
  endExclusive: number,
  direction: "asc" | "desc" = "asc",
): IterableIterator<{
  message_position: number;
  serialized_bytes: number;
  logicalPosition: number;
}> {
  const ranges = selectVisibleMessageRanges(projection, start, endExclusive);
  for (const range of direction === "desc" ? ranges.toReversed() : ranges) {
    const rows =
      "positions" in range
        ? iterateSqliteQuerySync(
            projection.database.db,
            selectMessageMetadata(
              selectMessageRows(projection.database, projection.resolved.sessionId, range)
                .clearOrderBy()
                .orderBy("active.message_position", direction),
            ),
          )
        : getMessageRangeReaders(projection.database)[
            direction === "desc" ? "metadataDescending" : "metadata"
          ]({
            sessionId: projection.resolved.sessionId,
            start: range.start,
            endExclusive: range.endExclusive,
          });
    for (const row of rows) {
      yield {
        message_position: row.message_position,
        serialized_bytes: row.serialized_bytes,
        // Position-based mapping preserves logical holes if a joined row is absent.
        logicalPosition: range.logicalPosition(row.message_position),
      };
    }
  }
}

/** Reads logical transcript bytes, reusing cached retained-tail facts after resets. */
export function readVisibleTranscriptStats(projection: CurrentTranscriptProjection): {
  eventCount: number;
  sizeBytes: number;
} {
  const window = resolveTranscriptBoundaryWindow(projection, "context");
  const db = getActiveTranscriptKysely(projection.database);
  const base = db
    .selectFrom("session_transcript_active_events as active")
    .innerJoin("transcript_events as event", (join) =>
      join
        .onRef("event.session_id", "=", "active.session_id")
        .onRef("event.seq", "=", "active.event_seq"),
    )
    .select((eb) => [
      eb.fn.count<number>("active.event_seq").as("event_count"),
      /* kysely-allow-raw: JSONL size includes one terminating newline per event. */
      sql<number>`COALESCE(SUM(OCTET_LENGTH(event.event_json)), 0)
        + COUNT(*)`.as("size_bytes"),
    ])
    .where("active.session_id", "=", projection.resolved.sessionId)
    .where("active.context_eligible", "=", 1);
  const row = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    window ? base.where("active.active_position", ">", window.boundaryActivePosition) : base,
  );
  return {
    eventCount: (row?.event_count ?? 0) + (window?.contextPrefixEventCount ?? 0),
    sizeBytes: (row?.size_bytes ?? 0) + (window?.contextPrefixSizeBytes ?? 0),
  };
}
