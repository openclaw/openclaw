import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { sqlitePrimaryResultCode } from "../../infra/sqlite-error-diagnostics.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import {
  classifyOpenClawAgentDatabaseReadError,
  isOpenClawAgentDatabaseReadOpenFailure,
} from "../../state/openclaw-agent-db-read-error.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../../state/openclaw-agent-db-readonly-scope.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  captureMemoryExactSessionReader,
  assertMemoryExactReadSource,
} from "./session-accessor.memory-exact-read.js";
import type {
  ExactSessionEntry,
  SessionAccessScope,
  SessionTranscriptReadScope,
} from "./session-accessor.sqlite-contract.js";
import {
  readSessionEntryByIdInDatabase,
  readSessionKeyBySessionIdInDatabase,
  readExactSessionEntryRow,
  readSessionEntrySelectionInDatabase,
} from "./session-accessor.sqlite-entry-read.js";
import {
  resolveSqliteScope,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionEntryListScope, SessionEntryReadScope } from "./session-accessor.types.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  readWithCanonicalSessionReaderContinuation,
  type CanonicalSessionReaderContinuation,
} from "./session-canonical-key.js";
import { SessionCanonicalKeyMigrationRequiredError } from "./session-canonical-row.js";
import { assertCapturedSessionEntryReadSource } from "./session-entry-read-source.js";
import type {
  CapturedSessionEntryReadSource,
  SessionEntryReadSource,
} from "./session-entry-read-source.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Loads one session entry from the additive SQLite session store. */
export function loadSessionEntry(scope: SessionAccessScope): SessionEntry | undefined {
  return resolveSessionEntry(scope).existing;
}

/** Loads one session entry without opening its agent database writable. */
export function loadSessionEntryReadOnly(scope: SessionEntryReadScope): SessionEntry | undefined {
  return resolveSessionEntry(scope, { readOnly: true, projection: scope.projection }).existing;
}

/** Reuse one reader during synchronous entry work; each read keeps its current admission. */
export function withSessionEntryReadOnlyScope<T>(
  scope: Pick<SessionEntryListScope, "agentId" | "defaultAgentId" | "env" | "storePath">,
  operation: () => T,
): T {
  if (getSessionActorStorageBinding(scope)) {
    return operation();
  }
  const options = toDatabaseOptions(resolveSqliteScope({ ...scope, sessionKey: "" }));
  const reader = new OpenClawAgentDatabaseReadOnlyScope();
  try {
    return reader.run(
      { agentId: options.agentId, path: resolveOpenClawAgentSqlitePath(options) },
      operation,
    );
  } finally {
    reader.close();
  }
}

/** Resolves the persisted session key for a SQLite transcript session id. */
export function resolveSessionKeyBySessionId(
  scope: Pick<SessionTranscriptReadScope, "agentId" | "env" | "sessionId" | "storePath">,
): string | undefined {
  const memory = getSessionActorStorageBinding(scope);
  if (memory) {
    return memory.actor.storage!.readCurrent(
      { type: "session.entry.readById", input: { sessionId: scope.sessionId } },
      memory.authority,
    )?.sessionKey;
  }
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => readSessionKeyBySessionIdInDatabase(database, resolved.sessionId),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : undefined;
}

type ResolvedSqliteSessionEntry = {
  existing: SessionEntry | undefined;
  legacyKeys: string[];
  normalizedKey: string;
};

type SessionEntryFactReader = (
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  sessionKey: string,
  projection: SessionEntryReadScope["projection"],
) => SessionEntry | undefined;

/** Private prepared reads must reject a different physical owner at the captured path. */
export function loadSessionEntryReadOnlyInScope(
  scope: SessionEntryReadScope & { databaseAgentId: string },
): SessionEntry | undefined {
  return resolveSessionEntry(scope, {
    readOnly: true,
    databaseAgentId: scope.databaseAgentId,
    projection: scope.projection,
  }).existing;
}

