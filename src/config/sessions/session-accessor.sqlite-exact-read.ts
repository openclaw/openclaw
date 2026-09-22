import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { ExactSessionEntry, SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { readExactSessionEntryCandidatesInDatabase } from "./session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRowValidated,
  readSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
  type SessionSqliteTargetResolutionCache,
} from "./session-accessor.sqlite-scope.js";
import type { SessionEntryReadScope, SessionEntryReadSource } from "./session-accessor.types.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  readWithCanonicalSessionAdmission,
} from "./session-canonical-key.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type ResolvedSqliteSessionEntry = {
  existing: SessionEntry | undefined;
  legacyKeys: string[];
  normalizedKey: string;
};

/** Resolves one exact canonical entry without materializing the store. */
export function resolveSessionEntry(
  scope: SessionAccessScope,
  options: { readOnly?: boolean; databaseAgentId?: string } = {},
): ResolvedSqliteSessionEntry {
  const resolved = resolveSqliteScope(scope);
  if (options.databaseAgentId) {
    resolved.databaseAgentId = options.databaseAgentId;
  }
  const read = (
    database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  ): ResolvedSqliteSessionEntry => {
    const selected = readSessionEntryRow(database, resolved.sessionKey);
    return {
      existing: selected?.entry,
      legacyKeys: [],
      normalizedKey: resolved.sessionKey,
    };
  };
  if (options.readOnly) {
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => readWithCanonicalSessionAdmission(database, () => read(database)),
      toDatabaseOptions(resolved),
    );
    return result.found
      ? result.value
      : { existing: undefined, legacyKeys: [], normalizedKey: resolved.sessionKey };
  }
  return read(openOpenClawAgentDatabase(toDatabaseOptions(resolved)));
}

type PhysicalSessionEntryReadScope = {
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
    | (Omit<SessionEntryReadScope, "sessionKey"> & { readOnly: boolean })
    | (PhysicalSessionEntryReadScope & { readOnly: true })
  ) & {
    sessionKeys: readonly string[];
    onReadSource?: (source: SessionEntryReadSource) => void;
  },
): ExactSessionEntry[] {
  const sessionKeys = scope.sessionKeys.map((key) => key.trim()).filter(Boolean);
  const [sessionKey] = sessionKeys;
  if (!sessionKey) {
    return [];
  }
  const options =
    "readSource" in scope
      ? scope.readSource
      : toDatabaseOptions(resolveSqliteScope({ ...scope, sessionKey }));
  // Alias candidates share a store; fresh handles must not rescan canonical state per key.
  const read = (database: Pick<OpenClawAgentDatabase, "agentId" | "path" | "db">) => {
    const entries = sessionKeys.flatMap((key) => {
      const entry = readExactSessionEntryRowValidated(database, key, scope.projection)?.entry;
      return entry ? [{ sessionKey: key, entry }] : [];
    });
    scope.onReadSource?.({ agentId: database.agentId, path: database.path });
    return entries;
  };
  if (!scope.readOnly) {
    return read(openOpenClawAgentDatabase(options));
  }
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => readWithCanonicalSessionAdmission(database, () => read(database)),
    options,
  );
  return result.found ? result.value : [];
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

/** Read requested keys through synchronous store/projection groups. */
export type ExactSessionEntryBatchScope = Omit<SessionEntryReadScope, "sessionKey"> & {
  sessionKeys: readonly string[];
  onReadSource?: (source: SessionEntryReadSource) => void;
};

function groupExactSessionEntryReadRequests(scopes: readonly ExactSessionEntryBatchScope[]) {
  const results: Array<Result<ExactSessionEntry[], unknown>> = scopes.map(() => ok([]));
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
      withOpenClawAgentDatabaseReadOnly((database) => {
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
      }, group.options);
    } catch (error) {
      for (const { index } of group.requests) {
        results[index] = err(error);
      }
    }
  }
  return results;
}
