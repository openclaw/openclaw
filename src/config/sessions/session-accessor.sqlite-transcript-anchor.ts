import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { getSqliteReadScopeRevision } from "../../infra/sqlite-schema-facts.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import {
  selectActiveTranscriptIdentityRows,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import type {
  ResolvedTranscriptReadScope,
  ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope-helpers.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import { canonicalSessionValidationQuery } from "./session-canonical-key.js";
import { validateCanonicalSessionRowEntry } from "./session-canonical-row.js";
import {
  retainTranscriptAppendPostimage,
  type TranscriptAppendPostimage,
} from "./session-transcript-append-postimage.js";
import { selectSessionTranscriptIndexStatus } from "./session-transcript-index.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";
import {
  sameTranscriptEntryAnchor,
  type TranscriptEntryAnchor,
} from "./transcript-entry-anchor.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import { TRANSCRIPT_INSERT_BATCH_SIZE } from "./transcript-payload.js";
import type { InternalSessionEntry } from "./types.js";

export type TranscriptSourceAuthority = Pick<
  InternalSessionEntry,
  "permissionMode" | "lifecycleRevision"
>;

/** Read one active identity using the caller's existing admitted snapshot. */
export function readActiveTranscriptEntryIdentityInSnapshot(
  projection: CurrentTranscriptProjection,
  entryId: string,
) {
  return executeSqliteQueryTakeFirstSync(
    projection.database.db,
    selectActiveTranscriptIdentityRows(projection.database)
      .select(["identity.seq", "identity.parent_id as parentId"])
      .where("identity.session_id", "=", projection.resolved.sessionId)
      .where("identity.event_id", "=", entryId)
      .limit(1),
  );
}

export function readActivePathEntryRelationFromProjection(
  projection: CurrentTranscriptProjection,
  entryId: string | null,
): "exact" | "ancestor" | "off-path" {
  if (projection.state.leafEventId === entryId || entryId === null) {
    return projection.state.leafEventId === entryId ? "exact" : "off-path";
  }
  return readActiveTranscriptEntryIdentityInSnapshot(projection, entryId) ? "ancestor" : "off-path";
}

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
    current = createTranscriptEntryAnchor({
      ...params,
      row: row && { ...row, generation: row.generation ?? null },
    });
  } else {
    current = readActiveTranscriptEntryAnchorInTransaction(params);
  }
  if (!sameTranscriptEntryAnchor(through, current)) {
    throw new SessionTranscriptReadFenceError("Completed-turn transcript anchor changed");
  }
}

type TranscriptEntryRead = {
  database: Pick<OpenClawAgentDatabase, "db" | "path">;
  resolved: ResolvedTranscriptScope;
  entryId: string;
  message?: unknown;
};

/** Borrow readiness only while the projection owner's synchronous snapshot remains open. */
export function readActiveTranscriptEntryAnchorFromProjection(
  projection: CurrentTranscriptProjection,
  entryId: string,
  message?: unknown,
): TranscriptEntryAnchor | undefined {
  assertTransactionUsable(projection.database.db);
  const sessionKey = projection.resolved.sessionKey;
  if (!projection.database.db.isTransaction || !sessionKey) {
    throw new Error("Transcript anchor projection requires its selected session snapshot");
  }
  const params = {
    database: projection.database,
    resolved: { ...projection.resolved, sessionKey },
    entryId,
    message,
  };
  return createTranscriptEntryAnchor({
    ...params,
    row: readActiveTranscriptEntryFacts(params, projection),
  });
}

function readActiveTranscriptEntryFacts(
  params: TranscriptEntryRead,
  projection?: CurrentTranscriptProjection,
  includeVersion = false,
) {
  const actor = readSessionActorTransactionState(params.database, params.resolved);
  if (actor) {
    const state = actor.transcript.projection;
    if (
      !state ||
      state.needsRebuild ||
      state.hasUnclassifiedEvents ||
      state.indexedSeq !== actor.hot.transcript.version.rawSeq
    ) {
      return undefined;
    }
    const identity = actor.transcript.identities.get(params.entryId);
    const active = identity && actor.transcript.active.get(identity.seq);
    if (identity && active) {
      return {
        seq: identity.seq,
        parent_id: identity.parent_id,
        message_idempotency_key: identity.message_idempotency_key,
        message_position: active.message_position,
        generation: actor.hot.transcript.version.generation,
        latestSeq: actor.hot.transcript.version.rawSeq,
        transcriptUpdatedAt: actor.hot.transcript.version.updatedAt,
      };
    }
    if (actor.transcript.complete) {
      return undefined;
    }
  }
  const row = readActiveTranscriptEntryRows(params, projection, includeVersion)[0];
  return row
    ? {
        ...row,
        generation: (projection ? projection.generation : row.generation) ?? null,
        latestSeq: projection ? projection.state.indexedSeq : row.latestSeq,
      }
    : undefined;
}

