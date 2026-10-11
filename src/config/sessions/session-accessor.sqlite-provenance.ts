import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { hasStoredTranscriptEvents } from "./session-accessor.sqlite-transcript-presence.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import type { SessionEntry } from "./types.js";

type SessionProvenanceRow = {
  acp_owned: number;
  hook_external_content_source: "gmail" | "webhook" | null;
  plugin_owner_id: string | null;
  session_entry_provenance: number;
};

export function bindSessionEntryProvenance(entry: SessionEntry): SessionProvenanceRow {
  const hookSource = entry.hookExternalContentSource;
  // Existing session schemas only admit Gmail/webhook; retain explicit email
  // as generic untrusted provenance instead of dropping its security marker.
  const persistedHookSource = hookSource === "email" ? "webhook" : hookSource;
  return {
    session_entry_provenance: 1,
    acp_owned: entry.acp ? 1 : 0,
    plugin_owner_id:
      typeof entry.pluginOwnerId === "string" && entry.pluginOwnerId.trim()
        ? entry.pluginOwnerId.trim()
        : null,
    hook_external_content_source:
      persistedHookSource === "gmail" || persistedHookSource === "webhook"
        ? persistedHookSource
        : null,
  };
}

export function prepareSessionEntryWindowRow<T extends SessionProvenanceRow>(params: {
  boundSessionRow: T;
  database: OpenClawAgentDatabase;
  entry: SessionEntry;
  previousEntry?: SessionEntry;
}): T & { transcript_observed_at: number } {
  const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(params.database.db);
  const actor = readSessionActorTransactionState(params.database, {
    sessionId: params.entry.sessionId,
  });
  const existingRoot = actor
    ? actor.window
    : executeSqliteQueryTakeFirstSync(
        params.database.db,
        db
          .selectFrom("session_windows")
          .select([
            "session_entry_provenance",
            "acp_owned",
            "plugin_owner_id",
            "hook_external_content_source",
            "transcript_observed_at",
            "transcript_updated_at",
          ])
          .where("session_id", "=", params.entry.sessionId),
      );
  // Registry writes snapshot the current transcript watermark so recovery can
  // distinguish same-millisecond transcript writes before and after this row.
  const boundSessionRow = {
    ...params.boundSessionRow,
    transcript_observed_at: existingRoot?.transcript_updated_at ?? params.entry.updatedAt,
  };
  // Updates cannot prove provenance for a migrated transcript. Known exclusion metadata is monotonic.
  if (
    existingRoot?.session_entry_provenance === 0 &&
    (params.previousEntry?.sessionId === params.entry.sessionId ||
      hasStoredTranscriptEvents(params.database, params.entry.sessionId))
  ) {
    return {
      ...boundSessionRow,
      session_entry_provenance: 0,
      acp_owned: 0,
      plugin_owner_id: null,
      hook_external_content_source: null,
    };
  }
  return existingRoot?.session_entry_provenance === 1
    ? {
        ...boundSessionRow,
        acp_owned: existingRoot.acp_owned === 1 ? 1 : boundSessionRow.acp_owned,
        plugin_owner_id: boundSessionRow.plugin_owner_id ?? existingRoot.plugin_owner_id,
        hook_external_content_source:
          boundSessionRow.hook_external_content_source ?? existingRoot.hook_external_content_source,
      }
    : boundSessionRow;
}
