import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import {
  readSessionTranscriptBoundedMessageTailPageFromProjection,
  withRecentSessionTranscriptActiveEventsInSnapshot,
} from "./session-accessor.sqlite-active-events-read.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptVisibleMessageDeltaLimits,
  SessionTranscriptVisibleMessageDeltaResult,
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  getActiveTranscriptKysely,
  getMessageRangeReaders,
  parseActiveTranscriptMessageRow,
  selectMessageMetadata,
  selectMessagePayload,
  selectMessageRows,
  type CurrentTranscriptProjection,
  type MessageRangeSelection,
  type SessionTranscriptMessageEventPage,
  type SessionTranscriptBoundedMessageTailPage,
  type SessionTranscriptBoundedMessageTailOptions,
  type SessionTranscriptMessageEvent,
} from "./session-accessor.sqlite-projection-read.js";
import {
  iterateVisibleMessageMetadata,
  readLatestActiveResetBoundary,
  readVisibleMessageRange,
  resolveVisibleMessagePositions,
  resolveTranscriptBoundaryWindow,
} from "./session-accessor.sqlite-reset-window.js";
import {
  createVisibleMessageCursor,
  encodeVisibleMessageCursor,
  MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
  normalizeVisibleDeltaLimits,
  parseVisibleMessageCursor,
  type VisibleMessageCursor,
} from "./session-accessor.sqlite-visible-cursor.js";
import {
  resolveSqliteSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import { transcriptEventNavigationSql, transcriptEventRunIdSql } from "./transcript-payload.js";
export { waitForSessionTranscriptProjection } from "./session-transcript-reconcile.js";
export {
  isSessionTranscriptProjectionUnavailableError,
  SessionTranscriptProjectionUnavailableError,
} from "./session-transcript-projection-error.js";
export type { SessionTranscriptMessageEvent } from "./session-accessor.sqlite-projection-read.js";

/** Reads every message event on the active path. Full callers remain intentionally O(output). */
export function readSessionTranscriptMessageEvents(
  scope: SessionTranscriptReadScope,
): SessionTranscriptMessageEvent[] {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const visible = resolveVisibleMessagePositions(projection);
    return readVisibleMessageRange(projection, 0, visible.total);
  });
}

/** Reads the last active-path message without hydrating its historical ancestors. */
export function readLatestSessionTranscriptMessageEvent(
  scope: SessionTranscriptReadScope,
  options?: Parameters<typeof withCurrentProjectionSnapshot>[2],
): SessionTranscriptMessageEvent | undefined {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => {
      const fence = resolveSqliteSessionTranscriptReadFence({
        database: projection.database,
        ...projection.resolved,
      });
      const row = getMessageRangeReaders(projection.database).latest({
        sessionId: projection.resolved.sessionId,
        start: 0,
        endExclusive: fence?.beforeActiveMessagePosition ?? projection.state.activeMessageCount,
      });
      return row ? parseActiveTranscriptMessageRow(row) : undefined;
    },
    options,
  );
}

