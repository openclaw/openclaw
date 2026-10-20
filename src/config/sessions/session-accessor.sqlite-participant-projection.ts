import type { Selectable } from "kysely";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  executeSqliteQuerySync,
  prepareSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { readSqliteDatabaseWriteRevision } from "../../infra/sqlite-database-admission.js";
import {
  getSqliteReadScopeRevision,
  runSqliteReadOperationSync,
  type SqliteReadScopeRevision,
} from "../../infra/sqlite-schema-facts.js";
import { SESSION_PARTICIPANTS_TABLE } from "../../state/openclaw-agent-db-contract.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { readCurrentSessionEntryCacheParticipants } from "./session-accessor.sqlite-entry-cache-state.js";
import { readSessionActorParticipants } from "./session-actor-entry-publication.worker.js";
import type { SessionParticipantRecord } from "./session-membership-facts.types.js";
import { readParticipantIdentity } from "./session-participant-identity.js";
import { readPreparedSessionParticipants } from "./session-participant-prepared-read.js";
import type { SessionEntry } from "./types.js";

export type { SessionParticipantRecord } from "./session-membership-facts.types.js";

type SessionParticipantRow = Selectable<OpenClawAgentKyselyDatabase["session_participants"]>;

function selectParticipantRows(database: EngineConnection) {
  return getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database)
    .selectFrom("session_participants")
    .select([
      "session_key",
      "identity_namespace",
      "actor_id",
      "contribution_count",
      "first_prompted_at",
      "last_prompted_at",
    ])
    .orderBy("session_key")
    .orderBy("first_prompted_at")
    .orderBy("actor_id")
    .orderBy("identity_namespace");
}

let participantWriteSnapshot: EngineConnection | undefined;

/** The entry CAS owns an immediate transaction before borrowing its unchanged preparation. */
export function withSessionParticipantWriteSnapshot<T>(
  database: EngineConnection,
  read: () => T,
): T {
  const previous = participantWriteSnapshot;
  participantWriteSnapshot = database;
  try {
    return read();
  } finally {
    participantWriteSnapshot = previous;
  }
}

// Deferred readers must execute their first SELECT to establish the native snapshot.
const singleSessionParticipantQuery = createSqliteQueryCache((database: EngineConnection) => {
  const query = prepareSqliteQuerySync<string, SessionParticipantRow>(database, (parameter) =>
    selectParticipantRows(database).where(
      "session_key",
      "=",
      parameter((sessionKey) => sessionKey),
    ),
  );
  let last:
    | { key: string; revision: SqliteReadScopeRevision; rows: SessionParticipantRow[] }
    | undefined;
  return (key: string) =>
    runSqliteReadOperationSync(database, () => {
      const revision = getSqliteReadScopeRevision(database);
      if (
        revision &&
        last?.key === key &&
        (last.revision === revision ||
          (participantWriteSnapshot === database &&
            last.revision.snapshot === undefined &&
            last.revision.schema === revision.schema &&
            last.revision.mutationRevision === revision.mutationRevision &&
            last.revision.writeRevision === readSqliteDatabaseWriteRevision(database)))
      ) {
        last.revision = revision;
        return last.rows;
      }
      const rows = query(key).rows;
      last = revision ? { key, revision, rows } : undefined;
      return rows;
    });
});

function readParticipantRows(database: EngineConnection, sessionKeys?: readonly string[]) {
  const sessionKey = sessionKeys?.length === 1 ? sessionKeys[0] : undefined;
  if (sessionKey !== undefined) {
    return singleSessionParticipantQuery(database)(sessionKey);
  }
  let query = selectParticipantRows(database);
  if (sessionKeys) {
    query = query.where("session_key", "in", sqliteStringSet(sessionKeys));
  }
  return executeSqliteQuerySync(database, query).rows;
}

export function readParticipantRecord(
  row: Omit<SessionParticipantRow, "session_key">,
): SessionParticipantRecord {
  return {
    identity: readParticipantIdentity(row.identity_namespace, row.actor_id),
    contributionCount: row.contribution_count,
    firstPromptedAt: row.first_prompted_at,
    lastPromptedAt: row.last_prompted_at,
  };
}

