// Indexed message-cut validation. Rewind and branch switch only need the target
// entry, its visible predecessor and the active leaf, so they read index seeks
// instead of hydrating the whole transcript into the SQLite worker heap.
import { randomUUID } from "node:crypto";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { getActiveTranscriptKysely } from "./session-accessor.sqlite-projection-read.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope } from "./session-accessor.types.js";
import { planInPlaceSessionMessageCut } from "./session-message-cut-plan.js";
import type {
  SessionMessageCutIntent,
  SessionMessageCutResult,
} from "./session-message-cut.types.js";
import {
  reconcileSessionTranscriptIndexInTransaction,
  sessionTranscriptIndexNeedsReconcile,
} from "./session-transcript-index.js";
import { readTranscriptPayload } from "./transcript-payload.js";
import {
  isSessionTranscriptLeafControl,
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
  selectSessionTranscriptTreeTipNodes,
} from "./transcript-tree.js";
import type { InternalSessionEntry } from "./types.js";

export type SessionMessageCutTarget = {
  /** Parsed payload of the target row; the only event body this path reads. */
  event: Record<string, unknown> | undefined;
  eventType: string | null;
  /** Visible predecessor on the active path, or null at the root. */
  repointTargetId: string | null;
  onActivePath: boolean;
};

export type SessionMessageCutReader = {
  readTarget(entryId: string): SessionMessageCutTarget | undefined;
  /** True when no non-control event continues past this entry. */
  isBranchTip(entryId: string): boolean;
  activeLeafEventId(): string | null;
  /** Physical append cursor: the newest identity row, which the leaf control chains onto. */
  tailEventId(): string | null;
  allocateEventId(): string;
};

/**
 * Reader for a memory-resident transcript, where the whole event list is already
 * in the actor's working state and the navigation tree is the only index.
 */
export function createMemorySessionMessageCutReader(
  events: readonly unknown[],
): SessionMessageCutReader {
  const tree = scanSessionTranscriptTree(events);
  const activeIds = new Set(
    selectSessionTranscriptTreePathNodes(tree, tree.leafId).map((node) => node.id),
  );
  return {
    readTarget(entryId) {
      const node = tree.byId.get(entryId);
      if (!node) {
        return undefined;
      }
      const record = asRecord(node.entry);
      return {
        event: record,
        eventType: typeof record?.type === "string" ? record.type : null,
        onActivePath: activeIds.has(entryId),
        repointTargetId: node.parentId,
      };
    },
    isBranchTip(entryId) {
      const node = tree.byId.get(entryId);
      return (
        node !== undefined &&
        !isSessionTranscriptLeafControl(node.entry) &&
        selectSessionTranscriptTreeTipNodes(tree).some((tip) => tip.id === entryId)
      );
    },
    activeLeafEventId: () => tree.leafId,
    tailEventId: () => tree.nodes.at(-1)?.id ?? null,
    allocateEventId() {
      for (;;) {
        const candidate = randomUUID().slice(0, 8);
        if (!tree.byId.has(candidate)) {
          return candidate;
        }
      }
    },
  };
}

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
            : (JSON.parse(readTranscriptPayload(row)) as TranscriptEvent),
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
export function refuseInPlaceSessionMessageCut(
  scope: SessionAccessScope & { agentId: string; sessionId: string },
  entry: InternalSessionEntry,
  intent: SessionMessageCutIntent & { mode: "rewind" | "switch" },
  sourceRepositoryWorkspaceId?: string,
): Exclude<SessionMessageCutResult, { status: "created" }> | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const reader = createSessionMessageCutReader(database, resolved.sessionId, {
      reconcile: false,
    });
    if (!reader) {
      return undefined;
    }
    const plan = planInPlaceSessionMessageCut(entry, reader, intent, sourceRepositoryWorkspaceId);
    return plan.status === "prepared" ? undefined : plan;
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : undefined;
}