/** Resolves one exact canonical entry without materializing the store. */
export function resolveSessionEntry(
  scope: SessionAccessScope,
  options: {
    readOnly?: boolean;
    keyFormat?: "agent-qualified";
    allowCanonicalMove?: boolean;
    databaseAgentId?: string;
    projection?: SessionEntryReadScope["projection"];
    continuation?: CanonicalSessionReaderContinuation;
    onReadSource?: (source: CapturedSessionEntryReadSource) => void;
    onReadError?: (error: unknown, database: OpenClawAgentDatabase["db"]) => never;
    readFacts?: SessionEntryFactReader;
    capturedDatabase?: Parameters<SessionEntryFactReader>[0];
  } = {},
): ResolvedSqliteSessionEntry {
  const memory = captureMemoryExactSessionReader({
    ...scope,
    agentId: options.databaseAgentId ?? scope.agentId,
  });
  if (memory) {
    const normalizedKey = scope.sessionKey.trim();
    const existing = memory.read(normalizedKey, options.readOnly ? options.projection : "full");
    if (memory.source) {
      options.onReadSource?.(memory.source);
    }
    return { existing, legacyKeys: [], normalizedKey };
  }
  // A prepared reader retains its physical locator; rediscovery would escape that custody.
  const resolved =
    options.databaseAgentId && scope.storePath
      ? {
          ...resolveSqliteScope({
            ...scope,
            agentId:
              scope.agentId ??
              parseAgentSessionKey(scope.sessionKey)?.agentId ??
              options.databaseAgentId,
            storePath: undefined,
          }),
          path: scope.storePath,
          databaseAgentId: options.databaseAgentId,
        }
      : resolveSqliteScope(scope);
  if (options.databaseAgentId) {
    resolved.databaseAgentId = options.databaseAgentId;
  }
  const read = (
    database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  ): ResolvedSqliteSessionEntry => {
    let selected: { entry: SessionEntry | null; row: { session_key: string } } | undefined;
    let failure: { error: unknown } | undefined;
    if (options.onReadError && !options.readFacts) {
      try {
        // Let the admission owner's snapshot-required control exception reach that owner.
        assertCanonicalSqliteSessionKeysCurrent(database);
      } catch (error) {
        if (!(error instanceof SessionCanonicalKeyMigrationRequiredError)) {
          throw error;
        }
        failure = { error };
      }
    }
    if (!failure) {
      try {
        const projection = options.readOnly ? options.projection : "full";
        if (options.readFacts) {
          const entry = options.readFacts(database, resolved.sessionKey, projection);
          selected = entry ? { entry, row: { session_key: resolved.sessionKey } } : undefined;
        } else {
          selected = readSessionEntrySelectionInDatabase(
            database,
            resolved.agentId,
            resolved.sessionKey,
            {
              keyFormat: options.keyFormat,
              allowCanonicalMove: options.allowCanonicalMove,
              projection,
            },
          );
        }
      } catch (error) {
        if (!options.onReadError) {
          throw error;
        }
        failure = { error };
      }
    }
    if (options.onReadSource) {
      const source = readOpenClawAgentDatabaseIdentity(database);
      if (!isOpenClawAgentDatabasePathCurrent(database)) {
        throw new Error("Session database physical identity changed during read");
      }
      options.onReadSource({
        agentId: database.agentId,
        path: database.path,
        databaseIdentity: source.identity,
        databaseBirthtime: source.birthtime,
      });
    }
    if (failure) {
      // Throw through the snapshot owner so its rollback still precedes an ordinary read result.
      options.onReadError!(failure.error, database.db);
    }
    return {
      existing: selected?.entry ?? undefined,
      legacyKeys: [],
      normalizedKey: selected?.row.session_key ?? resolved.sessionKey,
    };
  };
  if (options.readOnly) {
    const readOnly = (database: Parameters<SessionEntryFactReader>[0]) =>
      options.readFacts
        ? read(database)
        : readWithCanonicalSessionReaderContinuation(database, options.continuation, () =>
            read(database),
          );
    if (options.capturedDatabase) {
      return readOnly(options.capturedDatabase);
    }
    const result = withOpenClawAgentDatabaseReadOnly(readOnly, toDatabaseOptions(resolved));
    return result.found
      ? result.value
      : { existing: undefined, legacyKeys: [], normalizedKey: resolved.sessionKey };
  }
  return read(openOpenClawAgentDatabase(toDatabaseOptions(resolved)));
}

