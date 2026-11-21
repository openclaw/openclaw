// Bounded active-path repoint for the transcript index owner.
//
// A rewind or branch switch appends one `leaf` control and moves the active
// branch. Rebuilding the projection from every event would make the next
// `chat.history` wait for `needs_rebuild`, so this plans the exact row
// difference instead: the removed suffix after the common ancestor, plus the
// selected branch back to it. Cost follows the divergence, not transcript size.
//
// Ancestry is never derived from raw `parentId` links here. The selected
// branch's path comes from the canonical navigation owner
// (`scanSessionTranscriptNavigationTree`), the same scan branch listing uses, so
// a published projection always matches what a full rebuild would produce.
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  replaceSessionTranscriptIndexSuffixInTransaction,
  selectSessionTranscriptProjectionState,
  SYNC_REBUILD_MAX_BYTES,
  type SessionTranscriptIndexProjection,
} from "./session-transcript-index.js";
import {
  extractTranscriptIndexEntry,
  hasTranscriptMessage,
  shouldProjectActiveEvent,
  transcriptEventContextEligibility,
} from "./session-transcript-projection-append.js";
import {
  projectionFactsColumns,
  projectionRowFacts,
} from "./session-transcript-projection-rebuild.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

type RepointDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_transcript_active_events"
  | "session_transcript_index_state"
  | "transcript_event_identities"
  | "transcript_events"
>;

/**
 * Divergence cap. Beyond it the ordinary reconcile owner is cheaper than
 * planning every differing row, and the caller falls back to it.
 *
 * Rows alone do not bound memory: the selected branch's payloads are hydrated
 * inside this transaction to derive their projection facts, so the plan also
 * refuses a branch whose retained bytes exceed the projection owner's existing
 * synchronous budget. The reconcile owner streams anything larger.
 */
const MAX_REPOINT_BRANCH_EVENTS = 4_000;

export type SessionTranscriptActivePathRepoint = {
  /** Active rows kept from the current projection, counted from position zero. */
  retainedActiveCount: number;
  retainedActiveMessageCount: number;
  removedMessageIds: string[];
  /** Physical sequences of the selected branch below the common ancestor. */
  branchSeqs: number[];
  leafEventId: string | null;
};

function kysely(db: EngineConnection) {
  return getNodeSqliteKysely<RepointDatabase>(db);
}

/**
 * Plans the repoint against the current, clean projection.
 *
 * `readCanonicalPath` is consulted only when the selected leaf is not already on
 * the active path; a rewind therefore costs no navigation scan. Returns
 * undefined when the projection cannot serve as the baseline (missing, lagging
 * or unclassified), when the canonical path is unavailable, or when the
 * divergence exceeds its bounds; the caller then leaves reconciliation to the
 * existing owner.
 */
