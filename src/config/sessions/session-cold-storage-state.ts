import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import {
  readSqliteDatabaseScopedWriteToken,
  sqliteSessionIdWriteScope,
} from "../../infra/sqlite-database-admission.js";
import {
  getSqliteReadScopeRevision,
  hasUncommittedSqliteWrites,
  runSqliteReadOperationSync,
  type SqliteReadScopeRevision,
} from "../../infra/sqlite-schema-facts.js";
import {
  assertTransactionUsable,
  runSqliteDeferredTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import { readTranscriptContextFacts } from "./session-transcript-context-facts.js";

export type SessionColdArchive = Selectable<DB["session_transcript_cold_archives"]>;

type SessionColdFact = {
  cold: boolean;
  revision?: SqliteReadScopeRevision;
  token?: string;
};

export const sessionColdArchiveMetadataColumns = [
  "session_id",
  "generation",
  "archive_name",
  "archive_sha256",
  "event_count",
  "raw_bytes",
  "archive_bytes",
  "last_seq",
  "archived_at",
  "storage",
] as const;

function createColdTranscriptQueries(db: DatabaseSync) {
  const kysely = getNodeSqliteKysely<DB>(db);
  return {
    facts: new Map<string, SessionColdFact>(),
    metadata: prepareSqliteQuerySync<string, Omit<SessionColdArchive, "archive_blob">>(
      db,
      (parameter) =>
        kysely
          .selectFrom("session_transcript_cold_archives")
          .select(sessionColdArchiveMetadataColumns)
          .where(
            "session_id",
            "=",
            parameter((sessionId) => sessionId),
          ),
    ),
    marker: prepareSqliteQuerySync<string, { session_id: string }>(db, (parameter) =>
      kysely
        .selectFrom("session_transcript_cold_archives")
        .select("session_id")
        .where(
          "session_id",
          "=",
          parameter((sessionId) => sessionId),
        ),
    ),
  };
}

const getColdTranscriptQueries = createSqliteQueryCache(createColdTranscriptQueries);

function retainColdFact(db: DatabaseSync, sessionId: string, fact: SessionColdFact): void {
  const facts = getColdTranscriptQueries(db).facts;
  facts.delete(sessionId);
  facts.set(sessionId, fact);
  pruneMapToMaxSize(facts, 128);
}

function readSessionTranscriptCold(db: DatabaseSync, sessionId: string): boolean {
  return runSqliteReadOperationSync(db, () => {
    const queries = getColdTranscriptQueries(db);
    const revision = getSqliteReadScopeRevision(db);
    const token =
      revision !== undefined && revision.snapshot === undefined && !db.isTransaction
        ? readSqliteDatabaseScopedWriteToken(db, [sqliteSessionIdWriteScope(sessionId)])
        : undefined;
    const retained = queries.facts.get(sessionId);
    if (
      retained &&
      ((revision !== undefined && retained.revision === revision) ||
        (token !== undefined && retained.token === token))
    ) {
      return retained.cold;
    }
    const cold = queries.marker(sessionId).rows.length > 0;
    if (revision) {
      retainColdFact(db, sessionId, { cold, revision, token });
    }
    return cold;
  });
}

export function readSessionColdTranscript(
  db: DatabaseSync,
  sessionId: string,
): Omit<SessionColdArchive, "archive_blob"> | undefined {
  const actor = readSessionActorTransactionState({ db }, { sessionId });
  if (actor) {
    return actor.transcript.coldArchive && { ...actor.transcript.coldArchive };
  }
  return getColdTranscriptQueries(db).metadata(sessionId).rows[0];
}

export class SessionTranscriptColdError extends Error {
  readonly code = "TRANSCRIPT_COLD";
  constructor(readonly sessionId: string) {
    super(
      `Transcript ${sessionId} is in cold storage. Restore its archive before reading or changing the transcript.`,
    );
    this.name = "SessionTranscriptColdError";
  }
}

export function assertSessionTranscriptHot(db: DatabaseSync, sessionId: string): void {
  const actor = readSessionActorTransactionState({ db }, { sessionId });
  if (actor) {
    if (actor.transcript.coldArchive) {
      throw new SessionTranscriptColdError(sessionId);
    }
    return;
  }
  const context = readTranscriptContextFacts({ db }, sessionId);
  if (context?.cold === false) {
    return;
  }
  if (context?.cold || readSessionTranscriptCold(db, sessionId)) {
    throw new SessionTranscriptColdError(sessionId);
  }
}

/** The snapshot owner carries committed cold facts between read-only pages. */
export function readHotSessionTranscriptSnapshot<T>(
  database: { db: DatabaseSync },
  sessionId: string,
  purpose:
    | "identity"
    | "header"
    | "tail"
    | "incremental"
    | "checkpoint"
    | "events"
    | "raw rows"
    | "storage rows"
    | "presence"
    | "match",
  read: () => T,
): T {
  const { db } = database;
  if (db.isTransaction) {
    assertTransactionUsable(db);
    const result = runSqliteReadOperationSync(db, () => {
      assertSessionTranscriptHot(db, sessionId);
      return read();
    });
    assertTransactionUsable(db);
    return result;
  }
  const token = hasUncommittedSqliteWrites(db)
    ? undefined
    : readSqliteDatabaseScopedWriteToken(db, [sqliteSessionIdWriteScope(sessionId)]);
  const retained = getColdTranscriptQueries(db).facts.get(sessionId);
  const result = runSqliteDeferredTransactionSync(
    db,
    () => {
      if (token !== undefined && retained?.token === token) {
        if (retained.cold) {
          throw new SessionTranscriptColdError(sessionId);
        }
      } else {
        assertSessionTranscriptHot(db, sessionId);
      }
      return read();
    },
    { operationLabel: `session transcript ${purpose} read` },
  );
  // Keep the pre-BEGIN receipt: a concurrent archive retires it even if this
  // snapshot still read hot rows. Existing caller-owned snapshots never promote.
  if (token !== undefined) {
    retainColdFact(db, sessionId, { cold: false, token });
  }
  return result;
}
