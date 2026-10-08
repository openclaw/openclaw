import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
  type ResolvedTranscriptReadScope,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import { canonicalSessionValidationQuery } from "./session-canonical-key.js";
import { validateCanonicalSessionRowEntry } from "./session-canonical-row.js";
import { selectSessionTranscriptIndexStatus } from "./session-transcript-index.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import type { InternalSessionEntry } from "./types.js";

export type TranscriptSourceAuthority = Pick<
  InternalSessionEntry,
  "permissionMode" | "lifecycleRevision"
>;

/** The caller owns admission; anchor and source authority share the current statement snapshot. */
export function assertSessionTranscriptContextAnchorInDatabase(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  resolved: ResolvedTranscriptReadScope,
  through: TranscriptEntryAnchor,
  expectedAuthority?: TranscriptSourceAuthority,
): void {
  if (
    resolved.agentId !== through.agentId ||
    resolved.sessionId !== through.sessionId ||
    resolved.sessionKey !== through.sessionKey ||
    database.path !== through.storePath
  ) {
    throw new SessionTranscriptReadFenceError(
      "Completed-turn anchor belongs to another transcript",
    );
  }
  const params = {
    database,
    resolved: { ...resolved, sessionKey: through.sessionKey },
    entryId: through.entryId,
  };
  let current: TranscriptEntryAnchor | undefined;
  if (expectedAuthority) {
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      selectActiveTranscriptEntryAnchor(params)
        .innerJoin(
          canonicalSessionValidationQuery(database, { metadata: true })
            .where("session_nodes.session_key", "=", through.sessionKey)
            .as("authority"),
          "authority.current_session_id",
          "identity.session_id",
        )
        .selectAll("authority"),
    );
    const entry =
      row && validateCanonicalSessionRowEntry(row, parseSessionEntryJson(row, "list"), "read");
    if (
      !entry ||
      entry.permissionMode !== expectedAuthority.permissionMode ||
      (entry.lifecycleRevision ?? null) !== (expectedAuthority.lifecycleRevision ?? null)
    ) {
      throw new SessionTranscriptReadFenceError(
        "Session transcript source was deleted, replaced, or changed lifecycle or permissions.",
      );
    }
    current = createTranscriptEntryAnchor({ ...params, row });
  } else {
    current = readActiveTranscriptEntryAnchorInTransaction(params);
  }
  if (
    !current ||
    (["generation", "rawSeq", "effectiveParentId", "activeMessagePosition"] as const).some(
      (field) => current[field] !== through[field],
    )
  ) {
    throw new SessionTranscriptReadFenceError("Completed-turn transcript anchor changed");
  }
}

/** Reads one active message identity from the caller's current SQLite transaction. */
export function readActiveTranscriptEntryAnchorInTransaction(params: {
  database: Pick<OpenClawAgentDatabase, "db" | "path">;
  resolved: ResolvedTranscriptScope;
  entryId: string;
  message?: unknown;
}): TranscriptEntryAnchor | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    params.database.db,
    selectActiveTranscriptEntryAnchor(params),
  );
  return createTranscriptEntryAnchor({ ...params, row });
}

/** Compose final authority predicates into the anchor's single-statement snapshot. */
function selectActiveTranscriptEntryAnchor(params: {
  database: Pick<OpenClawAgentDatabase, "db">;
  resolved: ResolvedTranscriptScope;
  entryId: string;
}) {
  return (
    getSessionKysely(params.database.db)
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
      // Branch changes retain old rows; readiness and the anchor share this statement's snapshot.
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom(
                selectSessionTranscriptIndexStatus(
                  params.database.db,
                  params.resolved.sessionId,
                ).as("status"),
              )
              .select("needs_reconcile")
              .where("needs_reconcile", "=", 1),
          ),
        ),
      )
      .limit(1)
  );
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