/** Checks user control facts from an exact input on one active-path snapshot, without loading bodies. */
export function everySessionTranscriptUserInputFrom(
  scope: SessionTranscriptReadScope,
  idempotencyKey: string,
  accept: (message: unknown) => boolean,
  preparedProjection?: CurrentTranscriptProjection,
): boolean {
  const read = (projection: CurrentTranscriptProjection) => {
    const db = getActiveTranscriptKysely(projection.database);
    const fence = resolveSqliteSessionTranscriptReadFence({
      database: projection.database,
      ...projection.resolved,
    });
    const end = fence?.beforeActiveMessagePosition ?? projection.state.activeMessageCount;
    const anchor = executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("session_transcript_active_events as active", (join) =>
          join
            .onRef("active.session_id", "=", "identity.session_id")
            .onRef("active.event_seq", "=", "identity.seq"),
        )
        .select("active.message_position")
        .where("identity.session_id", "=", projection.resolved.sessionId)
        .where("identity.message_idempotency_key", "=", idempotencyKey)
        .where("active.message_position", "is not", null)
        .where("active.message_position", "<", end)
        .limit(1),
    );
    if (anchor?.message_position == null) {
      return false;
    }
    const window = resolveTranscriptBoundaryWindow(projection, "history", fence?.beforeRawSeq);
    const postStart = window?.postBoundaryMessagePosition ?? 0;
    // Kept-tail messages remain display history, not execution authority after
    // a reset preceding this read fence.
    if (anchor.message_position < postStart) {
      return false;
    }
    const query = selectMessageRows(projection.database, projection.resolved.sessionId, {
      start: anchor.message_position,
      endExclusive: end,
    })
      .select(
        /* kysely-allow-raw: Stream only admission control facts, never message bodies, across the exact active input range. */
        sql<string>`json_object('role', json_extract(${transcriptEventNavigationSql("event")}, '$.message.role'),
          'idempotencyKey', json_extract(${transcriptEventNavigationSql("event")}, '$.message.idempotencyKey'),
          '__openclaw', json_object('runId', ${transcriptEventRunIdSql("event")}),
          'provenance', json_extract(${transcriptEventNavigationSql("event")}, '$.message.provenance'))`.as(
          "message_json",
        ),
      )
      .where(
        /* kysely-allow-raw: User-role filtering excludes assistant/tool payloads without materializing them. */
        sql<string>`json_extract(${transcriptEventNavigationSql("event")}, '$.message.role')`,
        "=",
        "user",
      );
    let seen = false;
    for (const row of iterateSqliteQuerySync(projection.database.db, query)) {
      seen = true;
      if (!accept(JSON.parse(row.message_json))) {
        return false;
      }
    }
    return seen;
  };
  return preparedProjection ? read(preparedProjection) : withCurrentProjectionSnapshot(scope, read);
}

/** Read one active identity using the caller's existing admitted snapshot. */
export function readActiveTranscriptEntryIdentityInSnapshot(
  projection: CurrentTranscriptProjection,
  entryId: string,
) {
  const db = getActiveTranscriptKysely(projection.database);
  return executeSqliteQueryTakeFirstSync(
    projection.database.db,
    db
      .selectFrom("transcript_event_identities as identity")
      .innerJoin("session_transcript_active_events as active", (join) =>
        join
          .onRef("active.session_id", "=", "identity.session_id")
          .onRef("active.event_seq", "=", "identity.seq"),
      )
      .select(["identity.seq", "identity.parent_id as parentId"])
      .where("identity.session_id", "=", projection.resolved.sessionId)
      .where("identity.event_id", "=", entryId)
      .limit(1),
  );
}

/** Classifies one entry against the authoritative active path and leaf. */
export function readSessionTranscriptActivePathEntryRelation(
  scope: SessionTranscriptReadScope,
  entryId: string | null,
  options: { readOnly?: boolean } = {},
): "exact" | "ancestor" | "off-path" {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => readActivePathEntryRelationFromProjection(projection, entryId),
    options,
  );
}

export function readActivePathEntryRelationFromProjection(
  projection: CurrentTranscriptProjection,
  entryId: string | null,
): "exact" | "ancestor" | "off-path" {
  if (projection.state.leafEventId === entryId || entryId === null) {
    return projection.state.leafEventId === entryId ? "exact" : "off-path";
  }
  return readActiveTranscriptEntryIdentityInSnapshot(projection, entryId) ? "ancestor" : "off-path";
}

/** Reads a bounded context tail, preserving control facts but excluding display-only messages. */
export function readRecentSessionTranscriptActiveEvents(
  scope: SessionTranscriptReadScope,
  maxEvents: number,
  options?: Parameters<typeof withCurrentProjectionSnapshot>[2],
): TranscriptEvent[] {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) =>
      withRecentSessionTranscriptActiveEventsInSnapshot(projection, maxEvents, (visit) => {
        const events: TranscriptEvent[] = [];
        visit((event) => events.push(event));
        return events.toReversed();
      }),
    options,
  );
}

type VisibleDeltaResetReason = Extract<
  SessionTranscriptVisibleMessageDeltaResult,
  { kind: "reset" }
>["reason"];

type VisibleDeltaPage = Extract<SessionTranscriptVisibleMessageDeltaResult, { kind: "page" }>;

type LatestResetBoundary = NonNullable<ReturnType<typeof readLatestActiveResetBoundary>>;

/** Unread positions after a validated cursor: a retained reset tail, then a contiguous range. */
type VisibleDeltaRange = { kept: number[]; start: number };

