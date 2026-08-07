// Reset and model-context boundaries project logical windows without rewriting
// raw cursor positions.
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptProjectionState } from "./session-transcript-index.js";

type ResetWindowDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_transcript_active_events"
  | "transcript_rewrite_watermarks"
  | "transcript_event_identities"
  | "transcript_events"
>;

type ResetWindowProjection = {
  database: OpenClawAgentDatabase;
  resolved: ReturnType<typeof resolveSqliteTranscriptReadScope>;
  state: SessionTranscriptProjectionState;
};

type VisibleMessagePositions = {
  kept: number[];
  postStart: number;
  total: number;
};

type ResetWindowMessageEvent = {
  event: TranscriptEvent;
  seq: number;
};

type BoundaryMessageWindow = {
  generation: string | undefined;
  indexedSeq: number;
  keptMessagePositions: number[];
  postBoundaryMessagePosition: number;
};

type BoundaryMessageWindowCacheEntry = {
  generation: string | undefined;
  indexedSeq: number;
  window: BoundaryMessageWindow | null;
};

type BoundaryWindowMode = "reset-only" | "context";

const boundaryMessageWindowCache = new Map<string, BoundaryMessageWindowCacheEntry>();
const MAX_BOUNDARY_MESSAGE_WINDOW_CACHE = 128;

function getResetWindowKysely(database: OpenClawAgentDatabase) {
  return getNodeSqliteKysely<ResetWindowDatabase>(database.db);
}

function parseMessageEventRow(row: {
  event_json: string;
  message_position: number | null;
}): ResetWindowMessageEvent {
  if (row.message_position === null) {
    throw new Error("Active transcript message row is missing its message position");
  }
  return {
    event: JSON.parse(row.event_json) as TranscriptEvent,
    seq: row.message_position + 1,
  };
}

function readMessageRange(
  projection: ResetWindowProjection,
  start: number,
  endExclusive: number,
): ResetWindowMessageEvent[] {
  if (endExclusive <= start) {
    return [];
  }
  const db = getResetWindowKysely(projection.database);
  return executeSqliteQuerySync(
    projection.database.db,
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select(["active.message_position", "event.event_json"])
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where("active.message_position", "is not", null)
      .where("active.message_position", ">=", start)
      .where("active.message_position", "<", endExclusive)
      .orderBy("active.message_position", "asc"),
  ).rows.map(parseMessageEventRow);
}

function parseTranscriptEventType(eventJson: string): string | undefined {
  try {
    const parsed = JSON.parse(eventJson) as { type?: unknown };
    return typeof parsed.type === "string" ? parsed.type : undefined;
  } catch {
    return undefined;
  }
}

function boundaryMessageWindowCacheKey(
  projection: ResetWindowProjection,
  mode: BoundaryWindowMode,
): string {
  return `${projection.database.path}\0${projection.resolved.sessionId}\0${mode}`;
}

function readTranscriptGeneration(projection: ResetWindowProjection): string | undefined {
  return executeSqliteQueryTakeFirstSync(
    projection.database.db,
    getResetWindowKysely(projection.database)
      .selectFrom("transcript_rewrite_watermarks")
      .select("generation")
      .where("session_id", "=", projection.resolved.sessionId),
  )?.generation;
}

function cacheBoundaryMessageWindow(key: string, entry: BoundaryMessageWindowCacheEntry): void {
  boundaryMessageWindowCache.delete(key);
  boundaryMessageWindowCache.set(key, entry);
  pruneMapToMaxSize(boundaryMessageWindowCache, MAX_BOUNDARY_MESSAGE_WINDOW_CACHE);
}

function findLatestBoundaryMessageWindow(
  projection: ResetWindowProjection,
  generation: string | undefined,
  mode: BoundaryWindowMode,
): BoundaryMessageWindow | null {
  const db = getResetWindowKysely(projection.database);
  const nonMessageRows = executeSqliteQuerySync(
    projection.database.db,
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select(["active.active_position", "event.event_json"])
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where("active.message_position", "is", null)
      .orderBy("active.active_position", "desc"),
  ).rows;
  const latestBoundaryRow = nonMessageRows.find((row) => {
    const type = parseTranscriptEventType(row.event_json);
    return type === "reset" || type === "compaction";
  });
  const boundaryType = latestBoundaryRow
    ? parseTranscriptEventType(latestBoundaryRow.event_json)
    : undefined;
  if (
    !latestBoundaryRow ||
    (mode === "reset-only" && boundaryType !== "reset") ||
    (boundaryType !== "reset" && boundaryType !== "compaction")
  ) {
    return null;
  }
  const boundaryRow = latestBoundaryRow;
  const boundary = JSON.parse(boundaryRow.event_json) as { firstKeptEntryId?: unknown };
  const postBoundaryMessagePosition =
    executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("session_transcript_active_events")
        .select("message_position")
        .where("session_id", "=", projection.resolved.sessionId)
        .where("active_position", ">", boundaryRow.active_position)
        .where("message_position", "is not", null)
        .orderBy("active_position", "asc")
        .limit(1),
    )?.message_position ?? projection.state.activeMessageCount;
  let keptMessagePositions: number[] = [];
  if (typeof boundary.firstKeptEntryId === "string") {
    const firstKept = executeSqliteQueryTakeFirstSync(
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
        .where("identity.event_id", "=", boundary.firstKeptEntryId),
    );
    if (firstKept && firstKept.active_position < boundaryRow.active_position) {
      keptMessagePositions = executeSqliteQuerySync(
        projection.database.db,
        db
          .selectFrom("session_transcript_active_events as active")
          .innerJoin("transcript_events as event", (join) =>
            join
              .onRef("event.session_id", "=", "active.session_id")
              .onRef("event.seq", "=", "active.event_seq"),
          )
          .select(["active.message_position", "event.event_json"])
          .where("active.session_id", "=", projection.resolved.sessionId)
          .where("active.active_position", ">=", firstKept.active_position)
          .where("active.active_position", "<", boundaryRow.active_position)
          .where("active.message_position", "is not", null)
          .orderBy("active.active_position", "asc"),
      ).rows.flatMap((row) => {
        if (row.message_position === null) {
          return [];
        }
        if (boundaryType === "compaction") {
          return [row.message_position];
        }
        try {
          const role = (JSON.parse(row.event_json) as { message?: { role?: unknown } }).message
            ?.role;
          return role === "user" || role === "assistant" ? [row.message_position] : [];
        } catch {
          return [];
        }
      });
    }
  }
  return {
    generation,
    indexedSeq: projection.state.indexedSeq,
    keptMessagePositions,
    postBoundaryMessagePosition,
  };
}

