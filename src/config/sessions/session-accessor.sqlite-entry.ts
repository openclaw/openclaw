import { isMainThread } from "node:worker_threads";
import { normalizeInternalTurnContext } from "../../auto-reply/internal-turn-source.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../infra/sqlite-number.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../../state/openclaw-agent-db-readonly-scope.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { runOpenClawAgentWriteWithYieldingAdmission } from "../../state/openclaw-agent-db-transaction.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseRuntime,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { deriveLastRoutePatch, deriveSessionMetaPatch } from "./metadata.js";
import type {
  RecordInboundSessionMetaParams,
  UpdateSessionLastRouteParams,
} from "./runtime-types.js";
import type {
  SessionAccessScope,
  SessionEntryPatchContext,
  SessionEntryPatchOptions,
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
  readSessionChildEntriesInDatabase,
  readSessionKeyBySessionIdInDatabase,
} from "./session-accessor.sqlite-entry-read.js";
import {
  readExactSessionEntryRowValidated,
  readSessionEntryRow,
  readLifecycleTargetSnapshot,
  readSessionEntrySelectionSnapshot,
} from "./session-accessor.sqlite-entry-store.js";
import { resolveSessionEntry } from "./session-accessor.sqlite-exact-read.js";
import { listTranscriptInstancesFromDatabase } from "./session-accessor.sqlite-history.js";
import { prepareSessionIdentityPublication } from "./session-accessor.sqlite-identity.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import { createFallbackSessionEntry } from "./session-accessor.sqlite-normalize.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  resolveSqliteTranscriptArchiveDirectory,
  resolveSqliteTranscriptReadScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import type { SessionEntryListScope, SessionEntryReadScope } from "./session-accessor.types.js";
import {
  assertCanonicalSessionKeyWrite,
  assertCanonicalSqliteSessionKeysCurrent,
  readWithCanonicalSessionReaderContinuation,
  type CanonicalSessionReaderContinuation,
} from "./session-canonical-key.js";
import { sessionEntryPatchPredicateMatches } from "./session-entry-patch-guard.js";
import {
  mergeSessionEntryPatch,
  reduceSessionEntryPatch,
  type SessionEntryPatchOperation,
} from "./session-entry-patch-operation.js";
import { captureSessionEntryPatchSource } from "./session-entry-patch-source.js";
import { patchSessionEntryInWorker } from "./session-entry-patch.js";
import type {
  SessionEntryPatchGuard,
  SessionEntryPatchSelection,
} from "./session-entry-patch.types.js";
import { buildSessionCreationStamp } from "./session-entry-provenance.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import { kickSessionHistoryDiskBudgetMaintenance } from "./session-history-eviction.js";
import { patchIncognitoSessionEntry } from "./session-incognito-entry-patch.js";
import {
  prepareSessionSourceAuthority,
  type PreparedSessionSourceAuthority,
} from "./session-source-authority.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";
import { mergeSessionEntry } from "./types.js";

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
  loadSessionEntryReadOnlyInScope,
} from "./session-accessor.sqlite-exact-read.js";

// Callback preparation precedes BEGIN; fixed operations evaluate the transaction's current rows.

type SqliteSessionEntryPatchOptions = SessionEntryPatchOptions & {
  /** Audited internal updaters: no nested writer admission; guards retain only host authority. */
  workerGuard?: SessionEntryPatchGuard;
  /** Recheck owner cancellation after async preparation, immediately before committing. */
  shouldCommit?: () => boolean;
  /** Synchronous owner bookkeeping after COMMIT, before identity observers can cancel the caller. */
  onCommitted?: (entry: SessionEntry) => void;
};

/** Loads one session entry from the additive SQLite session store. */
export function loadSessionEntry(scope: SessionAccessScope): SessionEntry | undefined {
  return resolveSessionEntry(scope).existing;
}

/** Loads one session entry without opening its agent database writable. */
export function loadSessionEntryReadOnly(scope: SessionEntryReadScope): SessionEntry | undefined {
  return resolveSessionEntry(scope, { readOnly: true, projection: scope.projection }).existing;
}

export { loadSessionEntryReadOnlyResultInScope } from "./session-accessor.sqlite-exact-read.js";

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
    return readSessionChildEntriesInDatabase(database, resolved.sessionKey, scope.projection);
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : [];
}

/** Resolves the persisted session key for a SQLite transcript session id. */
export function resolveSessionKeyBySessionId(
  scope: Pick<SessionTranscriptReadScope, "agentId" | "env" | "sessionId" | "storePath">,
): string | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => readSessionKeyBySessionIdInDatabase(database, resolved.sessionId),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : undefined;
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