function readActiveTranscriptEntryRows(
  params: TranscriptEntryRead,
  projection?: CurrentTranscriptProjection,
  includeVersion = false,
  entryIds?: readonly string[],
) {
  return executeSqliteQuerySync(
    params.database.db,
    selectActiveTranscriptEntryAnchor(params, projection, includeVersion, entryIds),
  ).rows;
}

/** Compose final authority predicates into the anchor's single-statement snapshot. */
function selectActiveTranscriptEntryAnchor(
  params: TranscriptEntryRead,
  projection?: CurrentTranscriptProjection,
  includeVersion = false,
  entryIds?: readonly string[],
) {
  const query = selectActiveTranscriptIdentityRows(params.database)
    .select([
      "identity.event_id",
      "identity.seq",
      "identity.parent_id",
      "identity.message_idempotency_key",
      "active.message_position",
    ])
    .where("identity.session_id", "=", params.resolved.sessionId);
  const selectedIds = entryIds
    ? query.where("identity.event_id", "in", entryIds)
    : query.where("identity.event_id", "=", params.entryId).limit(1);
  return selectedIds.$if(!projection, (selected) =>
    selected
      .innerJoin("transcript_rewrite_watermarks as rewrite", (join) =>
        join.onRef("rewrite.session_id", "=", "identity.session_id"),
      )
      .leftJoin(
        selectSessionTranscriptIndexStatus(params.database.db, params.resolved.sessionId).as(
          "status",
        ),
        (join) => join.onTrue(),
      )
      .select(["rewrite.generation", "status.latestSeq"])
      .$if(includeVersion, (withVersion) =>
        withVersion.select((eb) =>
          eb
            .selectFrom("session_windows")
            .select("transcript_updated_at")
            .whereRef("session_windows.session_id", "=", "identity.session_id")
            .as("transcriptUpdatedAt"),
        ),
      )
      // Branch changes retain old rows; readiness and the anchor share this statement's snapshot.
      .where(
        "status.needs_reconcile",
        "is not",
        isPostgresSqlConnection(params.database.db) ? sql.lit(true) : 1,
      ),
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
  const revision = getSqliteReadScopeRevision(params.database.db);
  return createTranscriptMessageAppendMetadata(
    params,
    readActiveTranscriptEntryFacts(params, undefined, true),
    revision,
  );
}

function createTranscriptMessageAppendMetadata(
  params: TranscriptEntryRead,
  row: ReturnType<typeof readActiveTranscriptEntryFacts>,
  revision: ReturnType<typeof getSqliteReadScopeRevision>,
) {
  const anchor = createTranscriptEntryAnchor({ ...params, row });
  const version =
    anchor && typeof row?.latestSeq === "number"
      ? {
          generation: anchor.generation,
          rawSeq: row.latestSeq,
          updatedAt: row.transcriptUpdatedAt ?? null,
        }
      : undefined;
  const postimage: TranscriptAppendPostimage | undefined =
    revision && anchor && version ? { revision, anchor, version } : undefined;
  return retainTranscriptAppendPostimage(
    {
      anchor,
      version,
      visibleTailEntryId: anchor && row?.seq === row?.latestSeq ? params.entryId : undefined,
    },
    postimage,
  );
}

/** Fresh linear turns share one final projection read per bounded message chunk. */
export function readTranscriptMessageAppendMetadataBatchInTransaction(
  database: TranscriptEntryRead["database"],
  resolved: ResolvedTranscriptScope,
  messages: readonly { messageId: string; message: unknown }[],
): Map<string, ReturnType<typeof readTranscriptMessageAppendMetadataInTransaction>> {
  const result = new Map<
    string,
    ReturnType<typeof readTranscriptMessageAppendMetadataInTransaction>
  >();
  const revision = getSqliteReadScopeRevision(database.db);
  for (let offset = 0; offset < messages.length; offset += TRANSCRIPT_INSERT_BATCH_SIZE) {
    const chunk = messages.slice(offset, offset + TRANSCRIPT_INSERT_BATCH_SIZE);
    const first = chunk[0];
    if (!first) {
      continue;
    }
    const byId = new Map(chunk.map((message) => [message.messageId, message]));
    const rows = readActiveTranscriptEntryRows(
      { database, resolved, entryId: first.messageId },
      undefined,
      true,
      chunk.map((message) => message.messageId),
    );
    for (const row of rows) {
      const message = byId.get(row.event_id);
      if (!message) {
        continue;
      }
      result.set(
        row.event_id,
        createTranscriptMessageAppendMetadata(
          {
            database,
            resolved,
            entryId: row.event_id,
            message: message.message,
          },
          { ...row, generation: row.generation ?? null, latestSeq: row.latestSeq },
          revision,
        ),
      );
    }
  }
  return result;
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
