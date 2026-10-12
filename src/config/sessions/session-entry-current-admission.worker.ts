import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
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
  readSessionEntryByIdInDatabase,
  readSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
import { createSessionEntryRevisionGuard } from "./session-accessor.sqlite-entry-revision.js";
import {
  assertCanonicalSessionKeyWrite,
  readWithCanonicalSessionAdmission,
} from "./session-canonical-key.js";
import { projectSessionEntryCapabilityFacts } from "./session-entry-capability-facts.js";
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
    sessionIdLookup?: string;
    projection?: "capability";
    read: () => SessionEntryCurrentFacts | undefined;
  }
>();

function createCurrentEntryRead(
  database: OpenClawAgentReadOnlyDatabase,
  sessionKey: string,
  lookup: "exact" | "logical",
  options: Pick<SessionEntryCurrentSource, "sessionIdLookup" | "projection">,
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
        options.sessionIdLookup !== undefined
          ? readSessionEntryByIdInDatabase(database, {
              sessionId: options.sessionIdLookup,
              projection: "list",
            })?.entry
          : lookup === "logical"
            ? readSessionEntryRow(database, sessionKey, "list")?.entry
            : readExactSessionEntryRow(database, sessionKey, "list", "canonical")?.entry;
      if (!current || options.projection === "capability") {
        entry = current ? projectSessionEntryCapabilityFacts(current) : undefined;
        return true;
      }
      entry = {
        sessionId: current.sessionId,
        previousSessionId: current.previousSessionId,
        ...(current.archivedAt === undefined ? {} : { archivedAt: current.archivedAt }),
        ...(current.repositoryWorkspaceId === undefined
          ? {}
          : { repositoryWorkspaceId: current.repositoryWorkspaceId }),
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
      };
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
  options: Pick<SessionEntryCurrentSource, "sessionIdLookup" | "projection"> = {},
): SessionEntryCurrentFacts | undefined {
  assertCanonicalSessionKeyWrite(sessionKey);
  let cached = currentEntryReads.get(database.db);
  if (
    cached?.sessionKey !== sessionKey ||
    cached.lookup !== lookup ||
    cached.sessionIdLookup !== options.sessionIdLookup ||
    cached.projection !== options.projection
  ) {
    cached = {
      sessionKey,
      lookup,
      ...options,
      read: createCurrentEntryRead(database, sessionKey, lookup, options),
    };
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
    const entry = readSessionEntryCurrentFactsInDatabase(
      database,
      source.sessionKey,
      options.lookup,
      source,
    );
    const facts: SessionEntryCurrentAdmissionFacts = {
      kind: "session-entry-current",
      source,
      entry,
      domainFacts: request.facts,
    };
    requestAdmission({ ...request, facts });
    assertSessionEntryCurrentNativeSource(source, database);
    // A writer receipt invalidates cached facts, not necessarily this session's ownership.
    if (
      !isDeepStrictEqual(
        entry,
        readSessionEntryCurrentFactsInDatabase(database, source.sessionKey, options.lookup, source),
      )
    ) {
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

/** Keep every original source live through the common grant and recheck each after it settles. */
export function requestSessionEntriesCurrentAdmission(
  sources: readonly SessionEntryCurrentSource[] | undefined,
  request: SqliteWorkerAdmissionRequest,
): void {
  const enter = (index: number, current: SqliteWorkerAdmissionRequest): void => {
    const source = sources?.[index];
    if (!source) {
      requestSqliteWorkerOperationAdmission(current);
      return;
    }
    requestSessionEntryCurrentAdmission(source, current, {}, (next) => enter(index + 1, next));
  };
  enter(0, request);
}