/** Lists transcript-bearing SQLite sessions, including retained rows from session-id rotation. */
export function listSessionTranscriptInstances(
  scope: Omit<SessionEntryListScope, "sessionKeys"> = {},
  options: SessionTranscriptInstanceListOptions = {},
  continuation?: CanonicalSessionReaderContinuation,
): SessionTranscriptInstance[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      readWithCanonicalSessionReaderContinuation(database, continuation, () => {
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
      }),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : [];
}

/** Reads a session activity timestamp from the additive SQLite session store. */
export function readSessionUpdatedAtCore(scope: SessionAccessScope): number | undefined {
  const resolved = resolveSqliteScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const row = readSessionEntryRow(database, resolved.sessionKey, "list")?.row;
  return row ? sqliteNumber(row.updated_at) : undefined;
}

/** Applies a partial entry update to the additive SQLite session store. */
export async function upsertSessionEntryCore(
  scope: SessionAccessScope,
  patch: Partial<SessionEntry>,
  options: Pick<SqliteSessionEntryPatchOptions, "assertCommitAllowed" | "workerGuard"> = {},
): Promise<SessionEntry | null> {
  return await applySessionEntryOperation(
    scope,
    { kind: "fields", patch },
    {
      ...options,
      fallbackEntry: createFallbackSessionEntry(patch),
    },
  );
}

/** Replaces one entry in the additive SQLite session store. */
export async function replaceSessionEntry(
  scope: SessionAccessScope,
  entry: SessionEntry,
): Promise<SessionEntry | null> {
  return await applySessionEntryOperation(
    scope,
    { kind: "fields", patch: entry },
    {
      fallbackEntry: entry,
      replaceEntry: true,
    },
  );
}

/** Replaces one entry synchronously for sync session runtimes. */
export function replaceSessionEntrySync(scope: SessionAccessScope, entry: SessionEntry): void {
  const resolved = resolveSqliteScope(scope);
  assertCanonicalSessionKeyWrite(resolved.sessionKey, resolved.agentId);
  const publish = runOpenClawAgentWriteTransaction(
    (database) => {
      const { previous, current } = replaceSessionEntryInDatabase(
        database,
        resolved.sessionKey,
        entry,
      );
      return prepareSessionIdentityPublication(database, resolved.agentId, previous, current);
    },
    toDatabaseOptions(resolved),
    { operationLabel: "session-entry.replace" },
  );
  publish();
}

/** Patches one entry in the additive SQLite session store. */
export async function patchSessionEntryCore(
  scope: SessionAccessScope,
  update: SessionEntryUpdater,
  options: SqliteSessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  return await patchSessionEntryInScope(scope, update, options);
}

