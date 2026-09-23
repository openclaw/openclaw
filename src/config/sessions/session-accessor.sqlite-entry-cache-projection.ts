import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { readSqliteDataVersion } from "../../infra/node-sqlite.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionEntryCacheSnapshot,
  SessionSharingEntry,
} from "./session-accessor.sqlite-entry-cache.types.js";
import {
  hasSqliteSessionOwnerColumns,
  readSqliteSessionOwner,
} from "./session-accessor.sqlite-owner-projection.js";
import {
  projectSqliteSessionParticipantsBatch,
  readSqliteSessionParticipantProjection,
} from "./session-accessor.sqlite-participant-projection.js";
import { parseSessionEntryJson, selectSessionEntryRows } from "./session-accessor.sqlite-status.js";
import type { ValidatedSessionMetadata } from "./session-canonical-key.js";
import type { SessionEntry } from "./types.js";

type SessionEntryCacheTables = Pick<OpenClawAgentKyselyDatabase, "session_nodes">;

export type SessionEntryCacheDatabase = Pick<OpenClawAgentDatabase, "agentId" | "db">;

export function loadSessionEntrySnapshot(
  database: SessionEntryCacheDatabase,
  projection: "full" | "list" = "list",
  prepared?: ValidatedSessionMetadata,
  fullEntryKeys?: ReadonlySet<string>,
  retainFullEntry?: (sessionKey: string, entry: SessionEntry) => boolean,
  deferParticipants = false,
): SessionEntryCacheSnapshot {
  // Validation lends complete parsed facts only within this read. A concurrent external commit
  // requires the ordinary fresh SELECT, never a stale snapshot stamped with its newer version.
  const metadata =
    !fullEntryKeys && prepared && prepared.dataVersion === readSqliteDataVersion(database.db)
      ? prepared
      : undefined;
  const parsedEntries = metadata?.entries ?? new Map<string, SessionEntry>();
  const keys = metadata?.keys ?? [];
  // Stream raw JSON so a full read never holds both serialized and parsed store-wide payloads.
  if (!metadata) {
    for (const row of iterateSqliteQuerySync(
      database.db,
      selectSessionEntryRows(database, projection, fullEntryKeys ? [...fullEntryKeys] : [])
        .select("updated_at")
        .orderBy("session_key"),
    )) {
      keys.push(row.session_key);
      const entry = parseSessionEntryJson(
        row,
        fullEntryKeys?.has(row.session_key) ? "full" : projection,
      );
      if (entry) {
        if (retainFullEntry && !retainFullEntry(row.session_key, entry)) {
          delete entry.skillsSnapshot;
          delete entry.systemPromptReport;
        }
        parsedEntries.set(row.session_key, entry);
      }
    }
  }
  const entries = deferParticipants
    ? parsedEntries
    : projectSqliteSessionParticipantsBatch(database.db, parsedEntries);
  return {
    entries,
    keys,
  };
}

export type SessionEntrySideMetadata = Pick<
  SessionEntry,
  "owner" | "participants" | "participantCount"
>;

export function readSessionEntrySideMetadata(
  database: SessionEntryCacheDatabase,
  sessionKey: string,
): SessionEntrySideMetadata {
  const ownerRow = hasSqliteSessionOwnerColumns(database.db)
    ? executeSqliteQuerySync(
        database.db,
        getNodeSqliteKysely<SessionEntryCacheTables>(database.db)
          .selectFrom("session_nodes")
          .select([
            "owner_actor_type",
            "owner_actor_id",
            "owner_assigned_by_type",
            "owner_assigned_by_id",
            "owner_assigned_at",
          ])
          .where("session_key", "=", sessionKey)
          .limit(1),
      ).rows[0]
    : undefined;
  const owner = ownerRow ? readSqliteSessionOwner(ownerRow) : undefined;
  return {
    ...(owner ? { owner } : {}),
    ...readSqliteSessionParticipantProjection(database.db, sessionKey),
  };
}

export function projectSessionEntryCacheUpdate(
  sourceEntry: SessionEntry,
  sideMetadata: SessionEntrySideMetadata | undefined,
): SessionEntry | undefined {
  // Saved prompts are caller-owned and must never be serialized into the listing cache.
  const { skillsSnapshot: _skills, systemPromptReport: _report, ...metadata } = sourceEntry;
  const parsedEntry = parseSessionEntryJson({ entry_json: JSON.stringify(metadata) });
  return parsedEntry ? { ...parsedEntry, ...sideMetadata } : undefined;
}

export function projectSessionSharingEntry(entry: SessionEntry): SessionSharingEntry {
  return {
    sessionId: entry.sessionId,
    updatedAt: entry.updatedAt,
    lifecycleRevision: entry.lifecycleRevision,
    visibility: entry.visibility,
    incognito: entry.incognito,
    createdActor: entry.createdActor ? { ...entry.createdActor } : undefined,
    sandbox: entry.sandbox,
    archivedAt: entry.archivedAt,
    parentSessionKey: entry.parentSessionKey,
    parentSessionId: entry.parentSessionId,
    spawnedBy: entry.spawnedBy,
    spawnDepth: entry.spawnDepth,
    permissionMode: entry.permissionMode,
    sessionStartedAt: entry.sessionStartedAt,
    delivery: entry.delivery ? structuredClone(entry.delivery) : undefined,
  };
}
