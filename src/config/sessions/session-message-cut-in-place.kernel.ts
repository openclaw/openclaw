// In-place rewind and branch switch, inside the agent database worker.
//
// Rewind and branch switch only need the target entry, its visible predecessor
// and the active leaf, so this reads index seeks instead of hydrating the whole
// transcript into the worker heap, then appends one `leaf` control row.
import { randomUUID } from "node:crypto";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { commitSqliteSessionDeletion } from "./session-accessor.sqlite-deletion.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { getActiveTranscriptKysely } from "./session-accessor.sqlite-projection-read.js";
import { getSessionKysely, type ResolvedSqliteScope } from "./session-accessor.sqlite-scope.js";
import {
  readNextTranscriptSeq,
  rotateTranscriptGenerationInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import {
  planInPlaceSessionMessageCut,
  type SessionMessageCutReader,
} from "./session-message-cut-plan.js";
import type {
  SessionMessageCutIntent,
  SessionMessageCutResult,
} from "./session-message-cut.types.js";
import {
  applySessionTranscriptActivePathRepoint,
  prepareSessionTranscriptActivePathRepoint,
} from "./session-transcript-active-path-repoint.js";
import {
  reconcileSessionTranscriptIndexInTransaction,
  sessionTranscriptIndexNeedsReconcile,
} from "./session-transcript-index.js";
import { readTranscriptPayload } from "./transcript-payload.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type MessageCutProjection = {
  scheduleProjectionReconcile?: boolean;
  onProjectionReconcileNeeded?: () => void;
  sourceRepositoryWorkspaceId?: string;
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
): SessionMessageCutReader | undefined {
  if (options.reconcile === false) {
    // A read-only caller cannot reconcile, so a lagging projection has no
    // trustworthy active path and the caller must defer to the committing write.
    if (sessionTranscriptIndexNeedsReconcile(database.db, sessionId)) {
      return undefined;
    }
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
  return {
    readTarget(entryId) {
      const row = readIdentity(entryId);
      if (!row) {
        return undefined;
      }
      return {
        event: asRecord(
          row.event_json === null && row.event_zstd === null
            ? undefined
            : JSON.parse(readTranscriptPayload(row)),
        ),
        eventType: row.event_type,
        onActivePath: row.active_position !== null,
        // Appends chain onto the active tip, so a target on the active path has
        // its stored parent on that path too.
        repointTargetId: row.parent_id,
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

/**
 * Best-effort semantic precheck before a local workspace is retired.
 *
 * Reads are indexed and read-only, so a lagging active-path projection defers
 * to the committing transaction, which owns reconciliation and revalidation.
 */
export function refuseInPlaceSessionMessageCutInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  entry: SessionEntry,
  intent: SessionMessageCutIntent & { mode: "rewind" | "switch" },
  sourceRepositoryWorkspaceId?: string,
): Exclude<SessionMessageCutResult, { status: "created" }> | undefined {
  const reader = createSessionMessageCutReader(database, sessionId, { reconcile: false });
  if (!reader) {
    return undefined;
  }
  const plan = planInPlaceSessionMessageCut(entry, reader, intent, sourceRepositoryWorkspaceId);
  return plan.status === "prepared" ? undefined : plan;
}

/**
 * Rewind and branch switch append one `leaf` control row to the existing
 * transcript, so their cost does not depend on transcript size.
 *
 * Consumers that previously detected the cut through a new session id now see
 * the rotated transcript generation, and stale writers that captured the
 * pre-cut rows fail their own compare-and-swap against the bumped mutation
 * watermark.
 */
export function installInPlaceSessionMessageCut(
  database: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  params: SessionMessageCutIntent & { mode: "rewind" | "switch" },
  currentEntry: SessionEntry | undefined,
  projection?: MessageCutProjection,
): SessionMessageCutResult {
  if (!currentEntry?.sessionId) {
    return { status: "missing-session" };
  }
  const sessionId = currentEntry.sessionId;
  const reader = createSessionMessageCutReader(database, sessionId);
  if (!reader) {
    throw new Error(`Session transcript projection is unavailable for ${sessionId}`);
  }
  const plan = planInPlaceSessionMessageCut(
    currentEntry,
    reader,
    params,
    projection?.sourceRepositoryWorkspaceId,
  );
  if (plan.status !== "prepared") {
    return plan;
  }
  commitSqliteSessionDeletion(params.sourceKey, currentEntry);
  rotateTranscriptGenerationInTransaction(database, sessionId);
  // Plan the projection difference against the still-clean projection; the append
  // below marks it dirty, and the repoint publishes the exact replacement rows.
  const repoint = prepareSessionTranscriptActivePathRepoint(
    database.db,
    sessionId,
    plan.leafTargetId,
  );
  const appended = appendTranscriptEventsInTransaction(
    database,
    // An aliased store key owns its transcript rows, so the append must target
    // the persisted owner, not the cut's target key.
    {
      ...resolved,
      sessionId,
      sessionKey: readTranscriptOwnerSessionKey(database, sessionId) ?? params.targetKey,
    },
    [plan.leafEvent],
    projection,
  );
  if (repoint && appended > 0) {
    applySessionTranscriptActivePathRepoint(
      database.db,
      sessionId,
      repoint,
      readNextTranscriptSeq(database, sessionId) - 1,
    );
  } else {
    // The projection was already lagging, or the divergence exceeded its bound.
    // Its reconcile owner publishes the result, as it does for any dirty session.
    projection?.onProjectionReconcileNeeded?.();
  }
  writeSessionEntry(database, params.targetKey, plan.result.entry);
  return plan.result;
}

/** Logical owner of the existing transcript rows, which may be an aliased key. */
function readTranscriptOwnerSessionKey(
  database: OpenClawAgentDatabase,
  sessionId: string,
): string | undefined {
  return executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_windows")
      .select("session_key")
      .where("session_id", "=", sessionId),
  )?.session_key;
}
