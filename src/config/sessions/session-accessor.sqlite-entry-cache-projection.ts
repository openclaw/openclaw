import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { readSqliteDatabaseWriteRevision } from "../../infra/sqlite-database-admission.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type {
  SessionEntryCacheDatabase,
  SessionEntryCacheSnapshot,
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
import type { SessionEntrySnapshot } from "./session-entry-snapshots.js";
import type { SessionEntry } from "./types.js";

type SessionEntryCacheTables = Pick<OpenClawAgentKyselyDatabase, "session_nodes">;

export function loadSessionEntrySnapshot(
  database: SessionEntryCacheDatabase,
  projection: "full" | "list" = "list",
  prepared?: ValidatedSessionMetadata,
  deferParticipants = false,
): SessionEntryCacheSnapshot {
  // Only the same settled writer receipt can certify the parsed validation rows.
  const metadata =
    prepared?.writeRevision !== undefined &&
    prepared.writeRevision === readSqliteDatabaseWriteRevision(database.db)
      ? prepared
      : undefined;
  const parsedEntries = metadata?.entries ?? new Map<string, SessionEntry>();
  const keys = metadata?.keys ?? [];
  // Stream raw JSON so a full read never holds both serialized and parsed store-wide payloads.
  if (!metadata) {
    for (const row of iterateSqliteQuerySync(
      database.db,
      selectSessionEntryRows(database, projection).select("updated_at").orderBy("session_key"),
    )) {
      keys.push(row.session_key);
      const entry = parseSessionEntryJson(row, projection);
      if (entry) {
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
  participants?: Pick<SessionEntry, "participants" | "participantCount">,
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
    ...(participants ?? readSqliteSessionParticipantProjection(database.db, sessionKey)),
  };
}

export function projectSessionEntryCacheUpdate(
  entryJson: string,
  sideMetadata: SessionEntrySideMetadata | undefined,
  snapshotEntry?: SessionEntry,
  snapshots?: readonly SessionEntrySnapshot[],
): SessionEntry | undefined {
  // The writer supplies its persisted bytes; the cache owns the decoded metadata graph.
  const parsedEntry = parseSessionEntryJson({ entry_json: entryJson }, "list");
  if (parsedEntry && snapshotEntry) {
    // Changed snapshots reuse persisted bytes; unchanged snapshots are already decoded.
    const cold =
      snapshots !== undefined
        ? Object.fromEntries(
            snapshots.map(({ field, valueJson }) => [field, JSON.parse(valueJson)]),
          )
        : structuredClone({
            ...(snapshotEntry.sessionDiffBaseline !== undefined
              ? { sessionDiffBaseline: snapshotEntry.sessionDiffBaseline }
              : {}),
            ...(snapshotEntry.skillsSnapshot !== undefined
              ? { skillsSnapshot: snapshotEntry.skillsSnapshot }
              : {}),
            ...(snapshotEntry.systemPromptReport !== undefined
              ? { systemPromptReport: snapshotEntry.systemPromptReport }
              : {}),
          });
    Object.assign(parsedEntry, cold);
  }
  return parsedEntry ? freezeJsonSnapshot({ ...parsedEntry, ...sideMetadata }) : undefined;
}
