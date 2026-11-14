// Bounded active-path repoint for the transcript index owner.
//
// A rewind or branch switch appends one `leaf` control and moves the active
// branch. Rebuilding the projection from every event would make the next
// `chat.history` wait for `needs_rebuild`, so this plans the exact row
// difference instead: the removed suffix after the common ancestor, plus the
// selected branch back to it. Cost follows the divergence, not transcript size.
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  replaceSessionTranscriptIndexSuffixInTransaction,
  selectSessionTranscriptProjectionState,
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
} from "./session-transcript-projection-facts-columns.js";
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
 * Returns undefined when the projection cannot serve as the baseline (missing,
 * lagging or unclassified) or when the divergence exceeds its bound; the caller
 * then leaves reconciliation to the existing owner.
 */
export function prepareSessionTranscriptActivePathRepoint(
  db: EngineConnection,
  sessionId: string,
  leafEventId: string | null,
): SessionTranscriptActivePathRepoint | undefined {
  const state = executeSqliteQueryTakeFirstSync(
    db,
    selectSessionTranscriptProjectionState(db, sessionId),
  );
  if (!state || state.needs_rebuild !== 0 || state.has_unclassified) {
    return undefined;
  }
  const db2 = kysely(db);
  const readNode = (eventId: string) =>
    executeSqliteQueryTakeFirstSync(
      db,
      db2
        .selectFrom("transcript_event_identities as identity")
        .leftJoin("session_transcript_active_events as active", (join) =>
          join
            .onRef("active.session_id", "=", "identity.session_id")
            .onRef("active.event_seq", "=", "identity.seq"),
        )
        .select(["identity.seq", "identity.parent_id", "active.active_position"])
        .where("identity.session_id", "=", sessionId)
        .where("identity.event_id", "=", eventId),
    );
  const branchSeqs: number[] = [];
  let commonPosition = -1;
  let cursor = leafEventId;
  while (cursor !== null) {
    const node = readNode(cursor);
    if (!node) {
      return undefined;
    }
    if (node.active_position !== null) {
      commonPosition = node.active_position;
      break;
    }
    if (branchSeqs.length >= MAX_REPOINT_BRANCH_EVENTS) {
      return undefined;
    }
    branchSeqs.push(node.seq);
    cursor = node.parent_id;
  }
  branchSeqs.reverse();
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
    const rows = executeSqliteQuerySync(
      db,
      kysely(db)
        .selectFrom("transcript_events")
        .select([transcriptEventJsonSql(db).as("event_json"), "seq", "created_at"])
        .select(projectionFactsColumns(db))
        .where("session_id", "=", sessionId)
        .where("seq", "in", plan.branchSeqs)
        .orderBy("seq", "asc"),
    ).rows;
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
