import type { Selectable } from "kysely";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { hasStoredTranscriptEvents } from "./session-accessor.sqlite-transcript-presence.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import type { SessionEntry } from "./types.js";

const sessionEntryWindowColumns = [
  "session_id",
  "session_key",
  "reason",
  "created_at",
  "updated_at",
  "session_entry_provenance",
  "acp_owned",
  "plugin_owner_id",
  "hook_external_content_source",
  "previous_session_id",
  "session_scope",
  "started_at",
  "ended_at",
  "status",
  "chat_type",
  "channel",
  "account_id",
  "model_provider",
  "model",
  "agent_harness_id",
  "parent_session_key",
  "spawned_by",
  "display_name",
  "primary_conversation_id",
  "transcript_observed_at",
  "transcript_updated_at",
] as const;

export type SessionEntryWindowRow = Pick<
  Selectable<OpenClawAgentKyselyDatabase["session_windows"]>,
  (typeof sessionEntryWindowColumns)[number]
>;

type SessionEntryWindowFactSelection = {
  [Column in keyof SessionEntryWindowRow]: `session_windows.${Column} as window_${Column}`;
}[keyof SessionEntryWindowRow];

const sessionEntryWindowFactSelections = sessionEntryWindowColumns.map(
  // SAFETY: The column and its prefixed alias are generated together from the typed schema keys.
  (column) => `session_windows.${column} as window_${column}` as SessionEntryWindowFactSelection,
);

export function selectSessionEntryWindowFacts(database: Pick<OpenClawAgentDatabase, "db">) {
  return getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db)
    .selectFrom("session_windows")
    .select(sessionEntryWindowFactSelections)
    .as("entry_window");
}

type JoinedSessionEntryWindow = {
  [Column in keyof SessionEntryWindowRow as `window_${Column}`]?:
    | SessionEntryWindowRow[Column]
    | null;
};

/** Detach the scalar LEFT JOIN projection from the canonical node columns. */
export function takeSessionEntryWindowFacts(
  row: JoinedSessionEntryWindow & { session_key: string },
): SessionEntryWindowRow | null {
  const present = row.window_session_id !== null;
  const entries = sessionEntryWindowColumns.map((column) => {
    const alias = `window_${column}` as const;
    const value = row[alias];
    delete row[alias];
    return [column, value];
  });
  // SAFETY: The join selects every typed window column; Object.fromEntries erases those known keys.
  return present ? (Object.fromEntries(entries) as SessionEntryWindowRow) : null;
}

export type SessionEntryWindowFacts = {
  sessionId: string;
  row: SessionEntryWindowRow | null;
};

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

export function prepareSessionEntryWindowRow<
  T extends Omit<SessionEntryWindowRow, "transcript_observed_at" | "transcript_updated_at">,
>(params: {
  boundSessionRow: T;
  database: OpenClawAgentDatabase;
  entry: SessionEntry;
  previousEntry?: SessionEntry;
  retainOwner: boolean;
  prepared?: SessionEntryWindowFacts;
  stagedTranscriptUpdatedAt?: number;
}): {
  row: T & { transcript_observed_at: number };
  postimage: SessionEntryWindowRow;
  changed: boolean;
} {
  const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(params.database.db);
  const actor = readSessionActorTransactionState(params.database, {
    sessionId: params.entry.sessionId,
  });
  const prepared = params.prepared;
  const existingRoot = actor
    ? actor.window
    : prepared?.sessionId === params.entry.sessionId
      ? prepared.row
      : executeSqliteQueryTakeFirstSync(
          params.database.db,
          db
            .selectFrom("session_windows")
            .select(sessionEntryWindowColumns)
            .where("session_id", "=", params.entry.sessionId),
        );
  const transcriptUpdatedAt =
    existingRoot && !actor && params.stagedTranscriptUpdatedAt !== undefined
      ? Math.max(existingRoot.transcript_updated_at ?? 0, params.stagedTranscriptUpdatedAt)
      : (existingRoot?.transcript_updated_at ?? null);
  // Registry writes snapshot the current transcript watermark so recovery can
  // distinguish same-millisecond transcript writes before and after this row.
  let row = {
    ...params.boundSessionRow,
    transcript_observed_at: transcriptUpdatedAt ?? params.entry.updatedAt,
  };
  // Updates cannot prove provenance for a migrated transcript. Known exclusion metadata is monotonic.
  if (
    existingRoot?.session_entry_provenance === 0 &&
    (params.previousEntry?.sessionId === params.entry.sessionId ||
      hasStoredTranscriptEvents(params.database, params.entry.sessionId))
  ) {
    row = {
      ...row,
      session_entry_provenance: 0,
      acp_owned: 0,
      plugin_owner_id: null,
      hook_external_content_source: null,
    };
  } else if (existingRoot?.session_entry_provenance === 1) {
    row = {
      ...row,
      acp_owned: existingRoot.acp_owned === 1 ? 1 : row.acp_owned,
      plugin_owner_id: row.plugin_owner_id ?? existingRoot.plugin_owner_id,
      hook_external_content_source:
        row.hook_external_content_source ?? existingRoot.hook_external_content_source,
    };
  }
  const previous = new Map(Object.entries(existingRoot ?? {}));
  return {
    row,
    postimage: {
      ...row,
      created_at: existingRoot?.created_at ?? row.created_at,
      session_key: params.retainOwner && existingRoot ? existingRoot.session_key : row.session_key,
      transcript_updated_at: transcriptUpdatedAt,
    },
    changed:
      !existingRoot ||
      Object.entries(row).some(
        ([key, value]) =>
          // Conflict updates retain creation time and, for metadata patches, window ownership.
          key !== "created_at" &&
          !(params.retainOwner && key === "session_key") &&
          previous.get(key) !== value,
      ),
  };
}
