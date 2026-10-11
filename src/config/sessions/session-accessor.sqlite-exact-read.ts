import { expectDefined } from "@openclaw/normalization-core/expect";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { executeSqliteQueryTakeFirstSync, sqliteStringSet } from "../../infra/kysely-sync.js";
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
import {
  retainOpenClawAgentDatabaseReadOnly,
  withOpenClawAgentDatabaseReadOnly,
} from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { SessionMetadataUnavailableError } from "../../state/session-metadata-unavailable-error.js";
import {
  captureMemoryExactSessionReader,
  assertMemoryExactReadSource,
} from "./session-accessor.memory-exact-read.js";
import type { ExactSessionEntry, SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { readExactSessionEntryCandidatesInDatabase } from "./session-accessor.sqlite-entry-cache.js";
import {
  readSessionEntryByIdInDatabase,
  readExactSessionEntryRow,
  readSessionEntryRow,
  readQualifiedSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
  type SessionSqliteTargetResolutionCache,
} from "./session-accessor.sqlite-scope.js";
import { readSessionWorktreeOwnerFactsInDatabase } from "./session-accessor.sqlite-worktree-owner.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  readWithCanonicalSessionAdmission,
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
          selected =
            options.keyFormat === "agent-qualified"
              ? readQualifiedSessionEntryRow(database, resolved.agentId, resolved.sessionKey, {
                  allowCanonicalMove: options.allowCanonicalMove,
                  projection,
                })
              : readSessionEntryRow(database, resolved.sessionKey, projection);
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

/** Retained windows occupy a key even when they have no current readable entry. */
export function retainSessionEntryKeyAbsence(params: {
  source: CapturedSessionEntryReadSource;
  sessionKeys: readonly string[];
  canonicalKey: string;
  env?: NodeJS.ProcessEnv;
}) {
  const capturedSource = params.source;
  const memory = captureMemoryExactSessionReader({
    agentId: capturedSource.agentId,
    storePath: capturedSource.path,
  });
  if (memory) {
    assertMemoryExactReadSource(capturedSource, memory.source);
    if (params.sessionKeys.some((key) => memory.read(key, "list"))) {
      throw new Error(
        `Session "${params.canonicalKey}" has ambiguous stored identity. Select an unambiguous session; stored rows and history were not changed.`,
      );
    }
    return { assertCurrent: memory.assertCurrent, release() {} };
  }
  const source = retainOpenClawAgentDatabaseReadOnly({
    agentId: capturedSource.agentId,
    path: capturedSource.path,
    env: params.env,
  });
  if (!source.found) {
    throw new Error("Captured session database is unavailable");
  }
  const assertSourceCurrent = () => {
    source.claim.assertCurrent();
    assertCapturedSessionEntryReadSource(capturedSource, source.database);
  };
  const assertCurrent = () => {
    assertSourceCurrent();
    if (!params.sessionKeys.length) {
      return;
    }
    const occupied = executeSqliteQueryTakeFirstSync(
      source.database.db,
      getSessionKysely(source.database.db)
        .selectFrom("session_nodes")
        .select("session_key")
        .where("session_key", "in", sqliteStringSet(params.sessionKeys))
        .limit(1),
    );
    assertSourceCurrent();
    if (occupied) {
      throw new Error(
        `Session "${params.canonicalKey}" has ambiguous stored identity. Select an unambiguous session; stored rows and history were not changed.`,
      );
    }
  };
  try {
    assertCurrent();
    return { assertCurrent, release: source.claim.release };
  } catch (error) {
    source.claim.release();
    throw error;
  }
}

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
    projection?: SessionEntryReadScope["projection"] | "worktree";
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
      const entry = memory.read(key, scope.projection === "worktree" ? "list" : scope.projection);
      if (!entry) {
        return [];
      }
      if (scope.projection !== "worktree") {
        return [{ sessionKey: key, entry }];
      }
      const { sessionId, updatedAt, archivedAt, lastInteractionAt, lifecycleRevision, worktree } =
        entry;
      return [
        {
          sessionKey: key,
          entry: {
            sessionId,
            updatedAt,
            ...(archivedAt === undefined ? {} : { archivedAt }),
            ...(lastInteractionAt === undefined ? {} : { lastInteractionAt }),
            ...(lifecycleRevision === undefined ? {} : { lifecycleRevision }),
            ...(worktree === undefined ? {} : { worktree }),
          },
        },
      ];
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
    const entries =
      projection === "worktree"
        ? readSessionWorktreeOwnerFactsInDatabase(database, sessionKeys)
        : sessionKeys.flatMap((key) => {
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
  if (scope.projection === "worktree" && !result.found && result.reason !== "database-missing") {
    throw new SessionMetadataUnavailableError(result.reason);
  }
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

/** Read requested keys through synchronous store/projection groups. */
export type ExactSessionEntryBatchScope = Omit<
  SessionEntryReadScope,
  "sessionKey" | "projection"
> & {
  projection?: SessionEntryReadScope["projection"] | "delivery";
  sessionKeys: readonly string[];
  onReadSource?: (source: SessionEntryReadSource) => void;
};

export function loadExactSessionEntryCandidatesReadOnlyBatch(
  scopes: readonly ExactSessionEntryBatchScope[],
): Array<Result<ExactSessionEntry[], unknown>> {
  const results: Array<Result<ExactSessionEntry[], unknown> | undefined> = [];
  const targetCache: SessionSqliteTargetResolutionCache = new Map();
  const groups = new Map<
    string,
    {
      options: OpenClawAgentDatabaseOptions;
      projection: ExactSessionEntryBatchScope["projection"];
      clone: boolean;
      requests: Array<{ index: number; sessionKeys: string[] }>;
    }
  >();
  for (const [index, scope] of scopes.entries()) {
    const sessionKeys = scope.sessionKeys.map((key) => key.trim()).filter(Boolean);
    const [sessionKey] = sessionKeys;
    if (!sessionKey) {
      results[index] = ok([]);
      continue;
    }
    try {
      const memory = captureMemoryExactSessionReader({ ...scope, sessionKey });
      if (memory) {
        results[index] = ok(
          sessionKeys.flatMap((key) => {
            const entry = memory.read(
              key,
              scope.projection === "delivery" ? "list" : scope.projection,
            );
            if (!entry) {
              return [];
            }
            if (scope.projection !== "delivery") {
              return [{ sessionKey: key, entry }];
            }
            const { sessionId, updatedAt, delivery, groupId } = entry;
            return [{ sessionKey: key, entry: { sessionId, updatedAt, delivery, groupId } }];
          }),
        );
        if (memory.source) {
          scope.onReadSource?.(memory.source);
        }
        continue;
      }
      const options = toDatabaseOptions(resolveSqliteScope({ ...scope, sessionKey }, targetCache));
      const groupKey = [
        options.agentId,
        resolveOpenClawAgentSqlitePath(options),
        scope.projection ?? "full",
        scope.clone !== false,
      ].join("\u0000");
      const group = groups.get(groupKey) ?? {
        options,
        projection: scope.projection,
        clone: scope.clone !== false,
        requests: [],
      };
      group.requests.push({ index, sessionKeys });
      groups.set(groupKey, group);
    } catch (error) {
      results[index] = err(error);
    }
  }
  for (const group of groups.values()) {
    try {
      const read = withOpenClawAgentDatabaseReadOnly(
        (database) =>
          readWithCanonicalSessionAdmission(database, () => {
            try {
              // Admission failures affect this store; an invalid requested row must not
              // suppress healthy logical targets after a warm handle was validated.
              assertCanonicalSqliteSessionKeysCurrent(database);
              const source = { agentId: database.agentId, path: database.path };
              const grouped = readExactSessionEntryCandidatesInDatabase(
                database,
                group.requests.map((request) => request.sessionKeys),
                group.projection,
                { clone: group.clone },
              );
              for (const [ordinal, request] of group.requests.entries()) {
                const result = grouped[ordinal]!;
                results[request.index] = result;
                if (result.ok) {
                  scopes[request.index]!.onReadSource?.(source);
                }
              }
            } catch (error) {
              if (sqlitePrimaryResultCode(error) === 1) {
                // Preserve failed-snapshot schema facts before the admission owner rolls back.
                throw new SessionEntryDataReadError(error, database.db);
              }
              throw error;
            }
          }),
        group.options,
      );
      if (!read.found) {
        if (read.reason !== "database-missing") {
          throw new SessionMetadataUnavailableError(read.reason);
        }
        for (const { index } of group.requests) {
          results[index] = ok([]);
        }
      }
    } catch (error) {
      let readError = error;
      if (error instanceof SessionEntryDataReadError) {
        error.assertSettled();
        readError = error.readError;
      }
      for (const { index } of group.requests) {
        results[index] = err(readError);
      }
    }
  }
  return scopes.map((_, index) => expectDefined(results[index], "exact session batch read result"));
}
