import { normalizeInternalTurnContext } from "../../auto-reply/internal-turn-source.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../infra/sqlite-number.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../../state/openclaw-agent-db-readonly-scope.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  isIncognitoOpenClawAgentSqlitePath,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAsync,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../paths.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import { deriveLastRoutePatch, deriveSessionMetaPatch } from "./metadata.js";
import type {
  RecordInboundSessionMetaParams,
  UpdateSessionLastRouteParams,
} from "./runtime-types.js";
import type {
  SessionAccessScope,
  SessionEntryPatchContext,
  SessionEntryPatchOptions,
  SessionEntryStatus,
  SessionEntrySummary,
  SessionTranscriptInstance,
  SessionTranscriptInstanceListOptions,
  SessionEntryTargetPatchScope,
  SessionTranscriptReadScope,
} from "./session-accessor.sqlite-contract.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import { listSqliteSessionEntriesFromDatabase } from "./session-accessor.sqlite-entry-list.read.js";
import {
  applySessionEntryPatchInDatabase,
  replaceSessionEntryInDatabase,
} from "./session-accessor.sqlite-entry-mutation.js";
import {
  parseReadableSqliteSessionEntryRows,
  readExactSessionEntryRowValidated,
  readSessionEntryRow,
  readLifecycleTargetSnapshot,
  readSessionEntrySelectionSnapshot,
} from "./session-accessor.sqlite-entry-store.js";
import {
  assertCapturedSessionEntryReadSource,
  resolveSessionEntry,
} from "./session-accessor.sqlite-exact-read.js";
import { listTranscriptInstancesFromDatabase } from "./session-accessor.sqlite-history.js";
import { prepareSessionIdentityPublication } from "./session-accessor.sqlite-identity.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import { createFallbackSessionEntry } from "./session-accessor.sqlite-normalize.js";
import {
  cloneSessionEntry,
  getSessionKysely,
  resolveSqliteScope,
  resolveSqliteTranscriptArchiveDirectory,
  resolveSqliteTranscriptReadScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import {
  hasSessionEntriesByStatus,
  readSessionEntriesByStatus,
  selectSessionEntryRows,
} from "./session-accessor.sqlite-status.js";
import type {
  CapturedSessionEntryReadSource,
  SessionEntryListScope,
  SessionEntryReadScope,
} from "./session-accessor.types.js";
import {
  assertCanonicalSessionKeyWrite,
  assertCanonicalSqliteSessionKeysCurrent,
} from "./session-canonical-key.js";
import { preserveSqliteSameKeySessionRolloverLineage } from "./session-entry-lineage.js";
import { buildSessionCreationStamp } from "./session-entry-provenance.js";
import { kickSessionHistoryDiskBudgetMaintenance } from "./session-history-eviction.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";
import { mergeSessionEntry, mergeSessionEntryPreserveActivity } from "./types.js";

export { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
export { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
export { listSessionEntriesReadOnly } from "./session-accessor.sqlite-entry-list.read.js";
export {
  loadExactSessionEntry,
  loadExactSessionEntryCandidates,
  loadExactSessionEntryCandidatesReadOnlyBatch,
  loadExactSessionEntryFromStoreReadOnly,
  loadExactSessionEntryReadOnly,
  loadSessionEntryByIdReadOnly,
} from "./session-accessor.sqlite-exact-read.js";

// Public entry API. Async preparation precedes BEGIN; commit revalidates repository snapshots.

type SqliteSessionEntryPatchOptions = SessionEntryPatchOptions & {
  skipMaintenance?: boolean;
  /** Recheck owner cancellation after async preparation, immediately before committing. */
  shouldCommit?: () => boolean;
  /** Synchronous owner bookkeeping after COMMIT, before identity observers can cancel the caller. */
  onCommitted?: (entry: SessionEntry) => void;
};

function assertCanonicalSessionWriteScope(
  scope: Pick<ResolvedSqliteScope, "agentId" | "sessionKey">,
): void {
  assertCanonicalSessionKeyWrite(scope.sessionKey, scope.agentId);
}

/** Loads one session entry from the additive SQLite session store. */
export function loadSessionEntry(scope: SessionAccessScope): SessionEntry | undefined {
  return resolveSessionEntry(scope).existing;
}

/** Loads one session entry without opening its agent database writable. */
export function loadSessionEntryReadOnly(scope: SessionEntryReadScope): SessionEntry | undefined {
  return resolveSessionEntry(scope, { readOnly: true, projection: scope.projection }).existing;
}

export { loadSessionEntryReadOnlyResultInScope } from "./session-accessor.sqlite-exact-read.js";

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

/** Lists persisted session keys without materializing their entry JSON. */
export async function listSessionEntryKeysReadOnly(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">> = {},
): Promise<string[]> {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const db = getSessionKysely(database.db);
    return executeSqliteQuerySync(
      database.db,
      db.selectFrom("session_nodes").select("session_key").orderBy("session_key"),
    ).rows.map((row) => row.session_key);
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : [];
}

/** Lists direct child rows without cloning or rebuilding the complete session store. */
export function listSessionChildEntriesReadOnly(
  scope: SessionEntryReadScope,
): SessionEntrySummary[] {
  const resolved = resolveSqliteScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    assertCanonicalSqliteSessionKeysCurrent(database);
    const db = getSessionKysely(database.db);
    const query =
      scope.projection === "list"
        ? selectSessionEntryRows(database, scope.projection).select([
            "current_session_id",
            "updated_at",
          ])
        : db.selectFrom("session_nodes").selectAll();
    // Separate indexed lookups avoid a whole-store scan chosen for OR with ordering.
    const sessionKeys = db.selectFrom("session_nodes").select("session_key");
    const childKeys = sessionKeys
      .where("parent_session_key", "=", resolved.sessionKey)
      .union(sessionKeys.where("spawned_by", "=", resolved.sessionKey));
    const childRows = executeSqliteQuerySync(
      database.db,
      query
        .where("session_key", "in", childKeys)
        .where("session_key", "!=", resolved.sessionKey)
        .orderBy("session_key", "asc"),
    ).rows;
    return parseReadableSqliteSessionEntryRows(
      database,
      childRows.filter((row) => !isInternalSessionEffectsKey(row.session_key)),
      scope.projection,
    );
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : [];
}

/** Resolves the persisted session key for a SQLite transcript session id. */
export function resolveSessionKeyBySessionId(
  scope: Pick<SessionTranscriptReadScope, "agentId" | "env" | "sessionId" | "storePath">,
): string | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  // session_windows.session_id is the primary key; the indexed lookup cannot be ambiguous.
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const db = getSessionKysely(database.db);
    return executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_windows")
        .select("session_key")
        .where("session_id", "=", resolved.sessionId)
        .limit(1),
    );
  }, toDatabaseOptions(resolved));
  return result.found ? result.value?.session_key : undefined;
}

