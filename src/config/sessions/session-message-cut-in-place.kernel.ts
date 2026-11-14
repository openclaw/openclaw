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
 * streams rows in SQL, rather than by hydrating events here, so every reader
 * this returns answers from a current projection.
 */
export function createSessionMessageCutReader(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
): SessionMessageCutReader {
  reconcileSessionTranscriptIndexInTransaction(database.db, sessionId);
  const db = getActiveTranscriptKysely(database);
  // The active projection is the canonical path owner: it is built by the
  // transcript tree scan, which normalizes parentless continuations, leaf
  // references and reset boundaries. Its order, not the raw payload parent,
  // answers "what precedes this entry".
  const readActivePredecessorId = (activePosition: number) =>
    activePosition <= 0
      ? null
      : (executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("session_transcript_active_events as active")
            .innerJoin("transcript_event_identities as identity", (join) =>
              join
                .onRef("identity.session_id", "=", "active.session_id")
                .onRef("identity.seq", "=", "active.event_seq"),
            )
            .select("identity.event_id")
            .where("active.session_id", "=", sessionId)
            .where("active.active_position", "=", activePosition - 1),
        )?.event_id ?? null);
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
        repointTargetId:
          row.active_position === null ? null : readActivePredecessorId(row.active_position),
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
 * Semantic precheck before a local workspace is retired.
 *
 * An invalid history selection must leave the retained runtime and its workspace
 * edits untouched (#190219), so this answer has to be trustworthy: the caller
 * runs it inside a write transaction whenever the active-path projection lags,
 * and the reader reconciles that projection through its owner before reading.
 */
export function refuseInPlaceSessionMessageCutInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  entry: SessionEntry,
  intent: SessionMessageCutIntent & { mode: "rewind" | "switch" },
  sourceRepositoryWorkspaceId?: string,
): Exclude<SessionMessageCutResult, { status: "created" }> | undefined {
  const plan = planInPlaceSessionMessageCut(
    entry,
    createSessionMessageCutReader(database, sessionId),
    intent,
    sourceRepositoryWorkspaceId,
  );
  return plan.status === "prepared" ? undefined : plan;
}

/** True when the precheck above needs its own write transaction to stay trustworthy. */
export function inPlaceSessionMessageCutPreflightNeedsWrite(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
): boolean {
  return sessionTranscriptIndexNeedsReconcile(database.db, sessionId);
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
  const plan = planInPlaceSessionMessageCut(
    currentEntry,
    createSessionMessageCutReader(database, sessionId),
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
