import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  getNodeSqliteKysely,
  executeSqliteQuerySync,
  prepareSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { SESSION_PARTICIPANTS_TABLE } from "../../state/openclaw-agent-db-contract.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { readCurrentSessionEntryCacheParticipants } from "./session-accessor.sqlite-entry-cache.js";
import {
  readParticipantIdentity,
  type SessionParticipantIdentity,
} from "./session-participant-identity.js";
import { readPreparedSessionParticipants } from "./session-participant-prepared-read.js";
import type { SessionEntry } from "./types.js";

export type SessionParticipantRecord = {
  identity: SessionParticipantIdentity;
  contributionCount: number;
  firstPromptedAt: number | null;
  lastPromptedAt: number | null;
};

type SessionParticipantRow = Selectable<OpenClawAgentKyselyDatabase["session_participants"]>;

function selectParticipantRows(database: DatabaseSync) {
  return getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database)
    .selectFrom("session_participants")
    .selectAll()
    .orderBy("session_key")
    .orderBy("first_prompted_at")
    .orderBy("actor_id")
    .orderBy("identity_namespace");
}

function prepareSingleSessionParticipantQuery(database: DatabaseSync) {
  return prepareSqliteQuerySync<string, SessionParticipantRow>(database, (parameter) =>
    selectParticipantRows(database).where(
      "session_key",
      "=",
      parameter((sessionKey) => sessionKey),
    ),
  );
}

// Compiled SQL follows the connection; native statement invalidation remains executor-owned.
const singleSessionParticipantQueries = new WeakMap<
  DatabaseSync,
  ReturnType<typeof prepareSingleSessionParticipantQuery>
>();

function readParticipantRows(database: DatabaseSync, sessionKeys?: readonly string[]) {
  const sessionKey = sessionKeys?.length === 1 ? sessionKeys[0] : undefined;
  if (sessionKey !== undefined) {
    let query = singleSessionParticipantQueries.get(database);
    if (!query) {
      query = prepareSingleSessionParticipantQuery(database);
      singleSessionParticipantQueries.set(database, query);
    }
    return query(sessionKey).rows;
  }
  let query = selectParticipantRows(database);
  if (sessionKeys) {
    query = query.where("session_key", "in", sqliteStringSet(sessionKeys));
  }
  return executeSqliteQuerySync(database, query).rows;
}

function readParticipantRecord(row: SessionParticipantRow): SessionParticipantRecord {
  return {
    identity: readParticipantIdentity(row.identity_namespace, row.actor_id),
    contributionCount: row.contribution_count,
    firstPromptedAt: row.first_prompted_at,
    lastPromptedAt: row.last_prompted_at,
  };
}

export function participantRecordsBySessionKey(
  database: DatabaseSync,
  sessionKeys?: readonly string[],
): Map<string, SessionParticipantRecord[]> {
  const records = new Map<string, SessionParticipantRecord[]>();
  if (!tableExists(database, SESSION_PARTICIPANTS_TABLE)) {
    return records;
  }
  for (const row of readParticipantRows(database, sessionKeys)) {
    const participants = records.get(row.session_key) ?? [];
    participants.push(readParticipantRecord(row));
    records.set(row.session_key, participants);
  }
  return records;
}

function participantProjection(
  records: readonly SessionParticipantRecord[],
): Pick<SessionEntry, "participants" | "participantCount"> {
  if (records.length === 0) {
    return {};
  }
  return {
    participants: records.map(({ identity }) => ({ identity })),
    participantCount: records.length,
  };
}

function withProjectedParticipants(
  entry: SessionEntry,
  records: readonly SessionParticipantRecord[],
): SessionEntry {
  return records.length ? { ...entry, ...participantProjection(records) } : entry;
}

export function readSqliteSessionParticipantProjection(database: DatabaseSync, sessionKey: string) {
  return (
    readPreparedSessionParticipants(database, sessionKey) ??
    readCurrentSessionEntryCacheParticipants(database, sessionKey) ??
    participantProjection(
      participantRecordsBySessionKey(database, [sessionKey]).get(sessionKey) ?? [],
    )
  );
}

export function projectSqliteSessionParticipants(
  database: DatabaseSync,
  sessionKey: string,
  entry: SessionEntry,
): SessionEntry {
  const prepared =
    readPreparedSessionParticipants(database, sessionKey) ??
    readCurrentSessionEntryCacheParticipants(database, sessionKey);
  if (prepared) {
    return prepared.participants ? { ...entry, ...prepared } : entry;
  }
  return withProjectedParticipants(
    entry,
    participantRecordsBySessionKey(database, [sessionKey]).get(sessionKey) ?? [],
  );
}

/** Acquire one fresh cohort lazily, then decode only the requested session's participants. */
export function prepareSqliteSessionParticipantProjection(
  database: DatabaseSync,
  sessionKeys: readonly string[],
): (sessionKey: string, entry: SessionEntry) => SessionEntry {
  let rowsByKey: Map<string, SessionParticipantRow[]> | undefined;
  let acquisitionFailed = false;
  return (sessionKey, entry) => {
    const prepared = readPreparedSessionParticipants(database, sessionKey);
    if (prepared) {
      return prepared.participants ? { ...entry, ...prepared } : entry;
    }
    if (!rowsByKey && !acquisitionFailed) {
      try {
        const rows = tableExists(database, SESSION_PARTICIPANTS_TABLE)
          ? readParticipantRows(database, sessionKeys)
          : [];
        rowsByKey = new Map();
        for (const row of rows) {
          const participants = rowsByKey.get(row.session_key) ?? [];
          participants.push(row);
          rowsByKey.set(row.session_key, participants);
        }
      } catch {
        // A native row-conversion failure must not poison healthy siblings.
        acquisitionFailed = true;
      }
    }
    if (acquisitionFailed) {
      return projectSqliteSessionParticipants(database, sessionKey, entry);
    }
    return withProjectedParticipants(
      entry,
      (rowsByKey?.get(sessionKey) ?? []).map(readParticipantRecord),
    );
  };
}

export function projectSqliteSessionParticipantsBatch(
  database: DatabaseSync,
  entries: ReadonlyMap<string, SessionEntry>,
): Map<string, SessionEntry> {
  const prepared = new Map<string, SessionEntry>();
  for (const [sessionKey, entry] of entries) {
    const projection = readPreparedSessionParticipants(database, sessionKey);
    if (!projection) {
      break;
    }
    prepared.set(sessionKey, projection.participants ? { ...entry, ...projection } : entry);
  }
  if (prepared.size === entries.size) {
    return prepared;
  }
  const records = participantRecordsBySessionKey(database, [...entries.keys()]);
  const projected = new Map(entries);
  for (const [sessionKey, participants] of records) {
    const entry = entries.get(sessionKey);
    if (entry) {
      projected.set(sessionKey, withProjectedParticipants(entry, participants));
    }
  }
  return projected;
}
