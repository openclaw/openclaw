import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import {
  getSqliteReadScopeRevision,
  readSqliteNativeMutationRevision,
} from "../../infra/sqlite-schema-facts.js";
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
import { selectSessionTranscriptIndexStatus } from "./session-transcript-index.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";

type TranscriptEntryRead = {
  database: Pick<OpenClawAgentDatabase, "db" | "path">;
  resolved: ResolvedTranscriptScope;
  entryId: string;
  message?: unknown;
};

function readActiveTranscriptEntryFacts(params: TranscriptEntryRead) {
  const db = getSessionKysely(params.database.db);
  return executeSqliteQueryTakeFirstSync(
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
      .leftJoin(
        selectSessionTranscriptIndexStatus(params.database.db, params.resolved.sessionId).as(
          "status",
        ),
        (join) => join.onTrue(),
      )
      .select([
        "identity.seq",
        "identity.parent_id",
        "identity.message_idempotency_key",
        "active.message_position",
        "rewrite.generation",
        "status.latestSeq",
      ])
      .where("identity.session_id", "=", params.resolved.sessionId)
      .where("identity.event_id", "=", params.entryId)
      // Branch changes retain old rows; readiness and the anchor share this statement's snapshot.
      .where("status.needs_reconcile", "is not", 1)
      .limit(1),
  );
}

/** Reads one active message identity from the caller's current SQLite transaction. */
export function readActiveTranscriptEntryAnchorInTransaction(
  params: TranscriptEntryRead,
): TranscriptEntryAnchor | undefined {
  return createTranscriptEntryAnchor({ ...params, row: readActiveTranscriptEntryFacts(params) });
}

/** The append receipt shares its anchor read with the subsequent visible-tail consumer. */
export function readTranscriptMessageAppendMetadataInTransaction(params: TranscriptEntryRead) {
  const revision = getSqliteReadScopeRevision(params.database.db)?.mutationRevision;
  const row = readActiveTranscriptEntryFacts(params);
  const anchor = createTranscriptEntryAnchor({ ...params, row });
  return {
    anchor,
    visibleTailEntryId:
      anchor &&
      row?.seq === row?.latestSeq &&
      revision !== undefined &&
      readSqliteNativeMutationRevision(params.database.db) === revision
        ? params.entryId
        : undefined,
  };
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
