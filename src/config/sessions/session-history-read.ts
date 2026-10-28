import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import { listTranscriptArchivesFromDatabase } from "./session-accessor.sqlite-archive-read.js";
import type {
  SessionTranscriptInstance,
  SessionTranscriptInstanceListOptions,
} from "./session-accessor.sqlite-contract.js";
import { listSqliteSessionEntriesFromDatabase } from "./session-accessor.sqlite-entry-list.read.js";
import {
  prepareExactSessionEntryRowReads,
  readExactSessionEntryRowValidated,
} from "./session-accessor.sqlite-entry-read.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionEntryListScope } from "./session-accessor.types.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  readWithCanonicalSessionReaderContinuation,
  type CanonicalSessionReaderContinuation,
} from "./session-canonical-key.js";
import type { SessionEntryProjection } from "./session-entry-snapshot-values.js";
import type { SessionArchiveInventoryScope } from "./session-transcript-inventory.types.js";
import type { SessionEntry } from "./types.js";

/** Lists transcript-bearing SQLite sessions, including retained rows from session-id rotation. */
export function listSessionTranscriptInstances(
  scope: Omit<SessionEntryListScope, "sessionKeys"> = {},
  options: SessionTranscriptInstanceListOptions = {},
  continuation?: CanonicalSessionReaderContinuation,
): SessionTranscriptInstance[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      readWithCanonicalSessionReaderContinuation(database, continuation, () => {
        const currentEntries =
          options.sessionId !== undefined || options.sessionIds !== undefined
            ? undefined
            : new Map(
                listSqliteSessionEntriesFromDatabase(database, resolved, {
                  ...scope,
                  clone: false,
                }).map(({ sessionKey, entry }) => [sessionKey, entry]),
              );
        return listTranscriptInstancesFromDatabase({
          currentEntries,
          database,
          options,
          entryProjection: scope.projection,
        });
      }),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : [];
}

function prepareTranscriptInstanceEntries(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db">,
  sessionKeys: readonly string[],
  projection: SessionEntryProjection = "full",
): Pick<ReadonlyMap<string, SessionEntry>, "get"> {
  if (sessionKeys.length === 0) {
    return new Map();
  }
  const readRow = prepareExactSessionEntryRowReads(database, sessionKeys, projection, "canonical");
  return { get: (sessionKey) => readRow(sessionKey)?.entry };
}

function listTranscriptInstancesFromDatabase(params: {
  currentEntries?: Pick<ReadonlyMap<string, SessionEntry>, "get">;
  database: Pick<OpenClawAgentDatabase, "agentId" | "db">;
  options: SessionTranscriptInstanceListOptions;
  entryProjection?: SessionEntryProjection;
}): SessionTranscriptInstance[] {
  if (!params.currentEntries && params.options.sessionIds !== undefined) {
    assertCanonicalSqliteSessionKeysCurrent(params.database);
  }
  const db = getSessionKysely(params.database.db);
  let query = db
    .selectFrom("session_windows")
    .select([
      "session_id",
      "session_key",
      "previous_session_id",
      "created_at",
      "updated_at",
      "channel",
      "account_id",
      "transcript_updated_at",
      "session_entry_provenance",
      "acp_owned",
      "plugin_owner_id",
      "hook_external_content_source",
      "parent_session_key",
      "spawned_by",
      "chat_type",
    ]);
  if (!params.options.includeAllWindows) {
    query = query.where("transcript_updated_at", "is not", null);
  }
  if (params.options.sessionId !== undefined) {
    query = query.where("session_id", "=", params.options.sessionId);
  }
  if (params.options.sessionIds !== undefined) {
    query = query.where("session_id", "in", sqliteStringSet(params.options.sessionIds));
  }
  const rows = executeSqliteQuerySync(
    params.database.db,
    query
      .orderBy("transcript_updated_at", (order) => order.desc().nullsLast())
      .orderBy("session_id", "asc"),
  ).rows;
  const currentEntries =
    params.currentEntries ??
    (params.options.sessionIds !== undefined
      ? prepareTranscriptInstanceEntries(
          params.database,
          [...new Set(rows.map((row) => row.session_key))],
          params.entryProjection,
        )
      : {
          get: (sessionKey: string) =>
            readExactSessionEntryRowValidated(params.database, sessionKey, params.entryProjection)
              ?.entry,
        });
  return rows
    .map((row): SessionTranscriptInstance | undefined => {
      if (!params.options.includeAllWindows && isInternalSessionEffectsKey(row.session_key)) {
        return undefined;
      }
      const updatedAtMs = row.transcript_updated_at ?? row.updated_at;
      const current = currentEntries.get(row.session_key);
      // Matching identities cannot classify transcript content written before provenance existed.
      const currentIsExact = current?.sessionId === row.session_id;
      const provenanceKnown = row.session_entry_provenance === 1;
      const hookExternalContentSource =
        row.hook_external_content_source === "gmail" ||
        row.hook_external_content_source === "webhook"
          ? row.hook_external_content_source
          : undefined;
      const chatType =
        row.chat_type === "direct" || row.chat_type === "group" || row.chat_type === "channel"
          ? row.chat_type
          : undefined;
      // The legacy window class conflates email and webhook. Keep it for trust
      // gating, but report an exact source only from its bound entry or unchanged Gmail class.
      const exactHookSource =
        (currentIsExact ? current?.hookExternalContentSource : undefined) ??
        (provenanceKnown && hookExternalContentSource === "gmail" ? "gmail" : null);
      const entry: SessionEntry = {
        ...(currentIsExact && current ? structuredClone(current) : {}),
        sessionId: row.session_id,
        updatedAt: updatedAtMs,
        ...(row.previous_session_id ? { previousSessionId: row.previous_session_id } : {}),
        ...(row.parent_session_key ? { parentSessionKey: row.parent_session_key } : {}),
        ...(row.spawned_by ? { spawnedBy: row.spawned_by, spawnDepth: 1 } : {}),
        ...(chatType ? { chatType } : {}),
        ...(provenanceKnown && row.plugin_owner_id ? { pluginOwnerId: row.plugin_owner_id } : {}),
        ...(provenanceKnown && hookExternalContentSource ? { hookExternalContentSource } : {}),
      };
      return {
        agentId: resolveAgentIdFromSessionKey(row.session_key, params.database.agentId),
        acpOwned: row.acp_owned === 1 || Boolean(currentIsExact && current?.acp),
        entry,
        provenanceKnown,
        sessionId: row.session_id,
        sessionKey: row.session_key,
        updatedAtMs,
        sourceMetadata: {
          createdAt: row.created_at,
          channel: row.channel,
          accountId: row.account_id,
          chatType: chatType ?? null,
          hookExternalContentSource: exactHookSource,
        },
      };
    })
    .filter((entry): entry is SessionTranscriptInstance => entry !== undefined);
}

/** @deprecated Main-thread callers must await listSessionTranscriptArchivesInWorker. */
export function listSessionTranscriptArchivesReadOnly(scope: SessionArchiveInventoryScope) {
  const selectors = [...new Set(scope.sessionIds ?? [])];
  const archiveNames = [...new Set(scope.archiveNames ?? [])];
  if (selectors.length === 0 && archiveNames.length === 0) {
    return [];
  }
  const resolved = resolveSqliteReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      listTranscriptArchivesFromDatabase(
        database,
        scope.includeAllAgents ? undefined : resolved.agentId,
        selectors,
        archiveNames,
      ),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : [];
}
