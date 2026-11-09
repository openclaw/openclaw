import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  createSqliteQueryCache,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  getSessionKysely,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope-helpers.js";
import { projectTranscriptNavigationSql } from "./session-model-context-projection.js";
import type { SessionTranscriptAuthority } from "./session-transcript-authority.types.js";
import type { TranscriptWindowUpdate } from "./session-transcript-index-postgres.js";
import { selectSessionTranscriptProjectionState } from "./session-transcript-index.js";
import { foldedSessionKeyAliasCandidates, normalizeStoreSessionKey } from "./store-entry.js";
import { transcriptEventNavigationSql } from "./transcript-payload.js";

export const transcriptMutationStateQuery = createSqliteQueryCache((database: EngineConnection) => {
  const db = getSessionKysely(database);
  return prepareSqliteQueryTakeFirstSync<
    string,
    { transcript_observed_at: number | null; transcript_updated_at: number | null }
  >(database, (parameter) =>
    db
      .selectFrom("session_windows")
      .select(["transcript_observed_at", "transcript_updated_at"])
      .where(
        "session_id",
        "=",
        parameter((sessionId) => sessionId),
      ),
  );
});

export function selectTranscriptSessionRoot(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
) {
  const db = getSessionKysely(database.db);
  const lookupKeys = uniqueStrings([
    scope.sessionKey,
    ...foldedSessionKeyAliasCandidates(normalizeStoreSessionKey(scope.sessionKey)),
  ]);
  // The seed preserves window ownership even when its logical node is absent.
  return db
    .selectFrom(db.selectNoFrom((eb) => eb.val(scope.sessionId).as("session_id")).as("target"))
    .leftJoin("session_windows as window", "window.session_id", "target.session_id")
    .leftJoin("session_nodes as node", (join) => join.on("node.session_key", "in", lookupKeys))
    .select([
      "node.current_session_id",
      "node.entry_valid",
      "node.session_key",
      "node.updated_at",
      "node.entry_json",
      "window.session_key as persisted_session_key",
    ])
    .select((eb) =>
      eb
        .exists(
          eb
            .selectFrom("session_windows as retained")
            .select("retained.session_id")
            .whereRef("retained.session_id", "=", "node.current_session_id")
            .whereRef("retained.session_key", "=", "node.session_key"),
        )
        .as("retained_window"),
    );
}

export type TranscriptSessionRootRow = Awaited<
  ReturnType<ReturnType<typeof selectTranscriptSessionRoot>["execute"]>
>[number];

export function selectTranscriptAppendState(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  withLatestIdentity = false,
) {
  return selectTranscriptSessionRoot(database, scope)
    .leftJoin(
      "transcript_rewrite_watermarks as generation",
      "generation.session_id",
      "target.session_id",
    )
    .leftJoin(
      selectSessionTranscriptProjectionState(database.db, scope.sessionId).as("projection"),
      (join) => join.onTrue(),
    )
    .$if(withLatestIdentity, (query) =>
      query
        .leftJoin(
          selectTranscriptAppendParentIdentity(database, scope.sessionId).as("append_parent"),
          (join) => join.onTrue(),
        )
        .select([
          "append_parent.event_type as append_parent_event_type",
          "append_parent.event_json as append_parent_event_json",
        ]),
    )
    .select([
      "window.row_transcript_json",
      "window.row_transcript_updated_at",
      "window.transcript_updated_at",
      "generation.generation",
      "projection.active_event_count",
      "projection.active_message_count",
      "projection.indexed_seq",
      "projection.leaf_event_id",
      "projection.needs_rebuild",
      "projection.has_unclassified",
    ])
    .select((eb) => [
      eb
        .selectFrom("transcript_events")
        .select((inner) => inner.fn.max<number>("seq").as("seq"))
        .where("session_id", "=", scope.sessionId)
        .as("max_seq"),
      eb
        .exists(
          eb
            .selectFrom("session_transcript_cold_archives")
            .select("session_id")
            .where("session_id", "=", scope.sessionId),
        )
        .as("cold"),
    ]);
}

/** The append-state read can carry this same latest-identity probe under its writer lock. */
export function selectTranscriptAppendParentIdentity(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionId: string,
) {
  return getSessionKysely(database.db)
    .selectFrom("transcript_event_identities as ti")
    .innerJoin("transcript_events as te", (join) =>
      join.onRef("te.session_id", "=", "ti.session_id").onRef("te.seq", "=", "ti.seq"),
    )
    .select([
      "ti.event_type",
      projectTranscriptNavigationSql(
        database.db,
        transcriptEventNavigationSql(database.db, "te"),
      ).as("event_json"),
    ])
    .where("ti.session_id", "=", sessionId)
    .orderBy("ti.seq", "desc")
    .limit(1);
}

export function returningTranscriptMutationAuthority(
  update: TranscriptWindowUpdate,
  sessionId: string,
) {
  return update
    .returning((eb) => [
      "session_id as sessionId",
      "session_key as sessionKey",
      "transcript_updated_at as updatedAt",
      eb
        .selectFrom("transcript_rewrite_watermarks")
        .select("generation")
        .where("session_id", "=", sessionId)
        .as("generation"),
      eb.fn
        .coalesce(
          eb
            .selectFrom("session_transcript_cold_archives")
            .select("last_seq")
            .where("session_id", "=", sessionId),
          eb
            .selectFrom("transcript_events")
            .select((inner) => inner.fn.max<number | null>("seq").as("seq"))
            .where("session_id", "=", sessionId),
        )
        .as("rawSeq"),
      eb
        .selectFrom("session_transcript_index_state")
        .select("leaf_event_id")
        .where("session_id", "=", sessionId)
        .as("leafEventId"),
      eb
        .selectFrom("session_transcript_index_state")
        .select("indexed_seq")
        .where("session_id", "=", sessionId)
        .as("indexedSeq"),
      eb
        .selectFrom("session_transcript_index_state")
        .select("active_message_count")
        .where("session_id", "=", sessionId)
        .as("activeMessageCount"),
      eb
        .selectFrom("session_transcript_index_state")
        .select("needs_rebuild")
        .where("session_id", "=", sessionId)
        .as("needsRebuild"),
    ])
    .$assertType<SessionTranscriptAuthority>();
}
