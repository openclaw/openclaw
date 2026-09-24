import { expectDefined } from "@openclaw/normalization-core/expect";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { sqlitePrimaryResultCode } from "../../infra/sqlite-error-diagnostics.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import { classifyOpenClawAgentDatabaseReadError } from "../../state/openclaw-agent-db-read-error.js";
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
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import type { ExactSessionEntry, SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { readExactSessionEntryCandidatesInDatabase } from "./session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRowValidated,
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
import type {
  CapturedSessionEntryReadSource,
  SessionEntryReadScope,
  SessionEntryReadSource,
} from "./session-accessor.types.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  readWithCanonicalSessionAdmission,
  readWithCanonicalSessionReaderContinuation,
  type CanonicalSessionReaderContinuation,
} from "./session-canonical-key.js";
import { SessionCanonicalKeyMigrationRequiredError } from "./session-canonical-row.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type ResolvedSqliteSessionEntry = {
  existing: SessionEntry | undefined;
  legacyKeys: string[];
  normalizedKey: string;
};

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
  } = {},
): ResolvedSqliteSessionEntry {
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
    let selected: ReturnType<typeof readQualifiedSessionEntryRow> = undefined;
    let failure: { error: unknown } | undefined;
    if (options.onReadError) {
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
        selected =
          options.keyFormat === "agent-qualified"
            ? readQualifiedSessionEntryRow(database, resolved.agentId, resolved.sessionKey, {
                allowCanonicalMove: options.allowCanonicalMove,
                projection,
              })
            : readSessionEntryRow(database, resolved.sessionKey, projection);
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
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        readWithCanonicalSessionReaderContinuation(database, options.continuation, () =>
          read(database),
        ),
      toDatabaseOptions(resolved),
    );
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

/** Only the row operation becomes data; admission, source checks and rollback still throw. */
export function loadSessionEntryReadOnlyResultInScope(
  scope: SessionEntryReadScope & { databaseAgentId?: string },
  continuation?: CanonicalSessionReaderContinuation,
  onReadSource?: (source: CapturedSessionEntryReadSource) => void,
): Result<SessionEntry | undefined, unknown> {
  try {
    return ok(
      resolveSessionEntry(scope, {
        readOnly: true,
        databaseAgentId: scope.databaseAgentId,
        projection: scope.projection,
        continuation,
        onReadSource,
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
    throw error;
  }
}

type PhysicalSessionEntryReadScope = {
  env?: NodeJS.ProcessEnv;
  readSource: SessionEntryReadSource;
  projection?: SessionEntryReadScope["projection"];
};

export function assertCapturedSessionEntryReadSource(
  source: CapturedSessionEntryReadSource,
  database?: Pick<OpenClawAgentDatabase, "agentId" | "path" | "db">,
): void {
  if (typeof source.databaseIdentity === "string" && (!database || database.path !== source.path)) {
    assertExistingDatabaseIdentity(source.path, `file:${source.databaseIdentity}`);
  }
  if (!database) {
    if (typeof source.databaseIdentity === "symbol") {
      throw new Error("Captured session database is no longer open");
    }
    return;
  }
  const physical = readOpenClawAgentDatabaseIdentity(database);
  if (
    database.agentId !== source.agentId ||
    physical.identity !== source.databaseIdentity ||
    physical.birthtime !== source.databaseBirthtime ||
    !isOpenClawAgentDatabasePathCurrent(database)
  ) {
    throw new Error("Captured session database changed before read");
  }
}

/** Retain the recorded physical owner without selecting a replacement database. */
function retainCapturedSessionEntryReadSource(
  source: CapturedSessionEntryReadSource,
  env?: NodeJS.ProcessEnv,
) {
  const retained = retainOpenClawAgentDatabaseReadOnly({
    agentId: source.agentId,
    path: source.path,
    env,
  });
  if (!retained.found) {
    throw new Error("Captured session database is unavailable");
  }
  const assertCurrent = () => {
    retained.claim.assertCurrent();
    assertCapturedSessionEntryReadSource(source, retained.database);
  };
  try {
    assertCurrent();
    return {
      database: retained.database,
      assertCurrent,
      release: retained.claim.release,
    };
  } catch (error) {
    retained.claim.release();
    throw error;
  }
}

/** Retained windows occupy a key even when they have no current readable entry. */
export function retainSessionEntryKeyAbsence(params: {
  source: CapturedSessionEntryReadSource;
  sessionKeys: readonly string[];
  canonicalKey: string;
  env?: NodeJS.ProcessEnv;
}) {
  const source = retainCapturedSessionEntryReadSource(params.source, params.env);
  const assertCurrent = () => {
    source.assertCurrent();
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
    source.assertCurrent();
    if (occupied) {
      throw new Error(
        `Session "${params.canonicalKey}" has ambiguous stored identity. Select an unambiguous session; stored rows and history were not changed.`,
      );
    }
  };
  try {
    assertCurrent();
    return { assertCurrent, release: source.release };
  } catch (error) {
    source.release();
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
    | (Omit<SessionEntryReadScope, "sessionKey"> & { readOnly: boolean })
    | (PhysicalSessionEntryReadScope & { readOnly: true })
  ) & {
    sessionKeys: readonly string[];
    onReadSource?: (
      source: SessionEntryReadSource,
      physical?: Pick<
        ReturnType<typeof readOpenClawAgentDatabaseIdentity>,
        "identity" | "birthtime"
      >,
    ) => void;
    expectedSource?: CapturedSessionEntryReadSource;
  },
): ExactSessionEntry[] {
  const sessionKeys = scope.sessionKeys.map((key) => key.trim()).filter(Boolean);
  const [sessionKey] = sessionKeys;
  if (!sessionKey) {
    return [];
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
    const entries = sessionKeys.flatMap((key) => {
      const entry = readExactSessionEntryRow(database, key, scope.projection, "canonical")?.entry;
      return entry ? [{ sessionKey: key, entry }] : [];
    });
    scope.onReadSource?.(
      { agentId: database.agentId, path: database.path },
      { identity: physical.identity, birthtime: physical.birthtime },
    );
    return entries;
  };
  if (!scope.readOnly) {
    return read(openOpenClawAgentDatabase(options));
  }
  const result = withOpenClawAgentDatabaseReadOnly(read, options);
  return result.found ? result.value : [];
}

// SQLite's default trim removes only spaces; legacy ID matching used String.trim().
const SESSION_ID_TRIM_CHARACTERS =
  "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

/** Loads a visible current ID, falling back to legacy trimmed IDs only on an exact miss. */
export function loadSessionEntryByIdReadOnly(
  scope: Omit<SessionEntryReadScope, "sessionKey"> & { sessionId: string },
): ExactSessionEntry | undefined {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      readWithCanonicalSessionAdmission(database, () => {
        assertCanonicalSqliteSessionKeysCurrent(database);
        const db = getSessionKysely(database.db);
        const query = db.selectFrom("session_nodes").select("session_key").orderBy("session_key");
        // The common path uses the current-ID index. Only a miss scans for one
        // legacy ID, preserving listing order without materializing other entries.
        for (const trimLegacyId of [false, true]) {
          const matches = iterateSqliteQuerySync(
            database.db,
            trimLegacyId
              ? query.where((eb) =>
                  eb(
                    eb.fn<string>("trim", [
                      "current_session_id",
                      eb.val(SESSION_ID_TRIM_CHARACTERS),
                    ]),
                    "=",
                    scope.sessionId,
                  ),
                )
              : query.where("current_session_id", "=", scope.sessionId),
          );
          for (const { session_key: sessionKey } of matches) {
            if (isInternalSessionEffectsKey(sessionKey)) {
              continue;
            }
            const selected = readExactSessionEntryRowValidated(
              database,
              sessionKey,
              scope.projection,
            );
            if (selected) {
              return { sessionKey, entry: selected.entry };
            }
          }
        }
        return undefined;
      }),
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
  const options = toDatabaseOptions(resolveSqliteScope({ ...scope, sessionKey: "" }));
  return loadExactSessionEntryCandidates({
    readSource: { ...options, path: resolveOpenClawAgentSqlitePath(options) },
    projection: scope.projection,
    readOnly: true,
    sessionKeys: [scope.sessionKey],
  })[0];
}

/** Read requested keys through synchronous store/projection groups. */
export type ExactSessionEntryBatchScope = Omit<SessionEntryReadScope, "sessionKey"> & {
  sessionKeys: readonly string[];
  onReadSource?: (source: SessionEntryReadSource) => void;
};

function groupExactSessionEntryReadRequests(scopes: readonly ExactSessionEntryBatchScope[]) {
  const results: Array<Result<ExactSessionEntry[], unknown> | undefined> = [];
  const targetCache: SessionSqliteTargetResolutionCache = new Map();
  const groups = new Map<
    string,
    {
      options: OpenClawAgentDatabaseOptions;
      projection: SessionEntryReadScope["projection"];
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
      const options = toDatabaseOptions(resolveSqliteScope({ ...scope, sessionKey }, targetCache));
      const groupKey = [
        options.agentId,
        resolveOpenClawAgentSqlitePath(options),
        scope.projection ?? "full",
      ].join("\u0000");
      const group = groups.get(groupKey) ?? { options, projection: scope.projection, requests: [] };
      group.requests.push({ index, sessionKeys });
      groups.set(groupKey, group);
    } catch (error) {
      results[index] = err(error);
    }
  }
  return { groups, results };
}

export function loadExactSessionEntryCandidatesReadOnlyBatch(
  scopes: readonly ExactSessionEntryBatchScope[],
): Array<Result<ExactSessionEntry[], unknown>> {
  const { groups, results } = groupExactSessionEntryReadRequests(scopes);
  for (const group of groups.values()) {
    try {
      const read = withOpenClawAgentDatabaseReadOnly(
        (database) =>
          readWithCanonicalSessionAdmission(database, () => {
            // Admission failures affect this store; an invalid requested row must not
            // suppress healthy logical targets after a warm handle was validated.
            assertCanonicalSqliteSessionKeysCurrent(database);
            const source = { agentId: database.agentId, path: database.path };
            const grouped = readExactSessionEntryCandidatesInDatabase(
              database,
              group.requests.map((request) => request.sessionKeys),
              group.projection,
            );
            for (const [ordinal, request] of group.requests.entries()) {
              const result = grouped[ordinal]!;
              results[request.index] = result;
              if (result.ok) {
                scopes[request.index]!.onReadSource?.(source);
              }
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
      for (const { index } of group.requests) {
        results[index] = err(error);
      }
    }
  }
  return scopes.map((_, index) => expectDefined(results[index], "exact session batch read result"));
}