export function prepareSessionTranscriptActivePathRepoint(
  db: EngineConnection,
  sessionId: string,
  leafEventId: string | null,
  readCanonicalPath: (leafEventId: string) => readonly number[] | undefined,
): SessionTranscriptActivePathRepoint | undefined {
  const state = executeSqliteQueryTakeFirstSync(
    db,
    selectSessionTranscriptProjectionState(db, sessionId),
  );
  if (!state || state.needs_rebuild !== 0 || state.has_unclassified) {
    return undefined;
  }
  const db2 = kysely(db);
  const readActivePosition = (eventSeq: number) =>
    executeSqliteQueryTakeFirstSync(
      db,
      db2
        .selectFrom("session_transcript_active_events")
        .select("active_position")
        .where("session_id", "=", sessionId)
        .where("event_seq", "=", eventSeq),
    )?.active_position ?? null;
  const readLeafSeq = (eventId: string) =>
    executeSqliteQueryTakeFirstSync(
      db,
      db2
        .selectFrom("transcript_event_identities")
        .select("seq")
        .where("session_id", "=", sessionId)
        .where("event_id", "=", eventId),
    )?.seq;
  const branchSeqs: number[] = [];
  let commonPosition = -1;
  if (leafEventId !== null) {
    const leafSeq = readLeafSeq(leafEventId);
    if (leafSeq === undefined) {
      return undefined;
    }
    const leafPosition = readActivePosition(leafSeq);
    if (leafPosition !== null) {
      // A rewind selects a predecessor that is already active: no divergence.
      commonPosition = leafPosition;
    } else {
      const path = readCanonicalPath(leafEventId);
      // An empty canonical path for a named leaf means the scanner rejected it
      // (missing ancestor or cycle); only its own owner may publish that.
      if (!path || path.length === 0) {
        return undefined;
      }
      for (let index = path.length - 1; index >= 0; index -= 1) {
        const position = readActivePosition(path[index]!);
        if (position !== null) {
          commonPosition = position;
          break;
        }
        if (branchSeqs.length >= MAX_REPOINT_BRANCH_EVENTS) {
          return undefined;
        }
        branchSeqs.push(path[index]!);
      }
      branchSeqs.reverse();
    }
  }
  if (branchSeqs.length > 0) {
    const bytes = executeSqliteQueryTakeFirstSync(
      db,
      db2
        .selectFrom("transcript_events")
        .select((eb) => eb.fn.sum<number>(transcriptEventReadBytesSql()).as("branch_bytes"))
        .where("session_id", "=", sessionId)
        .where("seq", "in", branchSeqs),
    )?.branch_bytes;
    if ((bytes ?? 0) > SYNC_REBUILD_MAX_BYTES) {
      return undefined;
    }
  }
  const retainedActiveCount = commonPosition + 1;
  const retained = executeSqliteQueryTakeFirstSync(
    db,
    db2
      .selectFrom("session_transcript_active_events")
      .select((eb) => eb.fn.countAll<number>().as("messages"))
      .where("session_id", "=", sessionId)
      .where("active_position", "<", retainedActiveCount)
      .where("message_position", "is not", null),
  );
  const removedMessageIds = executeSqliteQuerySync(
    db,
    db2
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_event_identities as identity", (join) =>
        join
          .onRef("identity.session_id", "=", "active.session_id")
          .onRef("identity.seq", "=", "active.event_seq"),
      )
      .select("identity.event_id")
      .where("active.session_id", "=", sessionId)
      .where("active.active_position", ">=", retainedActiveCount)
      .where("active.message_position", "is not", null),
  ).rows.map((row) => row.event_id);
  return {
    retainedActiveCount,
    retainedActiveMessageCount: retained?.messages ?? 0,
    removedMessageIds,
    branchSeqs,
    leafEventId,
  };
}

/** Applies a prepared repoint; `indexedSeq` is the transcript's newest sequence. */
export function applySessionTranscriptActivePathRepoint(
  db: EngineConnection,
  sessionId: string,
  plan: SessionTranscriptActivePathRepoint,
  indexedSeq: number,
): void {
  const activeRows: SessionTranscriptIndexProjection["activeRows"] = [];
  let activePosition = plan.retainedActiveCount;
  let messagePosition = plan.retainedActiveMessageCount;
  if (plan.branchSeqs.length > 0) {
    // Stream the selected payloads: each row's facts are derived and the decoded
    // payload is released before the next row is read. The plan's byte bound caps
    // what the derived rows retain.
    const rows = iterateSqliteQuerySync(
      db,
      kysely(db)
        .selectFrom("transcript_events")
        .select([transcriptEventJsonSql(db).as("event_json"), "seq", "created_at"])
        .select(projectionFactsColumns(db))
        .where("session_id", "=", sessionId)
        .where("seq", "in", plan.branchSeqs)
        .orderBy("seq", "asc"),
    );
    for (const row of rows) {
      const event: unknown = JSON.parse(row.event_json);
      const ftsEntry = extractTranscriptIndexEntry(event, row.created_at);
      if (!shouldProjectActiveEvent(event)) {
        continue;
      }
      const contextEligible = transcriptEventContextEligibility(event);
      activeRows.push({
        activePosition: activePosition++,
        contextEligible,
        eventSeq: row.seq,
        facts: projectionRowFacts(row, contextEligible),
        messagePosition: hasTranscriptMessage(event) ? messagePosition++ : null,
        ...(ftsEntry ? { ftsEntry } : {}),
      });
    }
  }
  replaceSessionTranscriptIndexSuffixInTransaction(db, sessionId, {
    unchangedBeforeSeq: 0,
    retainedActiveCount: plan.retainedActiveCount,
    removedMessageIds: plan.removedMessageIds,
    next: {
      activeRows,
      activeMessageCount: messagePosition,
      indexedSeq,
      leafEventId: plan.leafEventId,
    },
  });
}