export function participantRecordsBySessionKey(
  database: EngineConnection,
  sessionKeys?: readonly string[],
): Map<string, SessionParticipantRecord[]> {
  return runSqliteReadOperationSync(database, () => {
    const records = new Map<string, SessionParticipantRecord[]>();
    const missing = sessionKeys?.filter((sessionKey) => {
      const participants = readSessionActorParticipants({ db: database }, sessionKey);
      if (participants === undefined) {
        return true;
      }
      if (participants.length) {
        records.set(sessionKey, participants);
      }
      return false;
    });
    if (missing?.length === 0) {
      return records;
    }
    if (!tableExists(database, SESSION_PARTICIPANTS_TABLE)) {
      return records;
    }
    for (const row of readParticipantRows(database, missing)) {
      const participants = records.get(row.session_key) ?? [];
      participants.push(readParticipantRecord(row));
      records.set(row.session_key, participants);
    }
    return records;
  });
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

export function withProjectedParticipants(
  entry: SessionEntry,
  records: readonly SessionParticipantRecord[],
): SessionEntry {
  return records.length ? { ...entry, ...participantProjection(records) } : entry;
}

export function readSqliteSessionParticipantProjection(
  database: EngineConnection,
  sessionKey: string,
) {
  const actor = readSessionActorParticipants({ db: database }, sessionKey);
  if (actor !== undefined) {
    return participantProjection(actor);
  }
  return (
    readPreparedSessionParticipants(database, sessionKey) ??
    readCurrentSessionEntryCacheParticipants(database, sessionKey) ??
    participantProjection(
      participantRecordsBySessionKey(database, [sessionKey]).get(sessionKey) ?? [],
    )
  );
}

export function projectSqliteSessionParticipants(
  database: EngineConnection,
  sessionKey: string,
  entry: SessionEntry,
): SessionEntry {
  const actor = readSessionActorParticipants({ db: database }, sessionKey);
  if (actor !== undefined) {
    return withProjectedParticipants(entry, actor);
  }
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
  database: EngineConnection,
  sessionKeys: readonly string[],
): (sessionKey: string, entry: SessionEntry) => SessionEntry {
  let recordsByKey: Map<string, SessionParticipantRecord[]> | undefined;
  let acquisitionFailed = false;
  return (sessionKey, entry) => {
    const actor = readSessionActorParticipants({ db: database }, sessionKey);
    if (actor !== undefined) {
      return withProjectedParticipants(entry, actor);
    }
    const prepared =
      readPreparedSessionParticipants(database, sessionKey) ??
      readCurrentSessionEntryCacheParticipants(database, sessionKey);
    if (prepared) {
      return prepared.participants ? { ...entry, ...prepared } : entry;
    }
    if (!recordsByKey && !acquisitionFailed) {
      try {
        recordsByKey = participantRecordsBySessionKey(database, sessionKeys);
      } catch {
        // A native row-conversion failure must not poison healthy siblings.
        acquisitionFailed = true;
      }
    }
    if (acquisitionFailed) {
      return projectSqliteSessionParticipants(database, sessionKey, entry);
    }
    return withProjectedParticipants(entry, recordsByKey?.get(sessionKey) ?? []);
  };
}

export function projectSqliteSessionParticipantsBatch(
  database: EngineConnection,
  entries: ReadonlyMap<string, SessionEntry>,
): Map<string, SessionEntry> {
  const projected = new Map(entries);
  const missing: string[] = [];
  for (const [sessionKey, entry] of entries) {
    const actor = readSessionActorParticipants({ db: database }, sessionKey);
    if (actor !== undefined) {
      projected.set(sessionKey, withProjectedParticipants(entry, actor));
      continue;
    }
    const projection =
      readPreparedSessionParticipants(database, sessionKey) ??
      readCurrentSessionEntryCacheParticipants(database, sessionKey);
    if (!projection) {
      missing.push(sessionKey);
      continue;
    }
    projected.set(sessionKey, projection.participants ? { ...entry, ...projection } : entry);
  }
  if (missing.length === 0) {
    return projected;
  }
  const records = participantRecordsBySessionKey(database, missing);
  for (const [sessionKey, participants] of records) {
    const entry = entries.get(sessionKey);
    if (entry) {
      projected.set(sessionKey, withProjectedParticipants(entry, participants));
    }
  }
  return projected;
}