class SessionEntryDataReadError extends Error {
  readonly readError: unknown;

  constructor(
    readError: unknown,
    readonly database: OpenClawAgentDatabase["db"],
  ) {
    const classified =
      sqlitePrimaryResultCode(readError) === 1
        ? classifyOpenClawAgentDatabaseReadError(database, readError)
        : readError;
    super("Session entry data read failed", { cause: classified });
    this.readError = classified;
  }

  assertSettled(): void {
    assertTransactionUsable(this.database);
    // A disposable readonly owner may have closed normally after a successful rollback.
    if (this.database.isOpen && this.database.isTransaction) {
      throw this.readError;
    }
  }
}

/** Unreadable stores and rows become data; authority, source checks and cleanup still throw. */
export function loadSessionEntryReadOnlyResultInScope(
  scope: SessionEntryReadScope & { databaseAgentId?: string },
  continuation?: CanonicalSessionReaderContinuation,
  onReadSource?: (source: CapturedSessionEntryReadSource) => void,
  readFacts?: SessionEntryFactReader,
  capturedDatabase?: Parameters<SessionEntryFactReader>[0],
): Result<SessionEntry | undefined, unknown> {
  try {
    return ok(
      resolveSessionEntry(scope, {
        readOnly: true,
        databaseAgentId: scope.databaseAgentId,
        projection: scope.projection,
        continuation,
        onReadSource,
        readFacts,
        capturedDatabase,
        onReadError(error, database) {
          throw new SessionEntryDataReadError(error, database);
        },
      }).existing,
    );
  } catch (error) {
    if (error instanceof SessionEntryDataReadError) {
      // Failed rollback can preserve the original exception while poisoning/closing its handle.
      error.assertSettled();
      return err(error.readError);
    }
    if (isOpenClawAgentDatabaseReadOpenFailure(error)) {
      return err(error);
    }
    throw error;
  }
}

type PhysicalSessionEntryReadScope = {
  env?: NodeJS.ProcessEnv;
  readSource: SessionEntryReadSource;
  projection?: SessionEntryReadScope["projection"];
};

/** Loads one exact persisted-key entry from the additive SQLite session store. */
export function loadExactSessionEntry(scope: SessionEntryReadScope): ExactSessionEntry | undefined {
  return loadExactSessionEntryCandidates({
    ...scope,
    sessionKeys: [scope.sessionKey],
    readOnly: false,
  })[0];
}