/** Lists session entries from the additive SQLite session store. */
export function listSessionEntryRows(scope: SessionEntryListScope = {}): SessionEntrySummary[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return listSqliteSessionEntriesFromDatabase(database, resolved, scope);
}

/** Reuse one reader during synchronous entry work; each read keeps its current admission. */
export function withSessionEntryReadOnlyScope<T>(
  scope: Pick<SessionEntryListScope, "agentId" | "defaultAgentId" | "env" | "storePath">,
  operation: () => T,
): T {
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

/**
 * Proves whether a durable store has a row in one of the requested lifecycle states.
 * Unknown existing schemas stay eligible so the writable owner can surface or repair them.
 */
export function hasSessionEntriesByStatusReadOnly(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">>,
  statuses: readonly SessionEntryStatus[],
): boolean {
  const selectedStatuses = [...new Set(statuses)];
  if (selectedStatuses.length === 0) {
    return false;
  }
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => hasSessionEntriesByStatus(database, selectedStatuses),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : result.reason !== "database-missing";
}

/** Lists only entries whose normalized session row has one of the requested statuses. */
export function listSessionEntriesByStatus(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">>,
  statuses: readonly SessionEntryStatus[],
): SessionEntrySummary[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readSessionEntriesByStatus(database, statuses).filter(
    ({ sessionKey }) => !isInternalSessionEffectsKey(sessionKey),
  );
}

/** Lists transcript-bearing SQLite sessions, including retained rows from session-id rotation. */
export function listSessionTranscriptInstances(
  scope: Omit<SessionEntryListScope, "sessionKeys"> = {},
  options: SessionTranscriptInstanceListOptions = {},
): SessionTranscriptInstance[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const currentEntries =
      options.sessionId !== undefined
        ? {
            get: (sessionKey: string) =>
              readExactSessionEntryRowValidated(database, sessionKey, scope.projection)?.entry,
          }
        : new Map(
            listSqliteSessionEntriesFromDatabase(database, resolved, {
              ...scope,
              clone: false,
            }).map(({ sessionKey, entry }) => [sessionKey, entry]),
          );
    return listTranscriptInstancesFromDatabase({ currentEntries, database, options });
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : [];
}

/** Reads a session activity timestamp from the additive SQLite session store. */
export function readSessionUpdatedAtCore(scope: SessionAccessScope): number | undefined {
  const resolved = resolveSqliteScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const row = readSessionEntryRow(database, resolved.sessionKey)?.row;
  return row ? sqliteNumber(row.updated_at) : undefined;
}

/** Applies a partial entry update to the additive SQLite session store. */
export async function upsertSessionEntryCore(
  scope: SessionAccessScope,
  patch: Partial<SessionEntry>,
  options: Pick<SessionEntryPatchOptions, "assertCommitAllowed"> = {},
): Promise<SessionEntry | null> {
  return await patchSessionEntryCore(scope, () => patch, {
    ...options,
    fallbackEntry: createFallbackSessionEntry(patch),
  });
}

/** Replaces one entry in the additive SQLite session store. */
export async function replaceSessionEntry(
  scope: SessionAccessScope,
  entry: SessionEntry,
): Promise<SessionEntry | null> {
  return await patchSessionEntryCore(scope, () => entry, {
    fallbackEntry: entry,
    replaceEntry: true,
  });
}

/** Replaces one entry synchronously for sync session runtimes. */
export function replaceSessionEntrySync(scope: SessionAccessScope, entry: SessionEntry): void {
  const resolved = resolveSqliteScope(scope);
  assertCanonicalSessionWriteScope(resolved);
  const publish = runOpenClawAgentWriteTransaction((database) => {
    const { previous, current } = replaceSessionEntryInDatabase(
      database,
      resolved.sessionKey,
      entry,
    );
    return prepareSessionIdentityPublication(database, resolved.agentId, previous, current);
  }, toDatabaseOptions(resolved));
  publish();
}

/** Patches one entry in the additive SQLite session store. */
export async function patchSessionEntryCore(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SqliteSessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  return await patchSessionEntryInScope(scope, update, options);
}

async function patchSessionEntryInScope(
  scope: SessionAccessScope,
  update: SqliteSessionEntrySnapshotPatchParams["update"],
  options: SqliteSessionEntryPatchOptions,
  databaseAgentId?: string,
): Promise<SessionEntry | null> {
  const resolved = resolveSqliteScope(scope);
  if (databaseAgentId) {
    resolved.databaseAgentId = databaseAgentId;
  }
  assertCanonicalSessionWriteScope(resolved);
  return await patchSqliteSessionEntrySnapshot({
    operationLabel: "session-entry.patch",
    validateCanonicalKeys: options.replaceEntry !== true,
    options,
    readSnapshot: (database) =>
      readSessionEntrySelectionSnapshot(
        database,
        resolved.sessionKey,
        options.replaceEntry === true,
      ),
    resolved,
    sessionKey: resolved.sessionKey,
    storePath: resolveSessionStorePathForScope(scope),
    update,
  });
}

/** Patches one logical entry after validating its canonical lifecycle target. */
export async function patchSessionEntryTarget(
  scope: SessionEntryTargetPatchScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SqliteSessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  const source = scope.readSource;
  const resolved: ResolvedSqliteScope = source
    ? {
        agentId: scope.agentId ?? source.agentId,
        databaseAgentId: source.agentId,
        env: scope.env,
        path: source.path,
        ownerStorePath: source.path,
        sessionKey: "",
      }
    : resolveSqliteScope({
        agentId: scope.agentId,
        env: scope.env,
        sessionKey: "",
        storePath: scope.storePath,
      });
  return await patchSqliteSessionEntrySnapshot({
    operationLabel: "session-entry-target.patch",
    capturedSource: source,
    validateCanonicalKeys: true,
    options,
    readSnapshot: (database) => readLifecycleTargetSnapshot(database, scope.target),
    resolved,
    sessionKey: scope.target.canonicalKey,
    storePath:
      source?.path ??
      resolveSessionStorePathForScope({
        agentId: scope.agentId,
        sessionKey: scope.target.canonicalKey,
        storePath: scope.storePath,
      }),
    update,
  });
}

type SqliteSessionEntrySnapshotPatchParams = {
  capturedSource?: CapturedSessionEntryReadSource;
  operationLabel: "session-entry.patch" | "session-entry-target.patch";
  validateCanonicalKeys: boolean;
  options: SqliteSessionEntryPatchOptions;
  readSnapshot: (database: OpenClawAgentDatabase) => SqliteLifecycleTargetSnapshot;
  resolved: ResolvedSqliteScope;
  sessionKey: string;
  storePath: string;
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
};

/** All entry patches prepare asynchronously, then revalidate and publish on one commit edge. */
async function patchSqliteSessionEntrySnapshot(
  params: SqliteSessionEntrySnapshotPatchParams,
): Promise<SessionEntry | null> {
  const { options, sessionKey } = params;
  // Queueing and either cold open must retain the same registration and lease owner.
  const resolved = {
    ...params.resolved,
    env: cloneEnvWithPlatformSemantics(params.resolved.env ?? process.env),
  };
  resolved.env.OPENCLAW_STATE_DIR = resolveStateDir(resolved.env);
  const databaseOptions = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(databaseOptions);
  resolved.path = databasePath;
  databaseOptions.path = databasePath;
  const incognito = isIncognitoOpenClawAgentSqlitePath(databasePath, databaseOptions);
  const captured = params.capturedSource;
  const assertCapturedSource = (database?: OpenClawAgentDatabase) => {
    if (!captured) {
      return;
    }
    assertCapturedSessionEntryReadSource(
      captured,
      database ?? getOpenClawAgentDatabaseIfOpen(databaseOptions),
    );
  };
  const assertCurrent = captured ? () => assertCapturedSource() : undefined;
  const withDatabase = <T>(operation: () => T | Promise<T>) => {
    assertCurrent?.();
    return !incognito && !getOpenClawAgentDatabaseIfOpen(databaseOptions)
      ? withOpenClawAgentDatabaseAsync(databaseOptions, operation, assertCurrent)
      : operation();
  };
  let wrote = false;
  const committed = await runExclusiveSqliteSessionWrite(
    resolved,
    async () =>
      withDatabase(async () => {
        const database = openOpenClawAgentDatabase(databaseOptions);
        assertCapturedSource(database);
        const prepared = params.readSnapshot(database);
        const existing = prepared[0]?.entry;
        const writeBase = existing ?? options.fallbackEntry;
        if (!writeBase) {
          return null;
        }
        const patch = await params.update(cloneSessionEntry(writeBase), {
          existingEntry: existing ? cloneSessionEntry(existing) : undefined,
        });
        // A fallback supplies identity, not an existing node's immutable creation policy.
        const mergeBase = existing ? writeBase : undefined;
        const creationPatch = !existing && patch ? { ...writeBase, ...patch } : patch;
        const merged = !creationPatch
          ? undefined
          : options.replaceEntry
            ? cloneSessionEntry(patch as SessionEntry)
            : options.preserveActivity
              ? mergeSessionEntryPreserveActivity(mergeBase, creationPatch)
              : mergeSessionEntry(mergeBase, creationPatch);
        const next = !merged
          ? undefined
          : options.replaceEntry
            ? merged
            : preserveSqliteSameKeySessionRolloverLineage({
                next: merged,
                previous: writeBase,
                sessionKey,
              });
        // The updater may dispose the prepared handle; re-admit before the synchronous commit.
        return withDatabase(() => {
          let result: SessionEntry | null = null;
          const publish = runOpenClawAgentWriteTransaction((writeDatabase) => {
            assertCapturedSource(writeDatabase);
            if (options.shouldCommit?.() === false) {
              return undefined;
            }
            const mutation = applySessionEntryPatchInDatabase(writeDatabase, {
              operationLabel: params.operationLabel,
              validateCanonicalKeys: params.validateCanonicalKeys,
              readSnapshot: params.readSnapshot,
              prepared,
              sessionKey,
              writeBase,
              next,
              options,
            });
            result = mutation.entry;
            if (!mutation.identity) {
              return undefined;
            }
            wrote = true;
            return prepareSessionIdentityPublication(
              writeDatabase,
              resolved.agentId,
              mutation.identity.previous,
              mutation.identity.current,
            );
          }, databaseOptions);
          try {
            if (next && result) {
              options.onCommitted?.(cloneSessionEntry(result));
            }
          } finally {
            publish?.();
          }
          return result;
        });
      }),
    params.operationLabel,
  );
  if (wrote) {
    kickSessionEntryMaintenanceAfterWrite({
      activeSessionKey: sessionKey,
      archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
      maintenanceConfig: options.maintenanceConfig,
      scope: resolved,
      skipMaintenance: options.skipMaintenance,
      storePath: params.storePath,
    });
  }
  kickSessionHistoryDiskBudgetMaintenance({
    ...(resolved.agentId ? { agentId: resolved.agentId } : {}),
    env: resolved.env,
    storePath: params.storePath,
    ...(options.maintenanceConfig ? { maintenanceConfig: options.maintenanceConfig } : {}),
  });
  return committed;
}

export async function recordInboundSessionMeta(
  params: RecordInboundSessionMetaParams,
): Promise<SessionEntry | null> {
  normalizeInternalTurnContext(params.ctx);
  const createIfMissing = params.createIfMissing ?? true;
  return await patchSessionEntryCore(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (_entry, context) => {
      const metadataPatch = deriveSessionMetaPatch({
        ctx: params.ctx,
        sessionKey: params.sessionKey,
        existing: context.existingEntry,
        groupResolution: params.groupResolution,
      });
      if (context.existingEntry) {
        return metadataPatch;
      }
      const senderId = params.ctx.SenderId?.trim();
      return {
        ...buildSessionCreationStamp(
          params.ctx.SessionCreation ?? {
            via: "channel",
            ...(senderId ? { actor: { type: "human", source: "channel", id: senderId } } : {}),
          },
        ),
        ...metadataPatch,
      };
    },
    {
      // Inbound metadata must not refresh activity timestamps; idle reset
      // evaluation relies on updatedAt from actual session turns.
      preserveActivity: true,
      ...(createIfMissing ? { fallbackEntry: mergeSessionEntry(undefined, {}) } : {}),
    },
  );
}

/** Updates last-route/delivery metadata without refreshing activity timestamps. */
export async function updateSessionLastRoute(
  params: UpdateSessionLastRouteParams & { assertCommitAllowed?: () => void },
): Promise<SessionEntry | null> {
  return await updateSessionLastRouteInScope(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    params,
  );
}

/** Internal callers retain their captured storage owner across route preparation. */
export async function updateSessionLastRouteInScope(
  scope: SessionAccessScope & { databaseAgentId?: string },
  params: Omit<Parameters<typeof updateSessionLastRoute>[0], "storePath" | "sessionKey">,
): Promise<SessionEntry | null> {
  if (params.ctx) {
    normalizeInternalTurnContext(params.ctx);
  }
  const createIfMissing = params.createIfMissing ?? true;
  return await patchSessionEntryInScope(
    scope,
    (_entry, context) => {
      const routePatch = deriveLastRoutePatch({
        channel: params.channel,
        to: params.to,
        accountId: params.accountId,
        threadId: params.threadId,
        route: params.route,
        deliveryContext: params.deliveryContext,
        ctx: params.ctx,
        groupResolution: params.groupResolution,
        existing: context.existingEntry,
        sessionKey: scope.sessionKey,
      });
      if (context.existingEntry) {
        return routePatch;
      }
      const senderId = params.ctx?.SenderId?.trim();
      return {
        ...buildSessionCreationStamp(
          params.ctx?.SessionCreation ?? {
            via: "channel",
            ...(senderId
              ? { actor: { type: "human" as const, source: "channel" as const, id: senderId } }
              : {}),
          },
        ),
        ...routePatch,
      };
    },
    {
      // Route updates must not refresh activity timestamps (#49515).
      preserveActivity: true,
      ...(params.assertCommitAllowed ? { assertCommitAllowed: params.assertCommitAllowed } : {}),
      ...(createIfMissing ? { fallbackEntry: mergeSessionEntry(undefined, {}) } : {}),
    },
    scope.databaseAgentId,
  );
}
