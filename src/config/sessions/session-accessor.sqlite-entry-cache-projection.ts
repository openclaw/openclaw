import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { readSqliteDataVersion } from "../../infra/sqlite-schema-facts.js";
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
import type { SessionEntry } from "./types.js";

type SessionEntryCacheTables = Pick<OpenClawAgentKyselyDatabase, "session_nodes">;

export function loadSessionEntrySnapshot(
  database: SessionEntryCacheDatabase,
  projection: "full" | "list" = "list",
  prepared?: ValidatedSessionMetadata,
  deferParticipants = false,
): SessionEntryCacheSnapshot {
  // Validation lends complete parsed facts only within this read. A concurrent external commit
  // requires the ordinary fresh SELECT, never a stale snapshot stamped with its newer version.
  const metadata =
    prepared && prepared.dataVersion === readSqliteDataVersion(database.db) ? prepared : undefined;
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
): SessionEntry | undefined {
  // The writer supplies its persisted bytes; the cache owns the decoded metadata graph.
  const parsedEntry = parseSessionEntryJson({ entry_json: entryJson }, "list");
  return parsedEntry ? freezeJsonSnapshot({ ...parsedEntry, ...sideMetadata }) : undefined;
}
