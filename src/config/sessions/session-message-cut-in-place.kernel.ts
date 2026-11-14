// In-place rewind and branch switch, inside the agent database worker.
//
// Rewind and branch switch only need the target entry, its visible predecessor
// and the active leaf, so this reads index seeks instead of hydrating the whole
// transcript into the worker heap, then appends one `leaf` control row.
import { randomUUID } from "node:crypto";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { SqliteJsonlReadBudgetExceededError } from "../../infra/sqlite-jsonl-budget-error.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { scanSessionTranscriptNavigationTree } from "./session-accessor.sqlite-branch-summaries.js";
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
import { SESSION_MESSAGE_CUT_MAX_BYTES } from "./session-message-cut-read.js";
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
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { readTranscriptPayload, transcriptPredicateSql } from "./transcript-payload.js";
import {
  selectSessionTranscriptTreePathNodes,
  selectSessionTranscriptTreeTipNodes,
} from "./transcript-tree.js";
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
  // One canonical navigation scan per cut, with the planned `leaf` control
  // included, shared by the tip decision, the selection check and the repoint's
  // path. Only paid when one of them needs it, so an ordinary rewind (whose
  // predecessor is already active, with no later reset) never builds it.
  let scanned:
    | {
        targetId: string | null;
        tree: ReturnType<typeof scanSessionTranscriptNavigationTree>["tree"];
      }
    | undefined;
  const resolve = (targetId: string | null) => {
    if (!scanned || scanned.targetId !== targetId) {
      const control = { type: "leaf", id: controlEventId(), parentId: tailEventId(), targetId };
      scanned = {
        targetId,
        tree: scanSessionTranscriptNavigationTree(database, sessionId, [control]).tree,
      };
    }
    return scanned.tree;
  };
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
  const activeLeafEventId = () =>
    executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_transcript_index_state")
        .select("leaf_event_id")
        .where("session_id", "=", sessionId),
    )?.leaf_event_id ?? null;
  const tailEventId = () =>
    executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("transcript_event_identities")
        .select("event_id")
        .where("session_id", "=", sessionId)
        .orderBy("seq", "desc")
        .limit(1),
    )?.event_id ?? null;
  // The planned control's identity is allocated once, so the resolved tree below
  // and the appended row are the same node.
  let controlId: string | undefined;
  const controlEventId = () => {
    for (; controlId === undefined;) {
      const candidate = randomUUID().slice(0, 8);
      if (readIdentity(candidate) === undefined) {
        controlId = candidate;
      }
    }
    return controlId;
  };
  /**
   * A `reset` after the selection re-roots the scanner's navigation, so the
   * planned control can be normalized onto the current leaf instead of the
   * requested target. This index seek keeps ordinary cuts off the scan.
   */
  const hasResetAfterSelection = (targetId: string | null) => {
    const targetSeq = targetId === null ? -1 : (readIdentity(targetId)?.seq ?? -1);
    return (
      executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("transcript_event_identities")
          .select("event_id")
          .where("session_id", "=", sessionId)
          .where("event_type", "=", "reset")
          .where("seq", ">", targetSeq)
          .limit(1),
      ) !== undefined
    );
  };
  /**
   * Identity, predecessor and tip lookups read navigation and projection columns
   * only. A stored event can be arbitrarily large, and a branch switch never needs
   * its body, so no payload is selected or decoded here: the message role comes
   * from the same navigation predicate history visibility uses, and the stored
   * byte count is carried for the budget check the editor read makes later.
   */
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
        ])
        .select(transcriptPredicateSql(database.db, "message_role", "event").as("message_role"))
        .select(transcriptEventReadBytesSql("event").as("payload_bytes"))
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
        eventType: row.event_type,
        messageRole: row.message_role,
        onActivePath: row.active_position !== null,
        repointTargetId:
          row.active_position === null ? null : readActivePredecessorId(row.active_position),
      };
    },
    readEditorMessage(entryId) {
      // The one payload an in-place cut reads, after the selection is validated:
      // the rewind's editor text and attachments. Oversized rows are refused with
      // the shared read-budget error instead of entering the worker heap.
      const row = readIdentity(entryId);
      if (!row) {
        return undefined;
      }
      if ((row.payload_bytes ?? 0) > SESSION_MESSAGE_CUT_MAX_BYTES) {
        throw new SqliteJsonlReadBudgetExceededError(
          `Session history editor content exceeds its ${SESSION_MESSAGE_CUT_MAX_BYTES}-byte read budget; export the transcript to inspect it without changing this session.`,
        );
      }
      const payload = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select(["event_json", "event_zstd", "event_utf8_bytes"])
          .where("session_id", "=", sessionId)
          .where("seq", "=", row.seq),
      );
      const event =
        payload && (payload.event_json !== null || payload.event_zstd !== null)
          ? asRecord(JSON.parse(readTranscriptPayload(payload)))
          : undefined;
      return asRecord(event?.message);
    },
    isBranchTip(entryId) {
      // Raw child links are not canonical, and a tip the canonical owner cannot
      // select is not offerable: resolving the planned control answers both. Tips
      // are listed against the pre-cut leaf, because this tree already contains
      // the control that would move it.
      const tree = resolve(entryId);
      return (
        tree.leafId === entryId &&
        selectSessionTranscriptTreeTipNodes(tree, activeLeafEventId()).some(
          (tip) => tip.id === entryId,
        )
      );
    },
    canonicalSelectionHolds(targetId) {
      // A reset after the selection is the only normalization that can move the
      // planned control's target, so an ordinary cut answers without the scan.
      return !hasResetAfterSelection(targetId) || resolve(targetId).leafId === targetId;
    },
    canonicalBranchPathSeqs(leafEventId) {
      return selectSessionTranscriptTreePathNodes(resolve(leafEventId), leafEventId).flatMap(
        (node) => (typeof node.entry?.seq === "number" ? [node.entry.seq] : []),
      );
    },
    activeLeafEventId,
    tailEventId,
    allocateEventId: controlEventId,
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
  // One reader per cut: its canonical navigation scan, when a switch needs it, is
  // shared by the tip decision and the repoint's path.
  const reader = createSessionMessageCutReader(database, sessionId);
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
    (leafEventId) => reader.canonicalBranchPathSeqs?.(leafEventId),
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