/** Reads one append-stable forward page from the materialized active-message projection. */
export function readSessionTranscriptVisibleMessageDeltaCore(
  scope: SessionTranscriptReadScope,
  limits: SessionTranscriptVisibleMessageDeltaLimits = {},
  options?: Parameters<typeof withCurrentProjectionSnapshot>[2],
): SessionTranscriptVisibleMessageDeltaResult {
  const { maxMessages, maxBytes, start } = normalizeVisibleDeltaLimits(limits);
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => {
      const transcriptFence = resolveSqliteSessionTranscriptReadFence({
        database: projection.database,
        ...projection.resolved,
      });
      const generation = projection.generation;
      if (!generation) {
        return { kind: "missing" };
      }

      // Read the latest reset row at most once per snapshot, and only for reset-window
      // cursors. The fence hides resets admitted after the current turn's user entry.
      let latestReset: LatestResetBoundary | null | undefined;
      const readLatestReset = () => {
        if (latestReset === undefined) {
          latestReset =
            readLatestActiveResetBoundary(projection, transcriptFence?.beforeRawSeq) ?? null;
        }
        return latestReset;
      };
      const cursor =
        limits.cursor !== undefined ? parseVisibleMessageCursor(limits.cursor) : undefined;
      // Fresh cursors keep the caller's start mode; a reset-window cursor implies it.
      const freshCursor = (): VisibleMessageCursor => {
        const initial = createVisibleMessageCursor({
          agentId: projection.resolved.agentId,
          generation,
          sessionId: projection.resolved.sessionId,
        });
        return start === "reset-window" || cursor?.resetBoundarySeq !== undefined
          ? { ...initial, resetBoundarySeq: readLatestReset()?.seq ?? -1 }
          : initial;
      };
      const reset = (reason: VisibleDeltaResetReason) => ({
        kind: "reset" as const,
        cursor: encodeVisibleMessageCursor(freshCursor()),
        reason,
      });
      const current = limits.cursor !== undefined ? cursor : freshCursor();
      if (!current) {
        return reset("invalid_cursor");
      }
      if (
        current.agentId !== projection.resolved.agentId ||
        current.sessionId !== projection.resolved.sessionId
      ) {
        return reset("scope_mismatch");
      }
      if (current.generation !== generation) {
        return reset("generation_mismatch");
      }
      // A cursor that returned the admitted entry, or saw a reset after it, was read
      // outside this turn's fence.
      if (
        transcriptFence !== undefined &&
        (current.lastMessagePosition >= transcriptFence.beforeActiveMessagePosition ||
          (current.resetBoundarySeq ?? -1) >= transcriptFence.beforeRawSeq)
      ) {
        throw new SessionTranscriptReadFenceError(
          "Transcript read cursor has crossed the current-turn admission fence",
        );
      }
      const range = resolveVisibleDeltaRange(projection, current, {
        beforeRawSeq: transcriptFence?.beforeRawSeq,
        readLatestReset,
      });
      if ("reason" in range) {
        return reset(range.reason);
      }
      return readVisibleDeltaPage(projection, current, range, {
        endExclusive:
          transcriptFence?.beforeActiveMessagePosition ?? projection.state.activeMessageCount,
        maxBytes,
        maxMessages,
      });
    },
    options,
  );
}

/**
 * Validates a cursor's anchor and reset window, then returns the unread positions.
 * A reset-window cursor first drains the latest reset's retained tail, then every
 * message after the reset row; a newer reset invalidates it with `session_reset`.
 */
