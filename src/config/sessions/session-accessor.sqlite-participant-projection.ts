import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  prepareSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { SESSION_PARTICIPANTS_TABLE } from "../../state/openclaw-agent-session-participants-schema.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  readParticipantIdentity,
  type SessionParticipantIdentity,
} from "./session-participant-identity.js";
import type { SessionEntry } from "./types.js";

export type SessionParticipantRecord = {
  identity: SessionParticipantIdentity;
  contributionCount: number;
  firstPromptedAt: number | null;
  lastPromptedAt: number | null;
};

type SessionParticipantRow = Selectable<OpenClawAgentKyselyDatabase["session_participants"]>;

function selectParticipantRows(database: DatabaseSync) {
  return getSessionKysely(database)
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

function participantRowsBySessionKey(
  database: DatabaseSync,
  sessionKeys?: readonly string[],
): Map<string, SessionParticipantRow[]> {
  const records = new Map<string, SessionParticipantRow[]>();
  if (!tableExists(database, SESSION_PARTICIPANTS_TABLE)) {
    return records;
  }
  for (const row of readParticipantRows(database, sessionKeys)) {
    const participants = records.get(row.session_key) ?? [];
    participants.push(row);
    records.set(row.session_key, participants);
  }
  return records;
}

function withProjectedParticipants(
  entry: SessionEntry,
  records: readonly SessionParticipantRow[],
): SessionEntry {
  if (records.length === 0) {
    return entry;
  }
  return {
    ...entry,
    participants: records.map((row) => ({
      identity: readParticipantIdentity(row.identity_namespace, row.actor_id),
    })),
    participantCount: records.length,
  };
}

export function projectSqliteSessionParticipants(
  database: DatabaseSync,
  sessionKey: string,
  entry: SessionEntry,
): SessionEntry {
  return withProjectedParticipants(
    entry,
    participantRowsBySessionKey(database, [sessionKey]).get(sessionKey) ?? [],
  );
}

export function projectSqliteSessionParticipantsBatch(
  database: DatabaseSync,
  entries: ReadonlyMap<string, SessionEntry>,
): Map<string, SessionEntry> {
  const projectParticipants = createSqliteSessionParticipantProjector(database, [
    ...entries.keys(),
  ]);
  return new Map(
    [...entries].map(([sessionKey, entry]) => [sessionKey, projectParticipants(sessionKey, entry)]),
  );
}

/** Decode each session separately so a damaged identity does not reject unrelated exact reads. */
export function createSqliteSessionParticipantProjector(
  database: DatabaseSync,
  sessionKeys: readonly string[],
): (sessionKey: string, entry: SessionEntry) => SessionEntry {
  const records = participantRowsBySessionKey(database, sessionKeys);
  return (sessionKey, entry) => withProjectedParticipants(entry, records.get(sessionKey) ?? []);
}

export function listSessionParticipantsReadOnly(scope: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  sessionKey?: string;
  storePath?: string;
}): Map<string, SessionParticipantRecord[]> {
  const resolved = resolveSqliteReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      new Map(
        [
          ...participantRowsBySessionKey(
            database.db,
            scope.sessionKey ? [scope.sessionKey] : undefined,
          ),
        ].map(([sessionKey, rows]) => [
          sessionKey,
          rows.map((row) => ({
            identity: readParticipantIdentity(row.identity_namespace, row.actor_id),
            contributionCount: row.contribution_count,
            firstPromptedAt: row.first_prompted_at,
            lastPromptedAt: row.last_prompted_at,
          })),
        ]),
      ),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : new Map();
}
