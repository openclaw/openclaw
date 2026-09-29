import type { DatabaseSync } from "node:sqlite";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import {
  requestSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "../../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import {
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import {
  readExactSessionEntryRow,
  readSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
import {
  cacheValidityTokensEqual,
  createSessionEntryRevisionGuard,
  readSessionEntryCacheValidityToken,
} from "./session-accessor.sqlite-entry-revision.js";
import {
  assertCanonicalSessionKeyWrite,
  readWithCanonicalSessionAdmission,
} from "./session-canonical-key.js";
import type {
  SessionEntryCurrentAdmissionFacts,
  SessionEntryCurrentFacts,
  SessionEntryCurrentSource,
} from "./session-entry-current.types.js";

// One last-key/read-policy projection per native handle; the revision owner invalidates its facts.
const currentEntryReads = new WeakMap<
  DatabaseSync,
  {
    sessionKey: string;
    lookup: "exact" | "logical";
    read: () => SessionEntryCurrentFacts | undefined;
  }
>();

function createCurrentEntryRead(
  database: OpenClawAgentReadOnlyDatabase,
  sessionKey: string,
  lookup: "exact" | "logical",
) {
  let entry: SessionEntryCurrentFacts | undefined;
  const guard = createSessionEntryRevisionGuard(
    database.db,
    () => {
      if (!database.db.isOpen || !isOpenClawAgentDatabasePathCurrent(database)) {
        throw new Error("Session currency read lost its native source");
      }
    },
    () => {
      const current =
        lookup === "logical"
          ? readSessionEntryRow(database, sessionKey, "full")?.entry
          : readExactSessionEntryRow(database, sessionKey, "list", "canonical")?.entry;
      entry = current
        ? {
            sessionId: current.sessionId,
            lifecycleRevision: current.lifecycleRevision,
            lifecycleRunId: current.lifecycleRunId,
            activeWriterRunId: current.activeWriterRunId,
            ...(current.subagentRecovery
              ? {
                  subagentRecovery: {
                    lastRunId: current.subagentRecovery.lastRunId,
                    sessionLifecycleRunId: current.subagentRecovery.sessionLifecycleRunId,
                  },
                }
              : {}),
          }
        : undefined;
      return true;
    },
  );
  return () => {
    guard();
    return entry;
  };
}

export function readSessionEntryCurrentFactsInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  sessionKey: string,
  lookup: "exact" | "logical" = "exact",
): SessionEntryCurrentFacts | undefined {
  assertCanonicalSessionKeyWrite(sessionKey);
  let cached = currentEntryReads.get(database.db);
  if (cached?.sessionKey !== sessionKey || cached.lookup !== lookup) {
    cached = { sessionKey, lookup, read: createCurrentEntryRead(database, sessionKey, lookup) };
    currentEntryReads.set(database.db, cached);
  }
  return readWithCanonicalSessionAdmission(database, cached.read);
}

export function assertSessionEntryCurrentNativeSource(
  source: SessionEntryCurrentSource,
  database?: OpenClawAgentReadOnlyDatabase,
): void {
  assertExistingDatabaseIdentity(
    source.path,
    `file:${source.databaseIdentity}`,
    source.databaseBirthtime,
  );
  if (database) {
    const identity = readOpenClawAgentDatabaseIdentity(database);
    if (
      database.agentId !== source.agentId ||
      database.path !== source.path ||
      identity.identity !== source.databaseIdentity ||
      identity.birthtime !== source.databaseBirthtime ||
      !isOpenClawAgentDatabasePathCurrent(database)
    ) {
      throw new Error("Session currency native owner differs from its captured source");
    }
  }
}

/** Native facts constrain the existing synchronous grant; no read snapshot outlives the request. */
export function requestSessionEntryCurrentAdmission(
  source: SessionEntryCurrentSource | undefined,
  request: SqliteWorkerAdmissionRequest,
  options: { database?: OpenClawAgentReadOnlyDatabase; lookup?: "exact" | "logical" } = {},
  requestAdmission = requestSqliteWorkerOperationAdmission,
): void {
  if (!source) {
    requestAdmission(request);
    return;
  }
  assertSessionEntryCurrentNativeSource(source);
  const admit = (database: OpenClawAgentReadOnlyDatabase) => {
    assertSessionEntryCurrentNativeSource(source, database);
    const before = readSessionEntryCacheValidityToken(database.db);
    const entry = readSessionEntryCurrentFactsInDatabase(
      database,
      source.sessionKey,
      options.lookup,
    );
    const afterRead = readSessionEntryCacheValidityToken(database.db);
    if (!cacheValidityTokensEqual(before, afterRead)) {
      throw new Error("Session currency changed during native admission preparation");
    }
    const facts: SessionEntryCurrentAdmissionFacts = {
      kind: "session-entry-current",
      source,
      entry,
      domainFacts: request.facts,
    };
    requestAdmission({ ...request, facts });
    assertSessionEntryCurrentNativeSource(source, database);
    if (!cacheValidityTokensEqual(afterRead, readSessionEntryCacheValidityToken(database.db))) {
      throw new Error("Session currency changed while awaiting its native grant");
    }
  };
  if (options.database?.path === source.path) {
    admit(options.database);
    return;
  }
  const read = withOpenClawAgentDatabaseReadOnly(admit, {
    agentId: source.agentId,
    path: source.path,
    env: getSqliteWorkerStateContext().environment,
  });
  if (!read.found) {
    throw new Error("Session currency native source is unavailable");
  }
}