function resolveVisibleDeltaRange(
  projection: CurrentTranscriptProjection,
  cursor: VisibleMessageCursor,
  resets: { beforeRawSeq: number | undefined; readLatestReset: () => LatestResetBoundary | null },
): VisibleDeltaRange | { reason: VisibleDeltaResetReason } {
  let anchorActivePosition = -1;
  if (cursor.lastEventSeq >= 0) {
    const anchor = executeSqliteQueryTakeFirstSync(
      projection.database.db,
      getActiveTranscriptKysely(projection.database)
        .selectFrom("session_transcript_active_events")
        .select(["active_position", "message_position"])
        .where("session_id", "=", projection.resolved.sessionId)
        .where("event_seq", "=", cursor.lastEventSeq)
        .where("message_position", "is not", null),
    );
    if (anchor?.message_position == null) {
      return { reason: "anchor_missing" };
    }
    if (anchor.message_position !== cursor.lastMessagePosition) {
      return { reason: "anchor_moved" };
    }
    anchorActivePosition = anchor.active_position;
  }
  const next = cursor.lastMessagePosition + 1;
  if (cursor.resetBoundarySeq === undefined) {
    return { kept: [], start: next };
  }
  const latest = resets.readLatestReset();
  if ((latest?.seq ?? -1) !== cursor.resetBoundarySeq) {
    return { reason: "session_reset" };
  }
  // Steady-state cursors already past the reset row skip retained-tail resolution.
  if (!latest || anchorActivePosition > latest.active_position) {
    return { kept: [], start: next };
  }
  const window = resolveTranscriptBoundaryWindow(projection, "reset", resets.beforeRawSeq);
  if (!window) {
    return { kept: [], start: next };
  }
  // Retained positions precede the reset row, so a cursor past them reads only the suffix.
  return {
    kept: window.keptMessagePositions.filter((position) => position >= next),
    start: Math.max(next, window.postBoundaryMessagePosition),
  };
}

/** Selects a byte- and count-bounded page from a validated range and advances the cursor. */
function readVisibleDeltaPage(
  projection: CurrentTranscriptProjection,
  cursor: VisibleMessageCursor,
  range: VisibleDeltaRange,
  bounds: { endExclusive: number; maxBytes: number; maxMessages: number },
): VisibleDeltaPage {
  // Read one row past the count bound so hasMore needs no second query.
  const metadata = readVisibleDeltaMetadata(projection, range, bounds);
  let serializedBytes = 0;
  let selectedCount = 0;
  for (const row of metadata) {
    if (
      selectedCount >= bounds.maxMessages ||
      serializedBytes + row.serialized_bytes > bounds.maxBytes
    ) {
      break;
    }
    serializedBytes += row.serialized_bytes;
    selectedCount += 1;
  }
  const selected = metadata.slice(0, selectedCount);
  const lastSelected = selected.at(-1);
  const lastEventSeq = lastSelected?.event_seq ?? cursor.lastEventSeq;
  const lastMessagePosition = lastSelected?.message_position ?? cursor.lastMessagePosition;
  const keptSelected = selected.filter((row) => row.message_position < range.start);
  // Contiguous suffixes keep the range scan; a retained tail selects exact positions.
  const events =
    selectedCount === 0
      ? []
      : readVisibleDeltaPayload(
          projection,
          keptSelected.length === 0
            ? { start: range.start, endExclusive: lastMessagePosition + 1 }
            : { positions: selected.map((row) => row.message_position) },
        );
  const requiredBytes =
    selectedCount === 0 && metadata[0] ? metadata[0].serialized_bytes : undefined;
  return {
    kind: "page",
    cursor: encodeVisibleMessageCursor({ ...cursor, lastEventSeq, lastMessagePosition }),
    events,
    hasMore: selectedCount < metadata.length,
    ...(requiredBytes !== undefined ? { requiredBytes } : {}),
    serializedBytes,
  };
}

/** Reads ordered size metadata for at most maxMessages + 1 unread positions. */
function readVisibleDeltaMetadata(
  projection: CurrentTranscriptProjection,
  range: VisibleDeltaRange,
  bounds: { endExclusive: number; maxMessages: number },
) {
  const limit = bounds.maxMessages + 1;
  const kept =
    range.kept.length === 0
      ? []
      : executeSqliteQuerySync(
          projection.database.db,
          selectMessageMetadata(
            selectMessageRows(projection.database, projection.resolved.sessionId, {
              positions: range.kept.slice(0, limit),
            }),
          ),
        ).rows;
  if (kept.length >= limit) {
    return kept;
  }
  const suffix = executeSqliteQuerySync(
    projection.database.db,
    selectMessageMetadata(
      selectMessageRows(projection.database, projection.resolved.sessionId, {
        start: range.start,
        endExclusive: bounds.endExclusive,
      }),
    ).limit(limit - kept.length),
  ).rows;
  return [...kept, ...suffix];
}

