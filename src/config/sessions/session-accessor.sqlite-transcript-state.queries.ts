import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { selectSessionTranscriptProjectionState } from "./session-transcript-index.js";
import { foldedSessionKeyAliasCandidates, normalizeStoreSessionKey } from "./store-entry.js";

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