function resolveBoundaryMessageWindow(
  projection: ResetWindowProjection,
  mode: BoundaryWindowMode,
): BoundaryMessageWindow | null {
  const key = boundaryMessageWindowCacheKey(projection, mode);
  const cached = boundaryMessageWindowCache.get(key);
  const generation = readTranscriptGeneration(projection);
  if (cached) {
    if (cached.generation === generation && cached.indexedSeq === projection.state.indexedSeq) {
      return cached.window;
    }
  }
  const window = findLatestBoundaryMessageWindow(projection, generation, mode);
  cacheBoundaryMessageWindow(key, {
    generation,
    indexedSeq: projection.state.indexedSeq,
    window,
  });
  return window;
}

export function resolveVisibleMessagePositions(
  projection: ResetWindowProjection,
): VisibleMessagePositions {
  const window = resolveBoundaryMessageWindow(projection, "reset-only");
  return toVisibleMessagePositions(projection, window);
}

/**
 * Mirrors buildSessionContext's latest-boundary cut for consumers that need
 * model-visible messages rather than the transcript browser's reset-only view.
 */
export function resolveContextMessagePositions(
  projection: ResetWindowProjection,
): VisibleMessagePositions {
  const window = resolveBoundaryMessageWindow(projection, "context");
  return toVisibleMessagePositions(projection, window);
}

function toVisibleMessagePositions(
  projection: ResetWindowProjection,
  window: BoundaryMessageWindow | null,
): VisibleMessagePositions {
  if (!window) {
    return { kept: [], postStart: 0, total: projection.state.activeMessageCount };
  }
  return {
    kept: window.keptMessagePositions,
    postStart: window.postBoundaryMessagePosition,
    total:
      window.keptMessagePositions.length +
      Math.max(0, projection.state.activeMessageCount - window.postBoundaryMessagePosition),
  };
}

export function readVisibleMessageRange(
  projection: ResetWindowProjection,
  start: number,
  endExclusive: number,
): ResetWindowMessageEvent[] {
  if (endExclusive <= start) {
    return [];
  }
  const visible = resolveVisibleMessagePositions(projection);
  const boundedStart = Math.min(Math.max(0, start), visible.total);
  const boundedEnd = Math.min(Math.max(boundedStart, endExclusive), visible.total);
  if (boundedEnd <= boundedStart) {
    return [];
  }
  const keptEnd = Math.min(boundedEnd, visible.kept.length);
  const keptEvents = visible.kept
    .slice(boundedStart, keptEnd)
    .flatMap((position) => readMessageRange(projection, position, position + 1));
  const postVisibleStart = Math.max(boundedStart, visible.kept.length);
  const postVisibleEnd = Math.max(postVisibleStart, boundedEnd);
  const postEvents = readMessageRange(
    projection,
    visible.postStart + postVisibleStart - visible.kept.length,
    visible.postStart + postVisibleEnd - visible.kept.length,
  );
  return [...keptEvents, ...postEvents];
}

/** Maps a logical visible-message range to its materialized message positions. */
function resolveMessagePositionRange(
  projection: ResetWindowProjection,
  start: number,
  endExclusive: number,
  resolvePositions: (projection: ResetWindowProjection) => VisibleMessagePositions,
): number[] {
  if (endExclusive <= start) {
    return [];
  }
  const visible = resolvePositions(projection);
  const boundedStart = Math.min(Math.max(0, start), visible.total);
  const boundedEnd = Math.min(Math.max(boundedStart, endExclusive), visible.total);
  const keptEnd = Math.min(boundedEnd, visible.kept.length);
  const positions = visible.kept.slice(boundedStart, keptEnd);
  const postVisibleStart = Math.max(boundedStart, visible.kept.length);
  const postVisibleEnd = Math.max(postVisibleStart, boundedEnd);
  for (let logical = postVisibleStart; logical < postVisibleEnd; logical += 1) {
    positions.push(visible.postStart + logical - visible.kept.length);
  }
  return positions;
}

/** Maps a logical transcript-visible range to its materialized message positions. */
export function resolveVisibleMessagePositionRange(
  projection: ResetWindowProjection,
  start: number,
  endExclusive: number,
): number[] {
  return resolveMessagePositionRange(
    projection,
    start,
    endExclusive,
    resolveVisibleMessagePositions,
  );
}

/** Maps a logical model-context range to its materialized message positions. */
export function resolveContextMessagePositionRange(
  projection: ResetWindowProjection,
  start: number,
  endExclusive: number,
): number[] {
  return resolveMessagePositionRange(
    projection,
    start,
    endExclusive,
    resolveContextMessagePositions,
  );
}