/** Reads selected message payloads with their active-path predecessor ids. */
function readVisibleDeltaPayload(
  projection: CurrentTranscriptProjection,
  selection: MessageRangeSelection,
): VisibleDeltaPage["events"] {
  return executeSqliteQuerySync(
    projection.database.db,
    selectMessagePayload(
      selectMessageRows(projection.database, projection.resolved.sessionId, selection),
    )
      .leftJoin("session_transcript_active_events as parent_active", (join) =>
        join
          .onRef("parent_active.session_id", "=", "active.session_id")
          .on((eb) =>
            eb("parent_active.active_position", "=", eb("active.active_position", "-", 1)),
          ),
      )
      .leftJoin("transcript_event_identities as parent_identity", (join) =>
        join
          .onRef("parent_identity.session_id", "=", "parent_active.session_id")
          .onRef("parent_identity.seq", "=", "parent_active.event_seq"),
      )
      .select("parent_identity.event_id as parent_id"),
  ).rows.map((row) => {
    const { event, eventSeq, seq } = parseActiveTranscriptMessageRow(row);
    return { event, eventSeq, parentId: row.parent_id, seq };
  });
}

/** Reads a bounded active-path tail while preserving transcript line and byte caps. */
export function readRecentSessionTranscriptMessageEvents(
  scope: SessionTranscriptReadScope,
  options: { maxBytes: number; maxLines: number; maxMessages: number },
): SessionTranscriptMessageEventPage {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const visible = resolveVisibleMessagePositions(projection);
    const maxMessages = resolveIntegerOption(options.maxMessages, 0, {
      min: 0,
      max: MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
    });
    const maxLines = resolveIntegerOption(options.maxLines, 0, { min: 0 });
    if (maxMessages === 0 || maxLines === 0) {
      return {
        activeLeafEntryId: projection.state.leafEventId,
        events: [],
        totalMessages: visible.total,
      };
    }
    const maxBytes = resolveIntegerOption(options.maxBytes, 8 * 1024 * 1024, { min: 1024 });
    const candidates = iterateVisibleMessageMetadata(
      projection,
      Math.max(0, visible.total - Math.min(maxLines, maxMessages)),
      visible.total,
      "desc",
    );
    let selectedStart = visible.total;
    let bytes = 0;
    for (const row of candidates) {
      // Keep the newest event even when oversized, then a contiguous suffix. Size stored JSONL
      // before loading payloads so a small usage budget cannot materialize the entire line window.
      if (selectedStart < visible.total && bytes + row.serialized_bytes > maxBytes) {
        break;
      }
      selectedStart = row.logicalPosition;
      bytes += row.serialized_bytes;
    }
    return {
      activeLeafEntryId: projection.state.leafEventId,
      events: readVisibleMessageRange(projection, selectedStart, visible.total),
      totalMessages: visible.total,
    };
  });
}

/** Reads a message page from either end with index range predicates, never OFFSET scanning. */
export function readSessionTranscriptMessageEventPage(
  scope: SessionTranscriptReadScope,
  options: {
    maxMessages: number;
    offset: number;
    offsetFrom?: "start" | "end";
    readOnly?: boolean;
  },
): SessionTranscriptMessageEventPage {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => {
      const visible = resolveVisibleMessagePositions(projection);
      const totalMessages = visible.total;
      const offset = resolveIntegerOption(options.offset, 0, { min: 0, max: totalMessages });
      const maxMessages = resolveIntegerOption(options.maxMessages, 0, { min: 0 });
      const endExclusive =
        options.offsetFrom === "start"
          ? Math.min(totalMessages, offset + maxMessages)
          : totalMessages - offset;
      const start =
        options.offsetFrom === "start" ? offset : Math.max(0, endExclusive - maxMessages);
      return {
        activeLeafEntryId: projection.state.leafEventId,
        events: readVisibleMessageRange(projection, start, endExclusive),
        totalMessages,
      };
    },
    options,
  );
}

/** Reads a tail page whose materialized event payloads fit a hard byte budget. */
export function readSessionTranscriptBoundedMessageTailPage(
  scope: SessionTranscriptReadScope,
  options: SessionTranscriptBoundedMessageTailOptions,
): SessionTranscriptBoundedMessageTailPage {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => readSessionTranscriptBoundedMessageTailPageFromProjection(projection, options),
    options,
  );
}