/** Reads exact candidates for one logical session through a single store admission. */
export function loadExactSessionEntryCandidates(
  scope: (
    | (Omit<SessionEntryReadScope, "sessionKey" | "projection"> & { readOnly: boolean })
    | (Omit<PhysicalSessionEntryReadScope, "projection"> & { readOnly: true })
  ) & {
    sessionKeys: readonly string[];
    projection?: SessionEntryReadScope["projection"];
    onReadSource?: (source: CapturedSessionEntryReadSource) => void;
    expectedSource?: CapturedSessionEntryReadSource;
  },
): ExactSessionEntry[] {
  const sessionKeys = scope.sessionKeys.map((key) => key.trim()).filter(Boolean);
  const [sessionKey] = sessionKeys;
  if (!sessionKey) {
    return [];
  }
  const memory = captureMemoryExactSessionReader(
    "readSource" in scope
      ? { agentId: scope.readSource.agentId, storePath: scope.readSource.path, sessionKey }
      : { ...scope, sessionKey },
  );
  if (memory) {
    assertMemoryExactReadSource(scope.expectedSource, memory.source);
    const entries = sessionKeys.flatMap((key) => {
      const entry = memory.read(key, scope.projection);
      if (!entry) {
        return [];
      }
      return [{ sessionKey: key, entry }];
    });
    if (memory.source) {
      scope.onReadSource?.(memory.source);
    }
    return entries;
  }
  const options =
    "readSource" in scope
      ? {
          agentId: scope.readSource.agentId,
          path: scope.readSource.path,
          ...(scope.env ? { env: scope.env } : {}),
        }
      : toDatabaseOptions(resolveSqliteScope({ ...scope, sessionKey }));
  const read = (database: Pick<OpenClawAgentDatabase, "agentId" | "path" | "db">) => {
    const physical = readOpenClawAgentDatabaseIdentity(database);
    if (scope.expectedSource) {
      assertCapturedSessionEntryReadSource(scope.expectedSource, database);
    }
    const projection = scope.projection;
    const entries = sessionKeys.flatMap((key) => {
      const entry = readExactSessionEntryRow(database, key, projection, "canonical")?.entry;
      return entry ? [{ sessionKey: key, entry }] : [];
    });
    scope.onReadSource?.({
      agentId: database.agentId,
      path: database.path,
      databaseIdentity: physical.identity,
      databaseBirthtime: physical.birthtime,
    });
    return entries;
  };
  if (!scope.readOnly) {
    return read(openOpenClawAgentDatabase(options));
  }
  const result = withOpenClawAgentDatabaseReadOnly(read, options);
  return result.found ? result.value : [];
}

/** Loads a visible current ID, falling back to legacy trimmed IDs only on an exact miss. */
export function loadSessionEntryByIdReadOnly(
  scope: Omit<SessionEntryReadScope, "sessionKey"> & {
    sessionId: string;
    orderBy?: "updatedAt";
  },
): ExactSessionEntry | undefined {
  const memory = captureMemoryExactSessionReader(scope);
  if (memory) {
    const entries = memory
      .entries("list")
      .toSorted(
        (left, right) =>
          (scope.orderBy === "updatedAt" ? right.entry.updatedAt - left.entry.updatedAt : 0) ||
          (left.sessionKey < right.sessionKey ? -1 : left.sessionKey > right.sessionKey ? 1 : 0),
      );
    const selected =
      (scope.orderBy
        ? undefined
        : entries.find(({ entry }) => entry.sessionId === scope.sessionId)) ??
      entries.find(({ entry }) => entry.sessionId.trim() === scope.sessionId);
    if (!selected) {
      return undefined;
    }
    const entry = memory.read(selected.sessionKey, scope.projection);
    return entry ? { sessionKey: selected.sessionKey, entry } : undefined;
  }
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => readSessionEntryByIdInDatabase(database, scope),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : undefined;
}

/** Exact persisted-key probe on the read-only handle, for per-row hot paths. */
export function loadExactSessionEntryReadOnly(
  scope: SessionEntryReadScope,
): ExactSessionEntry | undefined {
  return loadExactSessionEntryCandidates({
    ...scope,
    sessionKeys: [scope.sessionKey],
    readOnly: true,
  })[0];
}

/** Probe the selected store without rerouting an incognito-shaped key to ephemeral state. */
export function loadExactSessionEntryFromStoreReadOnly(
  scope: SessionEntryReadScope & { storePath: string },
): ExactSessionEntry | undefined {
  const memory = captureMemoryExactSessionReader(scope);
  if (memory) {
    const entry = memory.read(scope.sessionKey, scope.projection);
    return entry ? { sessionKey: scope.sessionKey, entry } : undefined;
  }
  const options = toDatabaseOptions(resolveSqliteScope({ ...scope, sessionKey: "" }));
  return loadExactSessionEntryCandidates({
    readSource: { ...options, path: resolveOpenClawAgentSqlitePath(options) },
    projection: scope.projection,
    readOnly: true,
    sessionKeys: [scope.sessionKey],
  })[0];
}