/** Internal fixed operations evaluate the authoritative row inside the writer command. */
export async function applySessionEntryOperation(
  scope: SessionAccessScope,
  operation: SessionEntryPatchOperation,
  options: SqliteSessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  return await patchSessionEntryInScope(scope, structuredClone(operation), {
    workerGuard: {},
    ...options,
  });
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
  assertCanonicalSessionKeyWrite(resolved.sessionKey, resolved.agentId);
  return await patchSqliteSessionEntrySnapshot({
    operationLabel: "session-entry.patch",
    validateCanonicalKeys: options.replaceEntry !== true,
    options,
    selection: {
      kind: "entry",
      sessionKey: resolved.sessionKey,
      exact: options.replaceEntry === true,
    },
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
  update: SessionEntryUpdater,
  options: SqliteSessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  return await patchSessionEntryTargetInScope(scope, update, options);
}

export async function applySessionEntryTargetOperation(
  scope: SessionEntryTargetPatchScope,
  operation: SessionEntryPatchOperation,
  options: SqliteSessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  return await patchSessionEntryTargetInScope(scope, structuredClone(operation), {
    workerGuard: {},
    ...options,
  });
}

async function patchSessionEntryTargetInScope(
  scope: SessionEntryTargetPatchScope,
  update: SqliteSessionEntrySnapshotPatchParams["update"],
  options: SqliteSessionEntryPatchOptions,
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
        sessionKey: scope.target.canonicalKey,
        storePath: scope.storePath,
      });
  return await patchSqliteSessionEntrySnapshot({
    operationLabel: "session-entry-target.patch",
    capturedSource: source,
    validateCanonicalKeys: true,
    options,
    selection: { kind: "target", target: scope.target },
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

type SessionEntryUpdater = (
  entry: SessionEntry,
  context: SessionEntryPatchContext,
) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;

type SqliteSessionEntrySnapshotPatchParams = {
  capturedSource?: CapturedSessionEntryReadSource;
  operationLabel: "session-entry.patch" | "session-entry-target.patch";
  validateCanonicalKeys: boolean;
  options: SqliteSessionEntryPatchOptions;
  selection: SessionEntryPatchSelection;
  readSnapshot: (database: OpenClawAgentDatabase) => SqliteLifecycleTargetSnapshot;
  resolved: ResolvedSqliteScope;
  sessionKey: string;
  storePath: string;
  update: SessionEntryUpdater | SessionEntryPatchOperation;
};

/** Callback and fixed-operation patches share source custody, FIFO, and commit publication. */
async function patchSqliteSessionEntrySnapshot(
  params: SqliteSessionEntrySnapshotPatchParams,
): Promise<SessionEntry | null> {
  const { options, sessionKey } = params;
  const captured = params.capturedSource;
  const {
    resolved,
    databaseOptions,
    databasePath,
    targetIdentity,
    incognito,
    incognitoBinding,
    assertCapturedSource,
    assertCurrent,
  } = captureSessionEntryPatchSource(params.resolved, sessionKey, captured);
  const prepare = async (prepared: SqliteLifecycleTargetSnapshot) => {
    const existing = prepared[0]?.entry;
    const writeBase = existing ?? options.fallbackEntry;
    if (!writeBase) {
      return undefined;
    }
    let contextEntry = existing;
    let contextEntryBorrowed = true;
    const patch =
      typeof params.update !== "function"
        ? reduceSessionEntryPatch(params.update, writeBase)
        : await params.update(structuredClone(writeBase), {
            get existingEntry() {
              if (contextEntryBorrowed) {
                contextEntry = contextEntry ? structuredClone(contextEntry) : undefined;
                contextEntryBorrowed = false;
              }
              return contextEntry;
            },
            set existingEntry(entry) {
              contextEntry = entry;
              contextEntryBorrowed = false;
            },
          });
    const next = mergeSessionEntryPatch({ ...options, existing, writeBase, patch, sessionKey });
    return {
      selection: params.selection,
      prepared,
      sessionKey,
      writeBase,
      next,
      operationLabel: params.operationLabel,
      validateCanonicalKeys: params.validateCanonicalKeys,
      consumePendingReset: options.consumePendingReset,
      providerReviewMutation: options.providerReviewMutation,
      shouldCommitIf: options.workerGuard?.shouldCommitIf,
      cliHistory: options.workerGuard?.cliHistory,
      conversation: options.workerGuard?.conversation,
    };
  };
  const withDatabase = <T>(operation: () => T | Promise<T>) => {
    assertCurrent?.();
    return !incognito && !getOpenClawAgentDatabaseIfOpen(databaseOptions)
      ? withOpenClawAgentDatabaseRuntime(databaseOptions, operation, assertCurrent)
      : operation();
  };
  if (incognitoBinding) {
    const result = await patchIncognitoSessionEntry({
      ...incognitoBinding,
      sessionKey,
      selection: params.selection,
      assertCurrent() {
        assertCurrent?.();
        options.workerGuard?.assertCurrent?.();
      },
      assertCommitAllowed: options.assertCommitAllowed,
      shouldCommit: options.shouldCommit,
      source: options.workerGuard?.source,
      prepare,
      onCommitted: options.onCommitted,
    });
    return result.entry;
  }
  let wrote = false;
  const useWorker =
    isMainThread &&
    options.workerGuard !== undefined &&
    !options.shouldCommit &&
    !options.assertCommitAllowed &&
    supportsOpenClawAgentDatabaseExecution(databaseOptions);
  const workerPatch = (preparedSource?: PreparedSessionSourceAuthority) =>
    patchSessionEntryInWorker({
      database: { ...databaseOptions, path: databasePath },
      databaseIdentity:
        typeof captured?.databaseIdentity === "string" ? captured.databaseIdentity : undefined,
      agentId: resolved.agentId,
      selection: params.selection,
      assertCurrent: () => assertCurrent?.(),
      guard: options.workerGuard,
      preparedSource,
      reduction:
        typeof params.update === "function"
          ? undefined
          : {
              operation: params.update,
              selection: params.selection,
              sessionKey,
              operationLabel: params.operationLabel,
              validateCanonicalKeys: params.validateCanonicalKeys,
              fallbackEntry: options.fallbackEntry,
              replaceEntry: options.replaceEntry,
              preserveActivity: options.preserveActivity,
              consumePendingReset: options.consumePendingReset,
              providerReviewMutation: options.providerReviewMutation,
              shouldCommitIf: options.workerGuard?.shouldCommitIf,
              cliHistory: options.workerGuard?.cliHistory,
              conversation: options.workerGuard?.conversation,
            },
      prepare,
      onCommitted: options.onCommitted,
    }).then((result) => {
      wrote = result.wrote;
      return result.entry;
    });
  const sourceAssertion = options.workerGuard?.source;
  // Reserve the existing FIFO before async source planning or selecting either writer path.
  const committed = await runExclusiveSqliteSessionWrite(
    resolved,
    async () => {
      if (useWorker) {
        const source = await prepareSessionSourceAuthority(sourceAssertion);
        const locality: "same-store" | "cross-store" =
          !source.nativeSource &&
          source.checks.every(
            ({ predicate }) =>
              targetIdentity.key === `file:${String(predicate.source.databaseIdentity)}`,
          )
            ? "same-store"
            : "cross-store";
        if (locality === "same-store") {
          return workerPatch(source);
        }
        // Cross-store event-loop atomicity is required while the released synchronous
        // transcript SDK bypasses async queues. Revisit at the next SDK major.
        await source.release?.();
      }
      return withDatabase(async () => {
        const database = openOpenClawAgentDatabase(databaseOptions);
        assertCapturedSource(database);
        const prepared = params.readSnapshot(database);
        const input = await prepare(prepared);
        if (!input) {
          return null;
        }
        const { writeBase, next } = input;
        // The updater may dispose the prepared handle; re-admit before waiting for the write lock.
        return withDatabase(async () => {
          let result: SessionEntry | null = null;
          const publish = await runOpenClawAgentWriteWithYieldingAdmission(
            (writeDatabase) => {
              assertCapturedSource(writeDatabase);
              options.workerGuard?.assertCurrent?.();
              if (options.shouldCommit?.() === false) {
                return undefined;
              }
              if (
                !sessionEntryPatchPredicateMatches(
                  writeDatabase,
                  sessionKey,
                  options.workerGuard?.shouldCommitIf,
                )
              ) {
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
                options: {
                  ...options,
                  assertCommitAllowed: () => {
                    options.assertCommitAllowed?.();
                    options.workerGuard?.source?.();
                  },
                },
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
            },
            databaseOptions,
            { operationLabel: params.operationLabel },
          );
          try {
            if (next && result) {
              options.onCommitted?.(structuredClone(result));
            }
          } finally {
            publish?.();
          }
          return result;
        });
      });
    },
    params.operationLabel,
    undefined,
    // Source-free worker patches may reuse a foreground planner's reservation.
    // The admission owner still prevents reentry during a worker write grant.
    useWorker && !sourceAssertion ? "foreground-reentrant" : "foreground",
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

function buildInboundSessionCreationStamp(ctx: UpdateSessionLastRouteParams["ctx"]) {
  const senderId = ctx?.SenderId?.trim();
  return buildSessionCreationStamp(
    ctx?.SessionCreation ?? {
      via: "channel",
      ...(senderId
        ? {
            actor: {
              type: "human",
              source: "channel",
              id: senderId,
              label: ctx?.SenderName?.trim() || undefined,
            },
          }
        : {}),
    },
  );
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
      return {
        ...buildInboundSessionCreationStamp(params.ctx),
        ...metadataPatch,
      };
    },
    {
      // Inbound metadata must not refresh activity timestamps; idle reset
      // evaluation relies on updatedAt from actual session turns.
      preserveActivity: true,
      workerGuard: {},
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
  params: Omit<Parameters<typeof updateSessionLastRoute>[0], "storePath" | "sessionKey"> & {
    workerGuard?: SessionEntryPatchGuard;
  },
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
      return {
        ...buildInboundSessionCreationStamp(params.ctx),
        ...routePatch,
      };
    },
    {
      // Route updates must not refresh activity timestamps (#49515).
      preserveActivity: true,
      workerGuard: params.workerGuard ?? {},
      ...(params.assertCommitAllowed ? { assertCommitAllowed: params.assertCommitAllowed } : {}),
      ...(createIfMissing ? { fallbackEntry: mergeSessionEntry(undefined, {}) } : {}),
    },
    scope.databaseAgentId,
  );
}
