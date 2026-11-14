// Indexed message-cut validation. Rewind and branch switch only need the target
// entry, its visible predecessor and the active leaf, so they read index seeks
// instead of hydrating the whole transcript into the SQLite worker heap.
import { randomUUID } from "node:crypto";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  getActiveTranscriptKysely,
  selectActiveTranscriptIdentityRows,
} from "./session-accessor.sqlite-projection-read.js";
import {
  reconcileSessionTranscriptIndexInTransaction,
  sessionTranscriptIndexNeedsReconcile,
} from "./session-transcript-index.js";
import { readTranscriptPayload } from "./transcript-payload.js";

export type SessionMessageCutTarget = {
  /** Parsed payload of the target row; the only event body this path reads. */
  event: Record<string, unknown> | undefined;
  eventType: string | null;
  /** Visible predecessor on the active path, or null at the root. */
  repointTargetId: string | null;
  onActivePath: boolean;
  seq: number;
};

export type SessionMessageCutReader = {
  /**
   * False when the active-path projection lags, so a read-only caller must
   * defer to the committing transaction instead of guessing the active branch.
   */
  activePathReady(): boolean;
  readTarget(entryId: string): SessionMessageCutTarget | undefined;
  /** True when no non-control event continues past this entry. */
  isBranchTip(entryId: string): boolean;
  activeLeafEventId(): string | null;
  /**
   * Logical owner of the existing transcript rows. An aliased store key owns its
   * transcript, so an in-place append must target that key, not the cut's target.
   */
  transcriptOwnerKey(): string | undefined;
  /** Physical append cursor: the newest identity row, which the leaf control chains onto. */
  tailEventId(): string | null;
  allocateEventId(): string;
};

/**
 * Builds the indexed reader for one session inside the caller's transaction.
 *
 * The active-path projection is this path's source of truth for "on the active
 * branch". A lagging projection is reconciled through its own owner, which
 * streams rows in SQL, rather than by hydrating events here.
 */
export function createSessionMessageCutReader(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  options: { reconcile?: boolean } = {},
): SessionMessageCutReader {
  let ready = true;
  if (options.reconcile === false) {
    ready = !sessionTranscriptIndexNeedsReconcile(database.db, sessionId);
  } else {
    reconcileSessionTranscriptIndexInTransaction(database.db, sessionId);
  }
  const db = getActiveTranscriptKysely(database);
  const readIdentity = (entryId: string) =>
    executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .leftJoin("session_transcript_active_events as active", (join) =>
          join
            .onRef("active.session_id", "=", "identity.session_id")
            .onRef("active.event_seq", "=", "identity.seq"),
        )
        .leftJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "identity.session_id")
            .onRef("event.seq", "=", "identity.seq"),
        )
        .select([
          "identity.event_type",
          "identity.parent_id",
          "identity.seq",
          "active.active_position",
          "event.event_json",
          "event.event_zstd",
          "event.event_utf8_bytes",
        ])
        .where("identity.session_id", "=", sessionId)
        .where("identity.event_id", "=", entryId),
    );
  const readActiveEventId = (eventId: string) =>
    executeSqliteQueryTakeFirstSync(
      database.db,
      selectActiveTranscriptIdentityRows(database)
        .select("identity.event_id")
        .where("identity.session_id", "=", sessionId)
        .where("identity.event_id", "=", eventId),
    )?.event_id ?? null;
  const readVisiblePredecessor = (activePosition: number) =>
    executeSqliteQueryTakeFirstSync(
      database.db,
      selectActiveTranscriptIdentityRows(database)
        .select("identity.event_id")
        .where("identity.session_id", "=", sessionId)
        .where("active.active_position", "<", activePosition)
        .where("identity.event_type", "is not", null)
        .where("identity.event_type", "<>", "leaf")
        .orderBy("active.active_position", "desc")
        .limit(1),
    )?.event_id ?? null;
  return {
    activePathReady: () => ready,
    readTarget(entryId) {
      const row = readIdentity(entryId);
      if (!row) {
        return undefined;
      }
      const onActivePath = row.active_position !== null;
      // The stored parent link is the tree parent for every append-written row.
      // Fall back to the active-path predecessor when normalization moved it.
      const parentId = row.parent_id;
      const repointTargetId =
        parentId === null
          ? null
          : (readActiveEventId(parentId) ??
            (onActivePath ? readVisiblePredecessor(row.active_position!) : null));
      return {
        event: asRecord(
          row.event_json === null && row.event_zstd === null
            ? undefined
            : (JSON.parse(readTranscriptPayload(row)) as TranscriptEvent),
        ),
        eventType: row.event_type,
        onActivePath,
        repointTargetId,
        seq: row.seq,
      };
    },
    isBranchTip(entryId) {
      // No (session_id, parent_id) index exists, so this narrows the session's
      // identity rows without decoding any event payload.
      return (
        executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("transcript_event_identities as child")
            .select("child.event_id")
            .where("child.session_id", "=", sessionId)
            .where("child.parent_id", "=", entryId)
            .where((eb) =>
              eb.or([eb("child.event_type", "is", null), eb("child.event_type", "<>", "leaf")]),
            )
            .limit(1),
        ) === undefined
      );
    },
    activeLeafEventId() {
      return (
        executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("session_transcript_index_state")
            .select("leaf_event_id")
            .where("session_id", "=", sessionId),
        )?.leaf_event_id ?? null
      );
    },
    transcriptOwnerKey() {
      return executeSqliteQueryTakeFirstSync(
        database.db,
        db.selectFrom("session_windows").select("session_key").where("session_id", "=", sessionId),
      )?.session_key;
    },
    tailEventId() {
      return (
        executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("transcript_event_identities")
            .select("event_id")
            .where("session_id", "=", sessionId)
            .orderBy("seq", "desc")
            .limit(1),
        )?.event_id ?? null
      );
    },
    allocateEventId() {
      for (;;) {
        const candidate = randomUUID().slice(0, 8);
        if (readIdentity(candidate) === undefined) {
          return candidate;
        }
      }
    },
  };
}
