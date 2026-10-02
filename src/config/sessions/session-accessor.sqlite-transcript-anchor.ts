import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { resolveTranscriptCanonicalCurrentTurnEntryIdInTransaction } from "./session-accessor.sqlite-transcript-parent.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";

/** Reads one active message identity from the caller's current SQLite transaction. */
export function readActiveTranscriptEntryAnchorInTransaction(params: {
  database: Pick<OpenClawAgentDatabase, "db" | "path">;
  resolved: ResolvedTranscriptScope;
  entryId: string;
  message?: unknown;
}): TranscriptEntryAnchor | undefined {
  // Branch changes retain old projection rows until deferred reconciliation.
  // An anchor must never certify those rows as the current active path.
  if (sessionTranscriptIndexNeedsReconcile(params.database.db, params.resolved.sessionId)) {
    return undefined;
  }
  const db = getSessionKysely(params.database.db);
  const row = executeSqliteQueryTakeFirstSync(
    params.database.db,
    db
      .selectFrom("transcript_event_identities as identity")
      .innerJoin("session_transcript_active_events as active", (join) =>
        join
          .onRef("active.session_id", "=", "identity.session_id")
          .onRef("active.event_seq", "=", "identity.seq"),
      )
      .innerJoin("transcript_rewrite_watermarks as rewrite", (join) =>
        join.onRef("rewrite.session_id", "=", "identity.session_id"),
      )
      .select([
        "identity.seq",
        "identity.parent_id",
        "identity.message_idempotency_key",
        "active.message_position",
        "rewrite.generation",
      ])
      .where("identity.session_id", "=", params.resolved.sessionId)
      .where("identity.event_id", "=", params.entryId)
      .limit(1),
  );
  return createTranscriptEntryAnchor({ ...params, row });
}

/** Projects anchor fields after the caller verifies readiness in the same snapshot. */
export function createTranscriptEntryAnchor(params: {
  database: Pick<OpenClawAgentDatabase, "path">;
  resolved: ResolvedTranscriptScope;
  entryId: string;
  message?: unknown;
  row:
    | {
        seq: number;
        parent_id: string | null;
        message_idempotency_key: string | null;
        message_position: number | null;
        generation: string | null;
      }
    | undefined;
}): TranscriptEntryAnchor | undefined {
  const { row } = params;
  if (
    row?.message_position === null ||
    row?.message_position === undefined ||
    row.generation === null
  ) {
    return undefined;
  }
  const idempotencyKey = row.message_idempotency_key ?? readMessageIdempotencyKey(params.message);
  return Object.freeze({
    agentId: params.resolved.agentId,
    sessionId: params.resolved.sessionId,
    sessionKey: params.resolved.sessionKey,
    storePath: params.database.path,
    generation: row.generation,
    entryId: params.entryId,
    rawSeq: row.seq,
    effectiveParentId: row.parent_id,
    activeMessagePosition: row.message_position,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

/** Reads one active message identity from the authoritative SQLite projection. */
export function readActiveTranscriptEntryAnchor(params: {
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  storePath?: string;
  entryId: string;
}): TranscriptEntryAnchor | undefined {
  const resolved = resolveSqliteTranscriptScope(params);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readActiveTranscriptEntryAnchorInTransaction({
    database,
    resolved,
    entryId: params.entryId,
  });
}

/** Result of an anchor read together with the index state observed in one snapshot. */
export interface ActiveTranscriptAnchorRead {
  /** The active anchor, or undefined when the projection is dirty or has no active row. */
  anchor: TranscriptEntryAnchor | undefined;
  /**
   * True when the projection index was transiently dirty (needs reconciliation) at read time,
   * so the anchor was short-circuited -- as opposed to a clean index that genuinely has no
   * active row for the cached entry.
   */
  indexDirty: boolean;
  /**
   * True only when indexDirty is set AND the cached entry IS the canonical current turn
   * resolved from the durable event tree (the manager's current-turn walk, not merely
   * visible-path membership). A branch switch, alternative-parent rewrite, completed turn, or
   * suffix remove makes the current turn a different id, so during a dirty projection we
   * revalidate against the durable current-turn walk instead of trusting the stale watermark
   * -- a displaced/completed/deleted turn must not be false-acked.
   */
  cachedIdentityExists: boolean;
}

/**
 * Reads the active anchor together with the reconcile state against ONE opened database
 * snapshot (a single deferred, savepoint-aware transaction). This distinguishes a transiently
 * dirty index (benign duplicate during the reconcile window) from a clean index whose active
 * projection lacks the cached entry, and -- while dirty -- revalidates the cached turn against
 * the canonical visible active path resolved from the durable event tree (the same owner the
 * projection rebuild uses), so a branched-away / rewritten / deleted turn still rejects.
 */
export function readActiveTranscriptEntryAnchorStatus(params: {
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  storePath?: string;
  entryId: string;
}): ActiveTranscriptAnchorRead {
  const resolved = resolveSqliteTranscriptScope(params);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = database.db;
  // One nested-safe deferred snapshot (savepoint-aware: it joins an enclosing write
  // transaction via a savepoint instead of throwing "cannot start a transaction within a
  // transaction"). Within it we read reconcile state AND (when clean) the canonical active
  // anchor through the same owner, so a between-read writer cannot change the verdict.
  return runSqliteDeferredTransactionSync(db, () => {
    const indexDirty = sessionTranscriptIndexNeedsReconcile(db, resolved.sessionId);
    if (!indexDirty) {
      // Clean index: reuse the single canonical anchor-join owner (identities ⨝ active ⨝
      // rewrite). The cached turn is active iff it has an active row; otherwise it is a
      // clean-missing/stale turn -> reject.
      const anchor = readActiveTranscriptEntryAnchorInTransaction({
        database,
        resolved,
        entryId: params.entryId,
      });
      return { anchor, indexDirty: false, cachedIdentityExists: Boolean(anchor) };
    }
    // Dirty index: the materialized active projection may be stale (a leaf-control /
    // branch-switch / alternative-parent write preserves the old watermark and skips forward
    // indexing). Do NOT trust the dirty projection, do NOT accept visible-path membership, and
    // do NOT walk the raw parent chain from the tail. Resolve the canonical current turn from the
    // durable tree with the SAME walk the manager uses (walk up from the append cursor, skipping
    // traversable metadata; the first non-traversable row is the current turn). Degrade only
    // when the cached entry IS that current turn. A completed / branched-away / rewritten /
    // deleted turn is a different id -> reject (fail-closed), never false-ack.
    const canonicalCurrentTurnId = resolveTranscriptCanonicalCurrentTurnEntryIdInTransaction(
      database,
      resolved.sessionId,
    );
    return {
      anchor: undefined,
      indexDirty: true,
      cachedIdentityExists: canonicalCurrentTurnId === params.entryId,
    };
  });
}
