import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveTimestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { sql, type Selectable } from "kysely";
import type { MsgContext } from "../../auto-reply/templating.js";
import { resolveStoredSessionOwnerAgentId } from "../../gateway/session-store-key.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { getChildLogger } from "../../logging/logger.js";
import {
  isAgentHarnessSessionKey,
  isValidAgentHarnessSessionStoreEntry,
  MODEL_SELECTION_LOCK_REMOVAL_MESSAGE,
  resolveAgentHarnessSessionStoreError,
  resolveAgentHarnessSessionStoreEntryError,
  resolveAgentHarnessSessionStoreTransitionError,
} from "../../sessions/agent-harness-session-key.js";
import { emitSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { SessionDiskBudgetSweepResult } from "./disk-budget.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import { deriveLastRoutePatch, deriveSessionMetaPatch } from "./metadata.js";
import {
  materializeSqliteSessionStateDeletePlans,
  type MaterializedSqliteSessionStateDeletePlan,
  type SqliteSessionStateDeletePlan,
} from "./session-accessor.sqlite-archive.js";
import type {
  ExactSessionEntry,
  ForkSessionEntryFromParentTargetParams,
  ForkSessionEntryFromParentTargetResult,
  ForkSessionFromParentTranscriptParams,
  ForkSessionFromParentTranscriptResult,
  SessionLifecycleArchivedTranscript,
  DeleteSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleResult,
  DeletedAgentSessionEntryPurgeParams,
  ResetSessionEntryLifecycleParams,
  ResetSessionEntryLifecycleResult,
  SessionAccessScope,
  SessionEntryLifecycleMutationResult,
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
  SessionEntryPatchContext,
  SessionEntryPatchOptions,
  SessionEntryReplacementSnapshot,
  SessionEntryReplacementUpdate,
  SessionEntryStatus,
  SessionEntrySummary,
  SessionTranscriptInstance,
  SessionEntryTargetPatchScope,
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
  SessionTranscriptAccessScope,
  SessionTranscriptReadScope,
  SessionTranscriptTurnMessageAppend,
  SessionTranscriptTurnWriteContext,
  SessionTranscriptWriteScope,
  SessionParentForkDecision,
  TranscriptEvent,
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
  TranscriptUpdatePayload,
} from "./session-accessor.sqlite-contract.js";
import {
  enforceSqliteSessionDiskBudget,
  type SqliteSessionRowBytes,
} from "./session-accessor.sqlite-disk-budget.js";
import { listSqliteTranscriptInstancesFromDatabase } from "./session-accessor.sqlite-history.js";
import {
  emitCommittedLifecycleIdentityMutations,
  emitCommittedSessionEntryChange,
  emitCommittedSessionEntryRemovals,
  emitCommittedSessionIdentityDiff,
} from "./session-accessor.sqlite-identity.js";
import {
  createFallbackSessionEntry,
  normalizeSqliteNumber,
} from "./session-accessor.sqlite-normalize.js";
import {
  buildSqliteForkedChildTranscriptEvents,
  estimateSqliteTranscriptPromptTokens,
  resolveSqliteParentForkDecision,
  resolveSqliteParentForkSourceTranscript,
  type SqliteParentForkSourceTranscript,
} from "./session-accessor.sqlite-parent-fork.js";
import { resolveSessionEntryProvenanceRow } from "./session-accessor.sqlite-provenance.js";
import {
  findSqliteTranscriptEvent,
  loadLatestSqliteAssistantText,
  loadSqliteTranscriptEvents,
  loadSqliteTranscriptEventsFromDatabase,
  loadSqliteTranscriptEventsSync,
  readSqliteTranscriptSnapshot,
  readSqliteTranscriptStatsSync,
  readTranscriptEventJsonSetInTransaction,
  type SqliteTranscriptSnapshotRow,
} from "./session-accessor.sqlite-read.js";
import {
  cloneSessionEntry,
  formatSqliteSessionMarkerForScope,
  getSessionKysely,
  normalizeSqliteSessionKey,
  resolveSqliteReadScope,
  resolveSqliteScope,
  resolveSqliteStoreScope,
  resolveSqliteTranscriptArchiveDirectory,
  resolveSqliteTranscriptReadScope,
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
  type ResolvedSqliteScope,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import {
  bindSqliteSessionRoot,
  normalizeSqliteSessionEntryTimestamp,
} from "./session-accessor.sqlite-session-row.js";
import {
  normalizeSqliteStatus,
  parseSqliteSessionEntryJson as parseSessionEntryRow,
  readSqliteSessionEntriesByStatus,
} from "./session-accessor.sqlite-status.js";
import {
  advanceTranscriptMutationAtInTransaction,
  readTranscriptMutationStateInTransaction,
  touchTranscriptMutationInTransaction,
  writeSessionRoute,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventInTransaction,
  appendTranscriptEventsInTransaction,
  ensureTranscriptHeader,
  readActiveTranscriptAppendParentId,
  readMessageIdempotencyKey,
  readTranscriptIdentityByEventId,
  readTranscriptMessageByEventId,
  readTranscriptMessageByScopedIdempotencyKey,
  redactTranscriptMessageForStorage,
  replaceSqliteTranscriptEventsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import { preserveSqliteSameKeySessionRolloverLineage } from "./session-entry-lineage.js";
import { deleteSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import type {
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "./session-transcript-turn-lifecycle.types.js";
import {
  buildExpectedTranscriptTurnSessionPatch,
  sessionMatchesExpectedTranscriptTurn,
} from "./session-transcript-turn-state.js";
import {
  foldedSessionKeyAliasCandidates,
  normalizeStoreSessionKey,
  resolveSessionStoreEntry,
} from "./store-entry.js";
import { collectSessionMaintenancePreserveKeys } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  pruneStaleModelRunEntries,
  pruneStaleEntries,
  shouldRunModelRunPrune,
  shouldRunSessionEntryMaintenance,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import type {
  ResetSessionEntryLifecycleMutation,
  SessionArchivedTranscriptCleanupRule,
} from "./store.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import { serializeJsonlLines } from "./transcript-jsonl.js";
import type { GroupKeyResolution, SessionCompactionCheckpoint, SessionEntry } from "./types.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
  resolveFreshSessionTotalTokens,
} from "./types.js";

type SessionArchiveRuntime = typeof import("../../gateway/session-archive.runtime.js");
let sessionArchiveRuntimePromise: Promise<SessionArchiveRuntime> | undefined;

function loadSessionArchiveRuntime() {
  sessionArchiveRuntimePromise ??= import("../../gateway/session-archive.runtime.js");
  return sessionArchiveRuntimePromise;
}

type SessionEntryRow = Selectable<OpenClawAgentKyselyDatabase["session_entries"]>;
type ResolvedSessionEntryRow = {
  entry: SessionEntry;
  legacyKeys: string[];
  row: SessionEntryRow;
};
type SqliteSessionEntrySelectionSnapshot = {
  selected: ResolvedSessionEntryRow | undefined;
  selectedRows: Array<{ entry: SessionEntry; sessionKey: string }>;
};
type SqliteLifecycleTargetSnapshot = {
  primary: { entry: SessionEntry; key: string } | undefined;
  rows: Array<{ entry: SessionEntry; sessionKey: string }>;
};
type SqliteSessionEntryRemovalPlan = {
  expectedEntry: SessionEntry | undefined;
  sessionKey: string;
};
type SqliteSessionEntryMaintenancePlan = {
  entryRemovals: SqliteSessionEntryRemovalPlan[];
  stateDeletePlans: SqliteSessionStateDeletePlan[];
};
type SqliteLifecycleArtifactCleanupPlan = {
  deletePlans: SqliteSessionStateDeletePlan[];
  entries: SqliteSessionEntryRemovalPlan[];
};
type SqliteProjectedLifecycleMutation = {
  deletePlans: SqliteSessionStateDeletePlan[];
  removals: Array<{
    expectedEntry: SessionEntry;
    removal: SessionEntryLifecycleRemoval;
    sessionKey: string;
  }>;
  upsertedEntries: Array<{
    entry: SessionEntry;
    expectedEntry: SessionEntry | undefined;
    sessionKey: string;
  }>;
};
type SqliteSessionEntryPatchOptions = SessionEntryPatchOptions & {
  skipMaintenance?: boolean;
};

class SqliteSessionMutationConflictError extends Error {
  constructor(operationLabel: string) {
    super(`SQLite session state changed while preparing ${operationLabel}`);
    this.name = "SqliteSessionMutationConflictError";
  }
}

class SqliteTranscriptMutationConflictError extends Error {
  constructor(sessionId: string) {
    super(`SQLite transcript changed while preparing rewrite for ${sessionId}`);
    this.name = "SqliteTranscriptMutationConflictError";
  }
}

type SqliteCheckpointTranscriptForkSource = {
  sessionId: string;
  leafId?: string;
  totalTokens?: number;
};

/** Result from SQLite compaction checkpoint branch or restore operations. */
type SqliteCompactionCheckpointSessionMutationResult =
  | {
      status: "created";
      key: string;
      checkpoint: SessionCompactionCheckpoint;
      entry: SessionEntry;
    }
  | { status: "missing-session" }
  | { status: "missing-checkpoint" }
  | { status: "missing-boundary" }
  | { status: "failed" };

/** Parameters for branching a SQLite session from a compaction checkpoint. */
type SqliteBranchCheckpointSessionParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  sourceKey: string;
  sourceStoreKey?: string;
  nextKey: string;
  checkpointId: string;
};

/** Parameters for restoring a SQLite session from a compaction checkpoint. */
type SqliteRestoreCheckpointSessionParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  sessionKey: string;
  sessionStoreKey?: string;
  checkpointId: string;
};

/** Internal doctor/migration import target for one legacy session row. */
type SqliteSessionImportRowsParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  sessionKey: string;
  entry: SessionEntry;
  readTranscriptEvents?: (append: (event: TranscriptEvent) => void) => void;
  transcriptMtimeMs?: number;
};

/** Summary of rows written by an internal doctor/migration import. */
type SqliteSessionImportRowsResult = {
  sessionId: string;
  sessionKey: string;
  transcriptEvents: number;
};

type SqliteExpectedSessionTranscriptTurnResult = {
  appendedMessages: TranscriptMessageAppendResult<unknown>[];
  rejectedReason?: "session-rebound";
  sessionEntry: SessionEntry | undefined;
  sessionFile: string;
};

type SqliteTranscriptWriteLockContext = {
  appendMessage: <TMessage>(
    options: TranscriptMessageAppendOptions<TMessage>,
  ) => Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
  readEvents: () => Promise<TranscriptEvent[]>;
  replaceEvents: (events: readonly TranscriptEvent[]) => Promise<void>;
};

type SqliteTranscriptSnapshotState =
  | { kind: "current"; rows: SqliteTranscriptSnapshotRow[] }
  | { kind: "stale" };

export {
  findSqliteTranscriptEvent,
  loadLatestSqliteAssistantText,
  loadSqliteTranscriptEvents,
  loadSqliteTranscriptEventsSync,
  readSqliteTranscriptStatsSync,
};

/** Loads one session entry from the additive SQLite session store. */
export function loadSqliteSessionEntry(scope: SessionAccessScope): SessionEntry | undefined {
  const resolved = resolveSqliteScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readSessionEntryRow(database, resolved.sessionKey)?.entry;
}

/** Loads one exact persisted-key entry from the additive SQLite session store. */
export function loadExactSqliteSessionEntry(
  scope: SessionAccessScope,
): ExactSessionEntry | undefined {
  const sessionKey = scope.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const resolved = resolveSqliteScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const row = readExactSessionEntryRow(database, sessionKey);
  return row ? { sessionKey, entry: row.entry } : undefined;
}

/** Resolves the persisted session key for a SQLite transcript session id. */
export function resolveSqliteSessionKeyBySessionId(
  scope: Pick<SessionTranscriptReadScope, "agentId" | "env" | "sessionId" | "storePath">,
): string | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("sessions")
      .select("session_key")
      .where("session_id", "=", resolved.sessionId)
      .limit(1),
  );
  return row?.session_key;
}

/** Lists session entries from the additive SQLite session store. */
export function listSqliteSessionEntries(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">> = {},
): SessionEntrySummary[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_entries")
      .select(["session_key", "entry_json", "session_id", "updated_at"])
      .orderBy("session_key", "asc"),
  ).rows;
  return rows
    .map((row) => {
      if (isInternalSessionEffectsKey(row.session_key)) {
        return undefined;
      }
      const entry = parseSessionEntryRow(row);
      return entry ? { sessionKey: row.session_key, entry } : undefined;
    })
    .filter((entry): entry is SessionEntrySummary => entry !== undefined);
}

/** Lists only entries whose normalized session row has one of the requested statuses. */
export function listSqliteSessionEntriesByStatus(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">>,
  statuses: readonly SessionEntryStatus[],
): SessionEntrySummary[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readSqliteSessionEntriesByStatus(database, statuses).filter(
    ({ sessionKey }) => !isInternalSessionEffectsKey(sessionKey),
  );
}

/** Lists transcript-bearing SQLite sessions, including retained rows from session-id rotation. */
export function listSqliteSessionTranscriptInstances(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">> = {},
): SessionTranscriptInstance[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const currentEntries = new Map(
    listSqliteSessionEntries(scope).map((summary) => [summary.sessionKey, summary.entry]),
  );
  return listSqliteTranscriptInstancesFromDatabase({
    agentId: resolved.agentId,
    currentEntries,
    database,
    databasePath: resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved)),
  });
}

/** Reads a session activity timestamp from the additive SQLite session store. */
export function readSqliteSessionUpdatedAt(scope: SessionAccessScope): number | undefined {
  const resolved = resolveSqliteScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const row = readSessionEntryRow(database, resolved.sessionKey)?.row;
  return row ? normalizeSqliteNumber(row.updated_at) : undefined;
}

/** Applies a partial entry update to the additive SQLite session store. */
export async function upsertSqliteSessionEntry(
  scope: SessionAccessScope,
  patch: Partial<SessionEntry>,
): Promise<SessionEntry | null> {
  return await patchSqliteSessionEntry(scope, () => patch, {
    fallbackEntry: createFallbackSessionEntry(patch),
  });
}

/** Replaces one entry in the additive SQLite session store. */
export async function replaceSqliteSessionEntry(
  scope: SessionAccessScope,
  entry: SessionEntry,
): Promise<SessionEntry | null> {
  return await patchSqliteSessionEntry(scope, () => entry, {
    fallbackEntry: entry,
    replaceEntry: true,
  });
}

/** Replaces one entry synchronously for sync session runtimes. */
export function replaceSqliteSessionEntrySync(
  scope: SessionAccessScope,
  entry: SessionEntry,
): void {
  const resolved = resolveSqliteScope(scope);
  let previous = new Map<string, SessionEntry>();
  let current = new Map<string, SessionEntry>();
  runOpenClawAgentWriteTransaction((database) => {
    const identityKeys = collectSessionEntryLookupKeys(database, resolved.sessionKey);
    previous = readSqliteSessionIdentitySnapshot(database, identityKeys);
    writeSessionEntry(database, resolved.sessionKey, entry);
    current = readSqliteSessionIdentitySnapshot(database, identityKeys);
  }, toDatabaseOptions(resolved));
  emitCommittedSessionIdentityDiff(previous, current);
}

/** Patches one entry in the additive SQLite session store. */
export async function patchSqliteSessionEntry(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SqliteSessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  const resolved = resolveSqliteScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const prepared = readSqliteSessionEntrySelectionSnapshot(
      database,
      resolved.sessionKey,
      options.replaceEntry === true,
    );
    const writeBase = prepared.selected?.entry ?? options.fallbackEntry;
    if (!writeBase) {
      return null;
    }
    const patch = await update(cloneSessionEntry(writeBase), {
      existingEntry: prepared.selected?.entry
        ? cloneSessionEntry(prepared.selected.entry)
        : undefined,
    });
    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    let result: SessionEntry | null = null;
    let previousIdentity = new Map<string, SessionEntry>();
    let currentIdentity = new Map<string, SessionEntry>();
    runOpenClawAgentWriteTransaction((writeDatabase) => {
      const fresh = readSqliteSessionEntrySelectionSnapshot(
        writeDatabase,
        resolved.sessionKey,
        options.replaceEntry === true,
      );
      assertSqliteSessionEntrySelectionUnchanged(prepared, fresh, "session-entry.patch");
      if (!patch) {
        result = cloneSessionEntry(writeBase);
        return;
      }
      const identityKeys = [
        resolved.sessionKey,
        ...fresh.selectedRows.map((row) => row.sessionKey),
      ];
      previousIdentity = createSqliteSessionIdentitySnapshot(fresh.selectedRows);
      const merged = options.replaceEntry
        ? cloneSessionEntry(patch as SessionEntry)
        : options.preserveActivity
          ? mergeSessionEntryPreserveActivity(writeBase, patch)
          : mergeSessionEntry(writeBase, patch);
      const next = options.replaceEntry
        ? merged
        : preserveSqliteSameKeySessionRolloverLineage({
            next: merged,
            previous: writeBase,
            sessionKey: resolved.sessionKey,
          });
      writeSessionEntry(writeDatabase, resolved.sessionKey, next);
      deleteLegacySessionEntryRows(
        writeDatabase,
        fresh.selected?.legacyKeys ?? [],
        resolved.sessionKey,
      );
      maintenancePlans.push(
        applySqliteSessionEntryMaintenance(writeDatabase, {
          activeSessionKey: resolved.sessionKey,
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          maintenanceConfig: options.maintenanceConfig,
          skipMaintenance: options.skipMaintenance,
        }),
      );
      currentIdentity = readSqliteSessionIdentitySnapshot(writeDatabase, identityKeys);
      result = cloneSessionEntry(next);
    }, toDatabaseOptions(resolved));
    emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
    finalizeSqliteSessionEntryMaintenancePlansBestEffort(resolved, maintenancePlans);
    return result;
  });
}

/** Patches one logical entry selected from a canonical key and alias set. */
export async function patchSqliteSessionEntryTarget(
  scope: SessionEntryTargetPatchScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SqliteSessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  const resolved = resolveSqliteStoreScope(scope.storePath, { agentId: scope.agentId });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const prepared = readSqliteLifecycleTargetSnapshot(database, scope.target);
    const writeBase = prepared.primary?.entry ?? options.fallbackEntry;
    if (!writeBase) {
      return null;
    }
    const patch = await update(cloneSessionEntry(writeBase), {
      existingEntry: prepared.primary?.entry
        ? cloneSessionEntry(prepared.primary.entry)
        : undefined,
    });
    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    let result: SessionEntry | null = null;
    let previousIdentity = new Map<string, SessionEntry>();
    let currentIdentity = new Map<string, SessionEntry>();
    runOpenClawAgentWriteTransaction((writeDatabase) => {
      const fresh = readSqliteLifecycleTargetSnapshot(writeDatabase, scope.target);
      assertSqliteLifecycleTargetSnapshotUnchanged(prepared, fresh, "session-entry-target.patch");
      if (!patch) {
        result = cloneSessionEntry(writeBase);
        return;
      }
      const identityKeys = [
        scope.target.canonicalKey,
        ...scope.target.storeKeys,
        ...fresh.rows.map((row) => row.sessionKey),
      ];
      previousIdentity = createSqliteSessionIdentitySnapshot(fresh.rows);
      const merged = options.replaceEntry
        ? cloneSessionEntry(patch as SessionEntry)
        : options.preserveActivity
          ? mergeSessionEntryPreserveActivity(writeBase, patch)
          : mergeSessionEntry(writeBase, patch);
      const next = options.replaceEntry
        ? merged
        : preserveSqliteSameKeySessionRolloverLineage({
            next: merged,
            previous: writeBase,
            sessionKey: scope.target.canonicalKey,
          });
      deleteSqliteLifecycleTargetRows(writeDatabase, scope.target);
      writeSessionEntry(writeDatabase, scope.target.canonicalKey, next);
      maintenancePlans.push(
        applySqliteSessionEntryMaintenance(writeDatabase, {
          activeSessionKey: scope.target.canonicalKey,
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          maintenanceConfig: options.maintenanceConfig,
          skipMaintenance: options.skipMaintenance,
        }),
      );
      currentIdentity = readSqliteSessionIdentitySnapshot(writeDatabase, identityKeys);
      result = cloneSessionEntry(next);
    }, toDatabaseOptions(resolved));
    emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
    finalizeSqliteSessionEntryMaintenancePlansBestEffort(resolved, maintenancePlans);
    return result;
  });
}

/** Forks one parent SQLite transcript into a new child transcript. */
export async function forkSqliteSessionTranscriptFromParent(
  params: ForkSessionFromParentTranscriptParams,
): Promise<ForkSessionFromParentTranscriptResult> {
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  const target = params.targetStorePath
    ? resolveSqliteScope({ sessionKey: params.sessionKey, storePath: params.targetStorePath })
    : resolved;
  const crossDatabase =
    target.agentId !== resolved.agentId || (target.path ?? "") !== (resolved.path ?? "");
  if (!crossDatabase) {
    return await runExclusiveSqliteSessionWrite(resolved, async () => {
      let result: ForkSessionFromParentTranscriptResult = { status: "failed" };
      runOpenClawAgentWriteTransaction((database) => {
        result = forkSqliteParentTranscriptInTransaction(database, resolved, {
          parentEntry: params.parentEntry,
          parentSessionKey: params.parentSessionKey,
          targetSessionId: params.targetSessionId,
          targetSessionKey: params.sessionKey,
        });
      }, toDatabaseOptions(resolved));
      return result;
    });
  }
  // Cross-agent fork (worktree/cross-agent sessions.create): parent rows live
  // in the source agent database while the child transcript must be owned by
  // the target agent's database. Two databases cannot share one transaction,
  // so read the parent branch first, then write the child under the target's
  // exclusive session write lock.
  if (!params.parentEntry.sessionId) {
    return { status: "missing-parent" };
  }
  const sourceDatabase = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const source = resolveSqliteParentForkSourceTranscript(
    loadSqliteTranscriptEventsFromDatabase(sourceDatabase, params.parentEntry.sessionId),
  );
  if (!source) {
    return { status: "failed" };
  }
  const parentSessionFile = formatSqliteSessionMarkerForScope({
    ...resolved,
    sessionId: params.parentEntry.sessionId,
    sessionKey: normalizeSqliteSessionKey(params.parentSessionKey),
  });
  return await runExclusiveSqliteSessionWrite(target, async () => {
    const sessionId = params.targetSessionId ?? randomUUID();
    const targetScope = {
      ...target,
      sessionId,
      sessionKey: normalizeSqliteSessionKey(params.sessionKey),
    };
    const sessionFile = formatSqliteSessionMarkerForScope(targetScope);
    runOpenClawAgentWriteTransaction((database) => {
      writeSqliteForkedChildTranscriptInTransaction(database, targetScope, {
        parentSessionFile,
        source,
      });
    }, toDatabaseOptions(target));
    return { status: "created", transcript: { sessionFile, sessionId } };
  });
}

/** Forks parent context into a child session entry using SQLite rows only. */
export async function forkSqliteSessionEntryFromParentTarget(
  params: ForkSessionEntryFromParentTargetParams,
): Promise<ForkSessionEntryFromParentTargetResult> {
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId: params.agentId });
  const parentTarget = normalizeSqliteLifecycleTarget(params.parentTarget);
  const sessionTarget = normalizeSqliteLifecycleTarget(params.sessionTarget);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const parent = resolveSqliteLifecyclePrimaryEntry(database, parentTarget);
    if (!parent?.entry.sessionId) {
      return { status: "missing-parent" };
    }

    const existing = resolveSqliteLifecyclePrimaryEntry(database, sessionTarget);
    const base = existing?.entry ?? params.fallbackEntry;
    if (!base) {
      return { status: "missing-entry" };
    }

    if (params.skipForkWhen?.(cloneSessionEntry(base))) {
      const sessionEntry = await persistSqliteParentForkSkipPatch({
        entry: base,
        params,
        sessionTarget,
        patch: params.skipPatch?.(cloneSessionEntry(base)),
        resolved,
      });
      return {
        status: "skipped",
        reason: "existing-entry",
        parentEntry: cloneSessionEntry(parent.entry),
        sessionEntry,
      };
    }

    const needsTranscriptTokenEstimate =
      typeof resolveFreshSessionTotalTokens(parent.entry) !== "number" &&
      typeof parent.entry.sessionId === "string" &&
      parent.entry.sessionId.length > 0;
    const transcriptParentTokens = needsTranscriptTokenEstimate
      ? estimateSqliteTranscriptPromptTokens(
          loadSqliteTranscriptEventsFromDatabase(database, parent.entry.sessionId),
        )
      : undefined;
    const decision = resolveSqliteParentForkDecision(parent.entry, transcriptParentTokens);
    if (decision.status === "skip") {
      const patch = params.decisionSkipPatch?.({
        decision,
        entry: cloneSessionEntry(base),
        parentEntry: cloneSessionEntry(parent.entry),
      });
      const sessionEntry = await persistSqliteParentForkSkipPatch({
        entry: base,
        params,
        sessionTarget,
        patch,
        resolved,
      });
      return {
        status: "skipped",
        reason: "decision-skip",
        parentEntry: cloneSessionEntry(parent.entry),
        sessionEntry,
        decision,
      };
    }

    let result: ForkSessionEntryFromParentTargetResult = { status: "failed" };
    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    let previousIdentity = new Map<string, SessionEntry>();
    let currentIdentity = new Map<string, SessionEntry>();
    runOpenClawAgentWriteTransaction((writeDatabase) => {
      const freshParent = resolveSqliteLifecyclePrimaryEntry(writeDatabase, parentTarget)?.entry;
      if (!freshParent?.sessionId) {
        result = { status: "missing-parent" };
        return;
      }
      const freshExisting = resolveSqliteLifecyclePrimaryEntry(writeDatabase, sessionTarget);
      const freshBase = freshExisting?.entry ?? params.fallbackEntry;
      if (!freshBase) {
        result = { status: "missing-entry" };
        return;
      }
      const fork = forkSqliteParentTranscriptInTransaction(writeDatabase, resolved, {
        parentEntry: freshParent,
        parentSessionKey: parentTarget.canonicalKey,
        targetSessionKey: sessionTarget.canonicalKey,
      });
      if (fork.status !== "created") {
        result =
          fork.status === "missing-parent" ? { status: "missing-parent" } : { status: "failed" };
        return;
      }
      const patch = params.patch?.({
        decision,
        entry: cloneSessionEntry(freshBase),
        fork: fork.transcript,
        parentEntry: cloneSessionEntry(freshParent),
      });
      const next = mergeSessionEntry(freshBase, {
        ...patch,
        forkedFromParent: true,
        sessionFile: fork.transcript.sessionFile,
        sessionId: fork.transcript.sessionId,
      });
      previousIdentity = readSqliteSessionIdentitySnapshot(writeDatabase, sessionTarget.storeKeys);
      deleteSqliteLifecycleTargetRows(writeDatabase, sessionTarget);
      writeSessionEntry(writeDatabase, sessionTarget.canonicalKey, next);
      maintenancePlans.push(
        applySqliteSessionEntryMaintenance(writeDatabase, {
          activeSessionKey: sessionTarget.canonicalKey,
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          skipMaintenance: true,
        }),
      );
      currentIdentity = readSqliteSessionIdentitySnapshot(writeDatabase, sessionTarget.storeKeys);
      result = {
        status: "forked",
        decision,
        fork: fork.transcript,
        parentEntry: cloneSessionEntry(freshParent),
        sessionEntry: cloneSessionEntry(next),
      };
    }, toDatabaseOptions(resolved));
    emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
    finalizeSqliteSessionEntryMaintenancePlansBestEffort(resolved, maintenancePlans);
    return result;
  });
}

async function persistSqliteParentForkSkipPatch(params: {
  entry: SessionEntry;
  params: ForkSessionEntryFromParentTargetParams;
  sessionTarget: { canonicalKey: string; storeKeys: string[] };
  patch: Partial<SessionEntry> | null | undefined;
  resolved: ResolvedSqliteScope;
}): Promise<SessionEntry> {
  if (!params.patch) {
    return cloneSessionEntry(params.entry);
  }
  const merged = mergeSessionEntry(params.entry, params.patch);
  const next = preserveSqliteSameKeySessionRolloverLineage({
    next: merged,
    previous: params.entry,
    sessionKey: params.sessionTarget.canonicalKey,
  });
  const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
  let previousIdentity = new Map<string, SessionEntry>();
  let currentIdentity = new Map<string, SessionEntry>();
  runOpenClawAgentWriteTransaction((database) => {
    previousIdentity = readSqliteSessionIdentitySnapshot(database, params.sessionTarget.storeKeys);
    deleteSqliteLifecycleTargetRows(database, params.sessionTarget);
    writeSessionEntry(database, params.sessionTarget.canonicalKey, next);
    maintenancePlans.push(
      applySqliteSessionEntryMaintenance(database, {
        activeSessionKey: params.sessionTarget.canonicalKey,
        archiveDirectory: resolveSqliteTranscriptArchiveDirectory(params.resolved),
        skipMaintenance: true,
      }),
    );
    currentIdentity = readSqliteSessionIdentitySnapshot(database, params.sessionTarget.storeKeys);
  }, toDatabaseOptions(params.resolved));
  emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
  finalizeSqliteSessionEntryMaintenancePlansBestEffort(params.resolved, maintenancePlans);
  return cloneSessionEntry(next);
}

/** Cleans scoped session lifecycle rows and associated SQLite transcript state. */
export async function cleanupSqliteSessionLifecycleArtifacts(
  params: SessionLifecycleArtifactCleanupParams,
): Promise<SessionLifecycleArtifactCleanupResult> {
  const sessionKeySegmentPrefix = params.sessionKeySegmentPrefix.trim();
  const transcriptContentMarker = params.transcriptContentMarker;
  if (!sessionKeySegmentPrefix || !transcriptContentMarker) {
    return { removedEntries: 0, archivedTranscriptArtifacts: 0 };
  }

  const resolved = resolveSqliteReadScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    storePath: params.storePath,
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const cleanupPlan = planSqliteSessionLifecycleArtifactCleanup(database, {
      archiveRemovedEntryTranscripts: params.archiveRemovedEntryTranscripts !== false,
      archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
      sessionKeySegmentPrefix,
      transcriptContentMarker,
      orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      nowMs: params.nowMs ?? Date.now(),
    });
    const materializedPlans = materializeSqliteSessionStateDeletePlans(cleanupPlan.deletePlans);
    let removedEntries = 0;
    let archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
    runOpenClawAgentWriteTransaction((transactionDb) => {
      removedEntries = deletePlannedSqliteLifecycleArtifactEntries(
        transactionDb,
        cleanupPlan.entries,
      );
      archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(
        transactionDb,
        materializedPlans,
      );
    }, toDatabaseOptions(resolved));
    emitCommittedSessionEntryRemovals(cleanupPlan.entries);
    return {
      removedEntries,
      archivedTranscriptArtifacts: archivedTranscripts.length,
    };
  });
}

/** Resets one persisted session entry using SQLite session rows. */
export async function resetSqliteSessionEntryLifecycle(
  params: ResetSessionEntryLifecycleParams,
): Promise<ResetSessionEntryLifecycleResult> {
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId: params.agentId });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const targetSnapshot = readSqliteLifecycleTargetSnapshot(database, params.target);
    const current = targetSnapshot.primary;
    const nextEntry = await params.buildNextEntry({
      currentEntry: current ? cloneSessionEntry(current.entry) : undefined,
      primaryKey: params.target.canonicalKey,
    });
    const mutation: ResetSessionEntryLifecycleMutation = {
      nextEntry: cloneSessionEntry(nextEntry),
      ...(current ? { previousEntry: cloneSessionEntry(current.entry) } : {}),
      ...(current?.entry.sessionFile ? { previousSessionFile: current.entry.sessionFile } : {}),
      ...(current?.entry.sessionId ? { previousSessionId: current.entry.sessionId } : {}),
    };
    let archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
    const referencedAfterReset = current?.entry.sessionId
      ? readReferencedSqliteSessionIdsAfterTargetMutation(database, params.target, nextEntry)
      : new Set<string>();
    const deletePlans = current?.entry.sessionId
      ? planSqliteSessionStateAfterEntryRemoval({
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          database,
          entry: current.entry,
          reason: "reset",
          referencedSessionIds: referencedAfterReset,
        })
      : [];
    const materializedPlans = materializeSqliteSessionStateDeletePlans(deletePlans);
    runOpenClawAgentWriteTransaction((transactionDb) => {
      assertSqliteLifecycleTargetUnchanged(transactionDb, params.target, current?.entry, "reset");
      deleteSqliteLifecycleTargetRows(transactionDb, params.target);
      writeSessionEntry(transactionDb, params.target.canonicalKey, nextEntry);
      archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(
        transactionDb,
        materializedPlans,
      );
    }, toDatabaseOptions(resolved));
    if (current) {
      emitSessionIdentityMutation({
        kind: "reset",
        previous: {
          ...(current.entry.sessionId ? { sessionId: current.entry.sessionId } : {}),
          sessionKeys: targetSnapshot.rows.map((row) => row.sessionKey),
        },
        current: {
          ...(nextEntry.sessionId ? { sessionId: nextEntry.sessionId } : {}),
          sessionKeys: [params.target.canonicalKey],
        },
      });
    } else {
      emitSessionIdentityMutation({
        kind: "create",
        previous: { sessionKeys: [] },
        current: {
          ...(nextEntry.sessionId ? { sessionId: nextEntry.sessionId } : {}),
          sessionKeys: [params.target.canonicalKey],
        },
      });
    }
    await params.afterEntryMutation?.(mutation);
    emitArchivedSqliteTranscriptUpdates(archivedTranscripts);
    return {
      ...mutation,
      archivedTranscripts,
    };
  });
}

async function deleteSqliteSessionEntryLifecycleInternal(
  params: DeleteSessionEntryLifecycleParams,
  allowLockedEntryRemoval: boolean,
  expectedPluginOwnerId?: string,
): Promise<DeleteSessionEntryLifecycleResult> {
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId: params.agentId });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let result: DeleteSessionEntryLifecycleResult = {
      archivedTranscripts: [],
      deleted: false,
    };
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const targetSnapshot = readSqliteLifecycleTargetSnapshot(database, params.target);
    const current = targetSnapshot.primary;
    if (!current) {
      return result;
    }
    if (current.entry.modelSelectionLocked === true && !allowLockedEntryRemoval) {
      throw new Error(MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
    }
    if (
      expectedPluginOwnerId &&
      targetSnapshot.rows.some(
        ({ entry, sessionKey }) =>
          isAgentHarnessSessionKey(sessionKey) ||
          entry.agentHarnessId !== undefined ||
          entry.modelSelectionLocked !== true ||
          normalizeOptionalString(entry.pluginOwnerId) !== expectedPluginOwnerId,
      )
    ) {
      throw new Error(MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
    }
    const referencedAfterDelete = readReferencedSqliteSessionIdsAfterTargetMutation(
      database,
      params.target,
    );
    // SQLite transcript state is keyed by session id; sessionFile is only its
    // marker. Materialization dedupes aliases that share the same state owner.
    const deletePlans = params.archiveTranscript
      ? targetSnapshot.rows.flatMap(({ entry }) =>
          planSqliteSessionStateAfterEntryRemoval({
            archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
            archiveTranscript: true,
            database,
            entry,
            reason: "deleted",
            referencedSessionIds: referencedAfterDelete,
          }),
        )
      : [];
    const materializedPlans = materializeSqliteSessionStateDeletePlans(deletePlans);
    runOpenClawAgentWriteTransaction((transactionDb) => {
      const transactionSnapshot = readSqliteLifecycleTargetSnapshot(transactionDb, params.target);
      assertSqliteLifecycleTargetSnapshotUnchanged(
        targetSnapshot,
        transactionSnapshot,
        "delete session entry",
      );
      const transactionEntry = transactionSnapshot.primary?.entry;
      if (!shouldDeleteSqliteSessionEntryLifecycle(transactionEntry, params)) {
        return;
      }
      deleteSqliteLifecycleTargetRows(transactionDb, params.target);
      const archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(
        transactionDb,
        materializedPlans,
      );
      result = {
        archivedTranscripts,
        deleted: true,
        deletedEntry: cloneSessionEntry(current.entry),
        ...(current.entry.sessionFile ? { deletedSessionFile: current.entry.sessionFile } : {}),
        ...(current.entry.sessionId ? { deletedSessionId: current.entry.sessionId } : {}),
      };
    }, toDatabaseOptions(resolved));
    if (result.deleted) {
      emitSessionIdentityMutation({
        kind: "delete",
        previous: {
          ...(current.entry.sessionId ? { sessionId: current.entry.sessionId } : {}),
          sessionKeys: targetSnapshot.rows.map((row) => row.sessionKey),
        },
      });
    }
    emitArchivedSqliteTranscriptUpdates(result.archivedTranscripts);
    return result;
  });
}

/** Deletes one persisted session entry using SQLite session rows. */
export async function deleteSqliteSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams,
): Promise<DeleteSessionEntryLifecycleResult> {
  return await deleteSqliteSessionEntryLifecycleInternal(params, false);
}

/** Rolls back one exact locked row created by failed trusted harness initialization. */
export async function rollbackSqliteAgentHarnessSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams & { expectedEntry: SessionEntry },
): Promise<DeleteSessionEntryLifecycleResult> {
  const hasExactTarget =
    params.target.storeKeys.length === 1 &&
    params.target.storeKeys[0] === params.target.canonicalKey;
  const expectedEntryError = resolveAgentHarnessSessionStoreEntryError(
    params.target.canonicalKey,
    params.expectedEntry,
  );
  if (
    !hasExactTarget ||
    expectedEntryError ||
    !isValidAgentHarnessSessionStoreEntry(params.target.canonicalKey, params.expectedEntry)
  ) {
    throw new Error(expectedEntryError ?? MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
  }
  return await deleteSqliteSessionEntryLifecycleInternal(params, true);
}

/** Rolls back one exact locked CLI row created by a failed plugin initializer. */
export async function rollbackSqlitePluginOwnedSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams & {
    expectedEntry: SessionEntry;
    expectedPluginOwnerId: string;
  },
): Promise<DeleteSessionEntryLifecycleResult> {
  const expectedEntry = params.expectedEntry;
  const validPluginOwner = normalizeOptionalString(expectedEntry.pluginOwnerId);
  const expectedPluginOwner = normalizeOptionalString(params.expectedPluginOwnerId);
  if (
    isAgentHarnessSessionKey(params.target.canonicalKey) ||
    expectedEntry.agentHarnessId !== undefined ||
    expectedEntry.modelSelectionLocked !== true ||
    !validPluginOwner ||
    validPluginOwner !== expectedPluginOwner
  ) {
    throw new Error(MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
  }
  return await deleteSqliteSessionEntryLifecycleInternal(params, true, expectedPluginOwner);
}

/** Applies prepared full-row replacements in one validated SQLite transaction. */
export async function applySqliteSessionEntryReplacements<T>(params: {
  activeSessionKey?: string;
  agentId?: string;
  requireWriteSuccess?: boolean;
  sessionKeys?: readonly string[];
  statuses?: readonly SessionEntryStatus[];
  skipMaintenance?: boolean;
  storePath: string;
  update: (
    entries: SessionEntryReplacementSnapshot[],
  ) => Promise<SessionEntryReplacementUpdate<T>> | SessionEntryReplacementUpdate<T>;
}): Promise<T> {
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.activeSessionKey ?? params.sessionKeys?.[0] ?? "",
    storePath: params.storePath,
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const selectedKeys = params.sessionKeys ? new Set(params.sessionKeys) : undefined;
    const selectedStatuses = params.statuses ? new Set(params.statuses) : undefined;
    const entries = selectedStatuses
      ? readSqliteSessionEntriesByStatus(database, [...selectedStatuses], params.sessionKeys)
      : selectedKeys
        ? [...selectedKeys].flatMap((sessionKey) => {
            const entry = readExactSessionEntryRow(database, sessionKey)?.entry;
            return entry ? [{ entry: cloneSessionEntry(entry), sessionKey }] : [];
          })
        : Object.entries(readSqliteSessionEntryStore(database)).map(([sessionKey, entry]) => ({
            entry: cloneSessionEntry(entry),
            sessionKey,
          }));
    // Exact-key selection keeps the established missing-row no-op contract.
    // Status selection authorizes only rows that actually matched the indexed projection.
    const replacementAuthorityKeys = selectedStatuses
      ? new Set(entries.map(({ sessionKey }) => sessionKey))
      : selectedKeys;
    const operation = await params.update(
      entries.map(({ entry, sessionKey }) => ({
        entry: cloneSessionEntry(entry),
        sessionKey,
      })),
    );
    const replacements = [...(operation.replacements ?? [])];
    for (const replacement of replacements) {
      if (replacementAuthorityKeys && !replacementAuthorityKeys.has(replacement.sessionKey)) {
        const selectionName = selectedStatuses ? "row" : "key";
        throw new Error(
          `Session entry replacement is outside the selected ${selectionName} set: ${replacement.sessionKey}`,
        );
      }
    }

    const expectedEntries = new Map(entries.map(({ sessionKey, entry }) => [sessionKey, entry]));
    const applicable = replacements.filter((replacement) =>
      expectedEntries.has(replacement.sessionKey),
    );
    if (params.requireWriteSuccess && replacements.length > 0 && applicable.length === 0) {
      throw new Error("session entry replacements did not persist any rows");
    }
    if (applicable.length === 0) {
      return operation.result;
    }

    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    runOpenClawAgentWriteTransaction(
      (transactionDb) => {
        for (const replacement of applicable) {
          const current = readExactSessionEntryRow(transactionDb, replacement.sessionKey)?.entry;
          if (!sqliteSessionEntriesEqual(current, expectedEntries.get(replacement.sessionKey))) {
            throw new Error(
              `SQLite session entry changed before replacement for ${replacement.sessionKey}`,
            );
          }
        }
        for (const replacement of applicable) {
          writeSessionEntry(
            transactionDb,
            replacement.sessionKey,
            cloneSessionEntry(replacement.entry),
          );
        }
        maintenancePlans.push(
          applySqliteSessionEntryMaintenance(transactionDb, {
            activeSessionKey: params.activeSessionKey ?? "",
            archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
            skipMaintenance: params.skipMaintenance ?? true,
          }),
        );
      },
      toDatabaseOptions(resolved),
      { operationLabel: "session.entry-replacements" },
    );
    const finalReplacements = new Map(
      applicable.map((replacement) => [replacement.sessionKey, replacement] as const),
    );
    for (const replacement of finalReplacements.values()) {
      const previousEntry = expectedEntries.get(replacement.sessionKey);
      if (previousEntry) {
        emitCommittedSessionEntryChange({
          currentEntry: replacement.entry,
          currentKey: replacement.sessionKey,
          previousEntry,
          previousKey: replacement.sessionKey,
        });
      }
    }
    finalizeSqliteSessionEntryMaintenancePlansBestEffort(resolved, maintenancePlans);
    return operation.result;
  });
}

/**
 * Applies a detached whole-store projection under the SQLite writer lane.
 * This exists only for bounded compatibility adapters that must preserve a
 * legacy serialized callback without exposing mutable storage internals.
 */
export async function applySqliteSessionStoreProjection<T>(params: {
  activeSessionKey?: string;
  agentId?: string;
  skipMaintenance?: boolean;
  storePath: string;
  update: (store: Record<string, SessionEntry>) =>
    | Promise<{ persist: boolean; result: T }>
    | {
        persist: boolean;
        result: T;
      };
}): Promise<T> {
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.activeSessionKey ?? "",
    storePath: params.storePath,
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const before = readSqliteSessionEntryStore(database);
    const projected = structuredClone(before);
    const operation = await params.update(projected);
    if (!operation.persist) {
      return operation.result;
    }
    const lockedEntriesBefore = new Map(
      Object.entries(before).filter(([, entry]) => entry.modelSelectionLocked === true),
    );
    const transitionError = resolveAgentHarnessSessionStoreTransitionError({
      before: lockedEntriesBefore,
      store: projected,
    });
    const storeError = resolveAgentHarnessSessionStoreError(projected);
    if (transitionError || storeError) {
      throw new Error(transitionError ?? storeError);
    }

    const changedKeys = uniqueStrings([...Object.keys(before), ...Object.keys(projected)]).filter(
      (sessionKey) => !sqliteSessionEntriesEqual(before[sessionKey], projected[sessionKey]),
    );
    if (changedKeys.length === 0) {
      return operation.result;
    }

    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    runOpenClawAgentWriteTransaction(
      (transactionDb) => {
        for (const sessionKey of changedKeys) {
          const current = readExactSessionEntryRow(transactionDb, sessionKey)?.entry;
          if (!sqliteSessionEntriesEqual(current, before[sessionKey])) {
            throw new Error(
              `SQLite session entry changed before store projection for ${sessionKey}`,
            );
          }
        }
        for (const sessionKey of changedKeys) {
          const entry = projected[sessionKey];
          if (entry) {
            writeSessionEntry(transactionDb, sessionKey, cloneSessionEntry(entry));
          } else {
            deleteSqliteSessionEntryRows(transactionDb, sessionKey);
          }
        }
        maintenancePlans.push(
          applySqliteSessionEntryMaintenance(transactionDb, {
            activeSessionKey: params.activeSessionKey ?? "",
            archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
            skipMaintenance: params.skipMaintenance,
          }),
        );
      },
      toDatabaseOptions(resolved),
      { operationLabel: "session.store-projection" },
    );
    finalizeSqliteSessionEntryMaintenancePlansBestEffort(resolved, maintenancePlans);
    return operation.result;
  });
}

/** Applies exact lifecycle removals/upserts using SQLite session rows. */
export async function applySqliteSessionEntryLifecycleMutation(params: {
  agentId?: string;
  storePath: string;
  removals?: Iterable<SessionEntryLifecycleRemoval>;
  upserts?: Iterable<SessionEntryLifecycleUpsert>;
  activeSessionKey?: string;
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
  skipMaintenance?: boolean;
  cleanupArchivedTranscripts?: {
    rules: SessionArchivedTranscriptCleanupRule[];
    nowMs?: number;
  };
  captureArtifactCleanupError?: boolean;
}): Promise<SessionEntryLifecycleMutationResult> {
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: "",
    storePath: params.storePath,
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const removals = [...(params.removals ?? [])];
    const upserts = [...(params.upserts ?? [])];
    const removedSessionKeys: string[] = [];
    let archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    let artifactCleanupError: unknown;
    const captureArtifactCleanupError = (error: unknown): void => {
      if (params.captureArtifactCleanupError === true) {
        artifactCleanupError ??= error;
        return;
      }
      throw error;
    };
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const projected = await projectSqliteSessionEntryLifecycleMutation(database, {
      archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
      removals,
      upserts,
    });
    let materializedRemovalPlans: MaterializedSqliteSessionStateDeletePlan[] = [];
    try {
      materializedRemovalPlans = materializeSqliteSessionStateDeletePlans(projected.deletePlans);
    } catch (error) {
      captureArtifactCleanupError(error);
    }
    runOpenClawAgentWriteTransaction((transactionDb) => {
      for (const removal of projected.removals) {
        const entry = readExactSessionEntryRow(transactionDb, removal.sessionKey)?.entry;
        if (!sqliteSessionEntriesEqual(entry, removal.expectedEntry)) {
          throw new Error(
            `SQLite session entry changed before lifecycle removal for ${removal.sessionKey}`,
          );
        }
        if (!shouldRemoveSqliteSessionEntry(entry, removal.removal)) {
          continue;
        }
        deleteSqliteSessionEntryRows(transactionDb, removal.sessionKey);
        removedSessionKeys.push(removal.sessionKey);
      }
      for (const { sessionKey, entry, expectedEntry } of projected.upsertedEntries) {
        const currentEntry = readExactSessionEntryRow(transactionDb, sessionKey)?.entry;
        if (!sqliteSessionEntriesEqual(currentEntry, expectedEntry)) {
          throw new Error(`SQLite session entry changed before lifecycle upsert for ${sessionKey}`);
        }
        writeSessionEntry(transactionDb, sessionKey, entry);
      }
      maintenancePlans.push(
        applySqliteSessionEntryMaintenance(transactionDb, {
          activeSessionKey: params.activeSessionKey ?? "",
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
          forceMaintenance: params.maintenanceOverride !== undefined,
          maintenanceConfig: params.maintenanceOverride
            ? { ...resolveMaintenanceConfig(), ...params.maintenanceOverride }
            : undefined,
          skipMaintenance: params.skipMaintenance,
        }),
      );
      archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(
        transactionDb,
        materializedRemovalPlans,
      );
    }, toDatabaseOptions(resolved));
    emitCommittedLifecycleIdentityMutations({ projected, removedSessionKeys });
    const maintenanceArchivedTranscripts = finalizeSqliteSessionEntryMaintenancePlansBestEffort(
      resolved,
      maintenancePlans,
    );
    archivedTranscripts = [...archivedTranscripts, ...maintenanceArchivedTranscripts];
    const afterCount = readSqliteSessionEntryCount(
      openOpenClawAgentDatabase(toDatabaseOptions(resolved)),
    );
    emitArchivedSqliteTranscriptUpdates(archivedTranscripts);
    const archivedTranscriptDirectories = uniqueStrings(
      archivedTranscripts.map((transcript) => path.dirname(transcript.archivedPath)),
    ).toSorted();
    if (archivedTranscriptDirectories.length > 0 && params.cleanupArchivedTranscripts) {
      try {
        const { cleanupArchivedSessionTranscripts } = await loadSessionArchiveRuntime();
        await cleanupArchivedSessionTranscripts({
          directories: archivedTranscriptDirectories,
          rules: params.cleanupArchivedTranscripts.rules,
          nowMs: params.cleanupArchivedTranscripts.nowMs,
        });
      } catch (error) {
        captureArtifactCleanupError(error);
      }
    }
    return {
      removedEntries: removedSessionKeys.length,
      removedSessionKeys,
      archivedTranscriptDirectories,
      unreferencedArtifacts: null,
      maintenanceReport: null,
      afterCount,
      artifactCleanupError,
    };
  });
}

/** Purges entries owned by a deleted agent from SQLite session rows. */
export async function purgeSqliteDeletedAgentSessionEntries(
  params: DeletedAgentSessionEntryPurgeParams,
): Promise<SessionEntryLifecycleMutationResult> {
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId: params.storeAgentId });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const store = readSqliteSessionEntryStore(database);
    const remainingStore = { ...store };
    const entryRemovals: SqliteSessionEntryRemovalPlan[] = [];
    const removedEntriesToArchive: SessionEntry[] = [];
    for (const sessionKey of Object.keys(store)) {
      const ownerAgentId = resolveStoredSessionOwnerAgentId({
        cfg: params.cfg,
        agentId: params.storeAgentId,
        sessionKey,
      });
      if (ownerAgentId !== params.agentId) {
        continue;
      }
      const entry = store[sessionKey];
      if (!entry) {
        continue;
      }
      entryRemovals.push({ expectedEntry: cloneSessionEntry(entry), sessionKey });
      removedEntriesToArchive.push(entry);
      delete remainingStore[sessionKey];
    }
    const referencedSessionIds = collectProjectedReferencedSqliteSessionIds({
      database,
      excludedSessionKeys: entryRemovals.map((removal) => removal.sessionKey),
      projectedStore: remainingStore,
    });
    const deletePlans = removedEntriesToArchive.flatMap((entry) =>
      planSqliteSessionStateAfterEntryRemoval({
        archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
        database,
        entry,
        reason: "deleted",
        referencedSessionIds,
      }),
    );
    const materializedPlans = materializeSqliteSessionStateDeletePlans(deletePlans);
    const removedSessionKeys = entryRemovals.map((removal) => removal.sessionKey);
    let archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
    const maintenancePlans: SqliteSessionEntryMaintenancePlan[] = [];
    runOpenClawAgentWriteTransaction((transactionDb) => {
      deletePlannedSqliteLifecycleArtifactEntries(transactionDb, entryRemovals);
      maintenancePlans.push(
        applySqliteSessionEntryMaintenance(transactionDb, {
          activeSessionKey: "",
          archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
        }),
      );
      archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(
        transactionDb,
        materializedPlans,
      );
    }, toDatabaseOptions(resolved));
    emitCommittedSessionEntryRemovals(entryRemovals);
    archivedTranscripts = [
      ...archivedTranscripts,
      ...finalizeSqliteSessionEntryMaintenancePlansBestEffort(resolved, maintenancePlans),
    ];
    const afterCount = readSqliteSessionEntryCount(
      openOpenClawAgentDatabase(toDatabaseOptions(resolved)),
    );
    emitArchivedSqliteTranscriptUpdates(archivedTranscripts);
    return {
      removedEntries: removedSessionKeys.length,
      removedSessionKeys,
      archivedTranscriptDirectories: uniqueStrings(
        archivedTranscripts.map((transcript) => path.dirname(transcript.archivedPath)),
      ).toSorted(),
      unreferencedArtifacts: null,
      maintenanceReport: null,
      afterCount,
    };
  });
}

/** Fully replaces rows for one transcript in the additive SQLite transcript store. */
export async function replaceSqliteTranscriptEvents(
  scope: SessionTranscriptAccessScope,
  events: TranscriptEvent[],
): Promise<void> {
  const resolved = resolveSqliteTranscriptScope(scope);
  await runExclusiveSqliteSessionWrite(resolved, async () => {
    runOpenClawAgentWriteTransaction((database) => {
      replaceSqliteTranscriptEventsInTransaction(database, resolved, events);
    }, toDatabaseOptions(resolved));
  });
}

/** Fully replaces rows for one transcript synchronously for sync session runtimes. */
export function replaceSqliteTranscriptEventsSync(
  scope: SessionTranscriptAccessScope,
  events: TranscriptEvent[],
): boolean {
  const resolved = resolveSqliteTranscriptScope(scope);
  let replaced = false;
  runOpenClawAgentWriteTransaction((database) => {
    const fresh = readSessionEntryRow(database, resolved.sessionKey);
    if (!fresh || fresh.entry.sessionId !== resolved.sessionId) {
      return;
    }
    replaceSqliteTranscriptEventsInTransaction(database, resolved, events);
    replaced = true;
  }, toDatabaseOptions(resolved));
  return replaced;
}

/** Imports one legacy session entry and its transcript rows for doctor migration. */
export async function importSqliteSessionRows(
  params: SqliteSessionImportRowsParams,
): Promise<SqliteSessionImportRowsResult> {
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.env ? { env: params.env } : {}),
    sessionKey: params.sessionKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let transcriptEvents = 0;
    runOpenClawAgentWriteTransaction((database) => {
      const currentEntry = readSessionEntryRow(database, resolved.sessionKey)?.entry;
      const preservedHarnessId =
        params.entry.agentHarnessId === undefined &&
        currentEntry?.sessionId === params.entry.sessionId &&
        currentEntry.lifecycleRevision === params.entry.lifecycleRevision
          ? currentEntry.agentHarnessId?.trim()
          : undefined;
      // Plugin doctor migrations can claim a legacy session before the full
      // session import runs. Preserve that same-generation canonical owner.
      const importedEntry = {
        ...params.entry,
        ...(preservedHarnessId ? { agentHarnessId: preservedHarnessId } : {}),
        sessionFile: formatSqliteSessionMarkerForScope({
          ...resolved,
          sessionId: params.entry.sessionId,
        }),
      };
      writeSessionEntry(database, resolved.sessionKey, importedEntry);
      if (params.readTranscriptEvents) {
        const transcriptScope = {
          ...resolved,
          sessionId: params.entry.sessionId,
        };
        const existingEventJson = readTranscriptEventJsonSetInTransaction(
          database,
          params.entry.sessionId,
        );
        params.readTranscriptEvents((event) => {
          const eventJson = JSON.stringify(event);
          if (existingEventJson.has(eventJson)) {
            return;
          }
          if (
            appendTranscriptEventInTransaction(database, transcriptScope, event, {
              touchMutation: false,
            })
          ) {
            existingEventJson.add(eventJson);
            transcriptEvents += 1;
          }
        });
      }
      if (params.transcriptMtimeMs !== undefined) {
        advanceTranscriptMutationAtInTransaction(
          database,
          params.entry.sessionId,
          params.transcriptMtimeMs,
        );
      } else if (transcriptEvents > 0) {
        touchTranscriptMutationInTransaction(database, params.entry.sessionId);
      }
    }, toDatabaseOptions(resolved));
    return {
      sessionId: params.entry.sessionId,
      sessionKey: resolved.sessionKey,
      transcriptEvents,
    };
  });
}

/** Appends one raw transcript event to the additive SQLite transcript store. */
export async function appendSqliteTranscriptEvent(
  scope: SessionTranscriptAccessScope,
  event: TranscriptEvent,
): Promise<void> {
  assertNonMessageTranscriptEvent(event);
  const resolved = resolveSqliteTranscriptScope(scope);
  await runExclusiveSqliteSessionWrite(resolved, async () => {
    runOpenClawAgentWriteTransaction((database) => {
      appendTranscriptEventInTransaction(database, resolved, event);
    }, toDatabaseOptions(resolved));
  });
}

/** Appends one raw non-message transcript event synchronously for sync session runtimes. */
export function appendSqliteTranscriptEventSync(
  scope: SessionTranscriptAccessScope,
  event: TranscriptEvent,
): void {
  assertNonMessageTranscriptEvent(event);
  const resolved = resolveSqliteTranscriptScope(scope);
  runOpenClawAgentWriteTransaction((database) => {
    const fresh = readSessionEntryRow(database, resolved.sessionKey);
    if (!fresh || fresh.entry.sessionId !== resolved.sessionId) {
      return;
    }
    appendTranscriptEventInTransaction(database, resolved, event);
  }, toDatabaseOptions(resolved));
}

/** Appends a guarded transcript turn and touches its session row in one queued write. */
export async function appendSqliteExpectedSessionTranscriptTurn(
  scope: SessionTranscriptWriteScope,
  options: {
    config?: import("../types.openclaw.js").OpenClawConfig;
    cwd?: string;
    expectedLifecycleRevision?: string;
    expectedSessionState?: SessionTranscriptTurnExpectedState;
    expectedSessionId: string;
    messages: readonly SessionTranscriptTurnMessageAppend[];
    sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
    sessionFile: string;
    touchSessionEntry?: boolean;
  },
): Promise<SqliteExpectedSessionTranscriptTurnResult> {
  const resolved = resolveSqliteTranscriptScope({
    ...scope,
    sessionId: options.expectedSessionId,
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const preparedEntry = readSessionEntryRow(database, resolved.sessionKey);
    if (!sessionMatchesExpectedTranscriptTurn(preparedEntry, options)) {
      return sqliteSessionTranscriptTurnRebound(preparedEntry, options.sessionFile);
    }
    const messages = await selectAppendableSqliteTranscriptTurnMessages(
      {
        agentId: resolved.agentId,
        sessionFile: options.sessionFile,
        sessionId: options.expectedSessionId,
        sessionKey: resolved.sessionKey,
        ...(scope.storePath ? { storePath: scope.storePath } : {}),
      },
      options.messages,
    );
    let result: SqliteExpectedSessionTranscriptTurnResult = sqliteSessionTranscriptTurnRebound(
      preparedEntry,
      options.sessionFile,
    );
    let previousIdentity = new Map<string, SessionEntry>();
    let currentIdentity = new Map<string, SessionEntry>();
    runOpenClawAgentWriteTransaction((transactionDb) => {
      const fresh = readSessionEntryRow(transactionDb, resolved.sessionKey);
      if (!sessionMatchesExpectedTranscriptTurn(fresh, options)) {
        result = sqliteSessionTranscriptTurnRebound(fresh, options.sessionFile);
        return;
      }
      const appendedMessages: TranscriptMessageAppendResult<unknown>[] = [];
      for (const append of messages) {
        const { shouldAppend: _shouldAppend, ...appendOptions } = append;
        const appended = appendSqliteTranscriptMessageInTransaction(transactionDb, resolved, {
          ...appendOptions,
          ...((append.cwd ?? options.cwd) ? { cwd: append.cwd ?? options.cwd } : {}),
          ...((append.config ?? options.config) ? { config: append.config ?? options.config } : {}),
        });
        if (appended) {
          appendedMessages.push(appended);
        }
      }

      const sessionPatch = buildExpectedTranscriptTurnSessionPatch({
        appendedMessages,
        currentEntry: fresh.entry,
        expectedSessionState: options.expectedSessionState,
        sessionFile: options.sessionFile,
        sessionLifecyclePatch: options.sessionLifecyclePatch,
        touchSessionEntry: options.touchSessionEntry,
      });
      const next =
        Object.keys(sessionPatch).length > 0
          ? mergeSessionEntry(fresh.entry, sessionPatch)
          : fresh.entry;
      if (next !== fresh.entry) {
        const identityKeys = collectSessionEntryLookupKeys(transactionDb, resolved.sessionKey);
        previousIdentity = readSqliteSessionIdentitySnapshot(transactionDb, identityKeys);
        writeSessionEntry(transactionDb, resolved.sessionKey, next);
        deleteLegacySessionEntryRows(transactionDb, fresh.legacyKeys, resolved.sessionKey);
        currentIdentity = readSqliteSessionIdentitySnapshot(transactionDb, identityKeys);
      }
      result = {
        appendedMessages,
        sessionEntry: cloneSessionEntry(next),
        sessionFile: options.sessionFile,
      };
    }, toDatabaseOptions(resolved));
    emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
    return result;
  });
}

function sqliteSessionTranscriptTurnRebound(
  selected: ResolvedSessionEntryRow | undefined,
  sessionFile: string,
): SqliteExpectedSessionTranscriptTurnResult {
  return {
    appendedMessages: [],
    rejectedReason: "session-rebound",
    sessionEntry: selected?.entry,
    sessionFile,
  };
}

async function selectAppendableSqliteTranscriptTurnMessages(
  context: SessionTranscriptTurnWriteContext,
  messages: readonly SessionTranscriptTurnMessageAppend[],
): Promise<SessionTranscriptTurnMessageAppend[]> {
  const selected: SessionTranscriptTurnMessageAppend[] = [];
  for (const append of messages) {
    const shouldAppend = append.shouldAppend ? await append.shouldAppend(context) : true;
    if (shouldAppend) {
      selected.push(append);
    }
  }
  return selected;
}

/** Appends one transcript message to the additive SQLite transcript store. */
export async function appendSqliteTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage> & {
    prepareMessageAfterIdempotencyCheck: (message: TMessage) => TMessage | undefined;
  },
): Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
export async function appendSqliteTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage>>;
export async function appendSqliteTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage> | undefined> {
  const resolved = resolveSqliteTranscriptScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let result: TranscriptMessageAppendResult<TMessage> | undefined;
    runOpenClawAgentWriteTransaction((database) => {
      result = appendSqliteTranscriptMessageInTransaction(database, resolved, options);
    }, toDatabaseOptions(resolved));
    return result;
  });
}

/** Appends one transcript message synchronously for sync session runtimes. */
export function appendSqliteTranscriptMessageSync<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): TranscriptMessageAppendResult<TMessage> | undefined {
  const resolved = resolveSqliteTranscriptScope(scope);
  let result: TranscriptMessageAppendResult<TMessage> | undefined;
  runOpenClawAgentWriteTransaction((database) => {
    const fresh = readSessionEntryRow(database, resolved.sessionKey);
    if (!fresh || fresh.entry.sessionId !== resolved.sessionId) {
      return;
    }
    result = appendSqliteTranscriptMessageInTransaction(database, resolved, options);
  }, toDatabaseOptions(resolved));
  return result;
}

/** Runs read/append transcript work under one SQLite writer-queue critical section. */
export async function withSqliteTranscriptWriteLock<T>(
  scope: SessionTranscriptWriteScope,
  run: (context: SqliteTranscriptWriteLockContext) => Promise<T> | T,
): Promise<T> {
  const resolved = resolveSqliteTranscriptScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    let transcriptSnapshot: SqliteTranscriptSnapshotState | undefined;
    return await run({
      readEvents: async () => {
        const snapshot = readSqliteTranscriptSnapshot(database, resolved.sessionId);
        transcriptSnapshot = { kind: "current", rows: snapshot.rows };
        return snapshot.events;
      },
      replaceEvents: async (events) => {
        if (transcriptSnapshot?.kind === "stale") {
          throw new SqliteTranscriptMutationConflictError(resolved.sessionId);
        }
        const expectedSnapshot = transcriptSnapshot?.rows;
        const nextSnapshot = runOpenClawAgentWriteTransaction((writeDatabase) => {
          if (expectedSnapshot !== undefined) {
            // The writer queue is process-local. Revalidate after BEGIN IMMEDIATE
            // so a committed cross-process append cannot be deleted by the rewrite.
            assertSqliteTranscriptSnapshotUnchanged(
              writeDatabase,
              resolved.sessionId,
              expectedSnapshot,
            );
          }
          replaceSqliteTranscriptEventsInTransaction(writeDatabase, resolved, events);
          return readSqliteTranscriptSnapshot(writeDatabase, resolved.sessionId).rows;
        }, toDatabaseOptions(resolved));
        transcriptSnapshot = { kind: "current", rows: nextSnapshot };
      },
      appendMessage: async (options) => {
        let result: TranscriptMessageAppendResult<unknown> | undefined;
        const snapshotState = transcriptSnapshot;
        let nextSnapshotState = snapshotState;
        runOpenClawAgentWriteTransaction((writeDatabase) => {
          const snapshotStillCurrent =
            snapshotState?.kind === "current"
              ? isSqliteTranscriptSnapshotUnchanged(
                  writeDatabase,
                  resolved.sessionId,
                  snapshotState.rows,
                )
              : false;
          result = appendSqliteTranscriptMessageInTransaction(writeDatabase, resolved, options);
          if (snapshotState?.kind === "current") {
            nextSnapshotState = snapshotStillCurrent
              ? {
                  kind: "current",
                  rows: readSqliteTranscriptSnapshot(writeDatabase, resolved.sessionId).rows,
                }
              : { kind: "stale" };
          }
        }, toDatabaseOptions(resolved));
        transcriptSnapshot = nextSnapshotState;
        return result as TranscriptMessageAppendResult<typeof options.message> | undefined;
      },
    });
  });
}

/** Runs synchronous transcript work under one writer queue and SQLite transaction. */
export async function withSqliteTranscriptWriteTransaction<T>(
  scope: SessionTranscriptWriteScope,
  run: (context: { sessionFile: string }) => T,
): Promise<T> {
  const resolved = resolveSqliteTranscriptScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () =>
    runOpenClawAgentWriteTransaction(
      () => run({ sessionFile: formatSqliteSessionMarkerForScope(resolved) }),
      toDatabaseOptions(resolved),
      { operationLabel: "session.transcript.batch" },
    ),
  );
}

function isSqliteTranscriptSnapshotUnchanged(
  database: OpenClawAgentDatabase,
  sessionId: string,
  expected: readonly SqliteTranscriptSnapshotRow[],
): boolean {
  const current = readSqliteTranscriptSnapshot(database, sessionId).rows;
  return (
    current.length === expected.length &&
    current.every(
      (row, index) =>
        row.seq === expected[index]?.seq && row.eventJson === expected[index]?.eventJson,
    )
  );
}

function assertSqliteTranscriptSnapshotUnchanged(
  database: OpenClawAgentDatabase,
  sessionId: string,
  expected: readonly SqliteTranscriptSnapshotRow[],
): void {
  if (!isSqliteTranscriptSnapshotUnchanged(database, sessionId, expected)) {
    throw new SqliteTranscriptMutationConflictError(sessionId);
  }
}

function appendSqliteTranscriptMessageInTransaction<TMessage>(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): TranscriptMessageAppendResult<TMessage> | undefined {
  const idempotencyKey = readMessageIdempotencyKey(options.message);
  if (idempotencyKey && options.idempotencyLookup !== "caller-checked") {
    const existing = readTranscriptMessageByScopedIdempotencyKey(
      database,
      resolved,
      idempotencyKey,
      options.idempotencyLookup,
    );
    if (existing) {
      return {
        appended: false,
        message: existing.message as TMessage,
        messageId: existing.messageId,
      };
    }
  }

  const prepared = options.prepareMessageAfterIdempotencyCheck
    ? options.prepareMessageAfterIdempotencyCheck(options.message)
    : options.message;
  if (prepared === undefined) {
    return undefined;
  }

  const messageId = options.eventId ?? randomUUID();
  const now = options.now ?? Date.now();
  const finalMessage = redactTranscriptMessageForStorage(prepared, options);
  ensureTranscriptHeader(database, resolved, options.cwd, now);
  const parentId =
    options.parentId === undefined
      ? readActiveTranscriptAppendParentId(database, resolved.sessionId)
      : options.parentId;
  const event = {
    type: "message",
    id: messageId,
    parentId: parentId ?? null,
    timestamp: resolveTimestampMsToIsoString(now),
    message: finalMessage,
  };
  const appended = appendTranscriptEventInTransaction(database, resolved, event, {
    dedupeByMessageIdempotency:
      options.idempotencyLookup !== "caller-checked" &&
      options.idempotencyLookup !== "scan-assistant",
  });
  if (!appended && idempotencyKey && options.idempotencyLookup !== "caller-checked") {
    const existing = readTranscriptMessageByScopedIdempotencyKey(
      database,
      resolved,
      idempotencyKey,
      options.idempotencyLookup,
    );
    if (existing) {
      return {
        appended: false,
        message: existing.message as TMessage,
        messageId: existing.messageId,
      };
    }
  }
  if (!appended) {
    const existing = readTranscriptMessageByEventId(database, resolved, messageId);
    if (existing) {
      return {
        appended: false,
        message: existing.message as TMessage,
        messageId: existing.messageId,
      };
    }
  }
  if (!appended) {
    throw new Error(`SQLite transcript append did not insert message ${messageId}.`);
  }
  return {
    appended: true,
    message: finalMessage,
    messageId,
  };
}

/** Branches a SQLite session from a compaction checkpoint in one queued transaction. */
export async function branchSqliteCompactionCheckpointSession(
  params: SqliteBranchCheckpointSessionParams,
): Promise<SqliteCompactionCheckpointSessionMutationResult> {
  const sourceKey = normalizeSqliteSessionKey(params.sourceStoreKey ?? params.sourceKey);
  const targetKey = normalizeSqliteSessionKey(params.nextKey);
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.env ? { env: params.env } : {}),
    sessionKey: sourceKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let result: SqliteCompactionCheckpointSessionMutationResult | undefined;
    let previousIdentity = new Map<string, SessionEntry>();
    let currentIdentity = new Map<string, SessionEntry>();
    runOpenClawAgentWriteTransaction((database) => {
      const identityKeys = uniqueStrings([
        ...collectSessionEntryLookupKeys(database, sourceKey),
        ...collectSessionEntryLookupKeys(database, targetKey),
      ]);
      previousIdentity = readSqliteSessionIdentitySnapshot(database, identityKeys);
      result = branchSqliteCompactionCheckpointSessionInTransaction(database, {
        checkpointId: params.checkpointId,
        parentSessionKey: normalizeSqliteSessionKey(params.sourceKey),
        resolved,
        sourceKey,
        targetKey,
      });
      currentIdentity = readSqliteSessionIdentitySnapshot(database, identityKeys);
    }, toDatabaseOptions(resolved));
    emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
    return result ?? { status: "failed" };
  });
}

/** Restores a SQLite session from a compaction checkpoint in one queued transaction. */
export async function restoreSqliteCompactionCheckpointSession(
  params: SqliteRestoreCheckpointSessionParams,
): Promise<SqliteCompactionCheckpointSessionMutationResult> {
  const sessionKey = normalizeSqliteSessionKey(params.sessionStoreKey ?? params.sessionKey);
  const targetKey = normalizeSqliteSessionKey(params.sessionKey);
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.env ? { env: params.env } : {}),
    sessionKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let result: SqliteCompactionCheckpointSessionMutationResult | undefined;
    let previousIdentity = new Map<string, SessionEntry>();
    let currentIdentity = new Map<string, SessionEntry>();
    runOpenClawAgentWriteTransaction((database) => {
      const identityKeys = uniqueStrings([
        ...collectSessionEntryLookupKeys(database, sessionKey),
        ...collectSessionEntryLookupKeys(database, targetKey),
      ]);
      previousIdentity = readSqliteSessionIdentitySnapshot(database, identityKeys);
      result = restoreSqliteCompactionCheckpointSessionInTransaction(database, {
        checkpointId: params.checkpointId,
        resolved,
        sourceKey: sessionKey,
        targetKey,
      });
      currentIdentity = readSqliteSessionIdentitySnapshot(database, identityKeys);
    }, toDatabaseOptions(resolved));
    emitCommittedSessionIdentityDiff(previousIdentity, currentIdentity);
    return result ?? { status: "failed" };
  });
}

/** Publishes a transcript update using the SQLite transcript scope target. */
export async function publishSqliteTranscriptUpdate(
  scope: SessionTranscriptWriteScope,
  update: TranscriptUpdatePayload = {},
): Promise<void> {
  const resolved = resolveSqliteTranscriptScope(scope);
  emitSessionTranscriptUpdate({
    ...update,
    agentId: resolved.agentId,
    sessionKey: resolved.sessionKey,
    sessionId: resolved.sessionId,
    target: {
      agentId: resolved.agentId,
      sessionId: resolved.sessionId,
      sessionKey: resolved.sessionKey,
    },
  });
}

function readSqliteSessionIdentitySnapshot(
  database: OpenClawAgentDatabase,
  sessionKeys: Iterable<string>,
): Map<string, SessionEntry> {
  const snapshot = new Map<string, SessionEntry>();
  for (const sessionKey of uniqueStrings([...sessionKeys].map((key) => key.trim()))) {
    const row = readExactSessionEntryRow(database, sessionKey);
    if (row) {
      snapshot.set(sessionKey, cloneSessionEntry(row.entry));
    }
  }
  return snapshot;
}

function createSqliteSessionIdentitySnapshot(
  rows: readonly { entry: SessionEntry; sessionKey: string }[],
): Map<string, SessionEntry> {
  return new Map(rows.map((row) => [row.sessionKey, cloneSessionEntry(row.entry)]));
}

function assertNonMessageTranscriptEvent(event: TranscriptEvent): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return;
  }
  // Message records require parent-link, idempotency, and redaction handling
  // from appendSqliteTranscriptMessage; raw event writes would bypass those invariants.
  if ((event as { type?: unknown }).type === "message") {
    throw new Error(
      "appendSqliteTranscriptEvent cannot write message transcript records; use appendSqliteTranscriptMessage instead.",
    );
  }
}

function readSessionEntryRow(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): ResolvedSessionEntryRow | undefined {
  const db = getSessionKysely(database.db);
  const lookupKeys = collectSessionEntryLookupKeys(database, sessionKey);
  if (lookupKeys.length === 0) {
    return undefined;
  }
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_entries")
      .selectAll()
      .where("session_key", "in", lookupKeys)
      .orderBy("session_key", "asc"),
  ).rows;
  const entries = new Map<string, ResolvedSessionEntryRow>();
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    const entry = parseSessionEntryRow(row);
    if (!entry) {
      continue;
    }
    store[row.session_key] = entry;
    entries.set(row.session_key, { entry, legacyKeys: [], row });
  }
  const resolved = resolveSessionStoreEntry({ store, sessionKey });
  if (!resolved.existing) {
    return undefined;
  }
  for (const value of entries.values()) {
    if (value.entry === resolved.existing) {
      return { ...value, legacyKeys: resolved.legacyKeys };
    }
  }
  return undefined;
}

// Async updaters prepare against this complete selection. Capturing alias rows
// prevents the commit phase from deleting a concurrently changed legacy key.
function readSqliteSessionEntrySelectionSnapshot(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  exact: boolean,
): SqliteSessionEntrySelectionSnapshot {
  const selected = exact
    ? readExactSessionEntryRow(database, sessionKey)
    : readSessionEntryRow(database, sessionKey);
  const selectedKeys = collectSessionEntryLookupKeys(database, sessionKey).toSorted();
  return {
    selected,
    selectedRows: selectedKeys.flatMap((candidateKey) => {
      const row = readExactSessionEntryRow(database, candidateKey);
      return row ? [{ entry: cloneSessionEntry(row.entry), sessionKey: candidateKey }] : [];
    }),
  };
}

function assertSqliteSessionEntrySelectionUnchanged(
  expected: SqliteSessionEntrySelectionSnapshot,
  current: SqliteSessionEntrySelectionSnapshot,
  operationLabel: string,
): void {
  const selectedMatches =
    expected.selected?.row.session_key === current.selected?.row.session_key &&
    sqliteSessionEntriesEqual(expected.selected?.entry, current.selected?.entry);
  if (
    !selectedMatches ||
    !sqliteSessionSnapshotRowsEqual(expected.selectedRows, current.selectedRows)
  ) {
    throw new SqliteSessionMutationConflictError(operationLabel);
  }
}

function collectSessionEntryLookupKeys(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): string[] {
  const trimmedKey = sessionKey.trim();
  if (!trimmedKey) {
    return [];
  }
  const normalizedKey = normalizeStoreSessionKey(trimmedKey);
  const lookupKeys = new Set([
    trimmedKey,
    normalizedKey,
    ...foldedSessionKeyAliasCandidates(normalizedKey),
  ]);
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").select("session_key").orderBy("session_key", "asc"),
  ).rows;
  for (const row of rows) {
    if (normalizeStoreSessionKey(row.session_key) === normalizedKey) {
      lookupKeys.add(row.session_key);
    }
  }
  return [...lookupKeys].filter(Boolean);
}

function collectSqliteSessionMaintenanceBaseKeys(
  store: Record<string, SessionEntry>,
  activeSessionKey: string,
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  let currentKey = normalizeStoreSessionKey(activeSessionKey);
  while (currentKey && !seen.has(currentKey)) {
    seen.add(currentKey);
    keys.push(currentKey);
    currentKey = normalizeStoreSessionKey(store[currentKey]?.parentSessionKey ?? "");
  }
  return keys;
}

function sumEventJsonBytes() {
  return (
    // kysely-allow-raw: SQLite byte accounting needs LENGTH(CAST(... AS BLOB)),
    // which Kysely does not expose as a typed aggregate helper.
    sql<number | bigint>`COALESCE(SUM(length(CAST(event_json AS BLOB))), 0)`.as("event_json_bytes")
  );
}

function sumSessionEntryJsonBytes() {
  return (
    // kysely-allow-raw: SQLite byte accounting needs LENGTH(CAST(... AS BLOB)),
    // which Kysely does not expose as a typed aggregate helper.
    sql<number | bigint>`COALESCE(SUM(length(CAST(entry_json AS BLOB))), 0)`.as("entry_json_bytes")
  );
}

function readSqliteSessionRowBytes(database: OpenClawAgentDatabase): SqliteSessionRowBytes {
  const db = getSessionKysely(database.db);
  const entryRows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").select(["session_key", "entry_json"]),
  ).rows;
  const transcriptRows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["session_id"])
      .select(sumEventJsonBytes())
      .groupBy("session_id"),
  ).rows;
  const trajectoryRows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("trajectory_runtime_events")
      .select(["session_id"])
      .select(sumEventJsonBytes())
      .groupBy("session_id"),
  ).rows;
  const entryBytesByKey = new Map<string, number>();
  for (const row of entryRows) {
    entryBytesByKey.set(row.session_key, Buffer.byteLength(row.entry_json, "utf8"));
  }
  const transcriptBytesBySessionId = new Map<string, number>();
  for (const row of transcriptRows) {
    const bytes = row.event_json_bytes;
    transcriptBytesBySessionId.set(row.session_id, normalizeSqliteNumber(bytes ?? 0));
  }
  const trajectoryBytesBySessionId = new Map<string, number>();
  for (const row of trajectoryRows) {
    const bytes = row.event_json_bytes;
    trajectoryBytesBySessionId.set(row.session_id, normalizeSqliteNumber(bytes ?? 0));
  }
  return { entryBytesByKey, trajectoryBytesBySessionId, transcriptBytesBySessionId };
}

function hasSqliteSessionDiskBudgetOverflow(
  database: OpenClawAgentDatabase,
  maintenance: ResolvedSessionMaintenanceConfig,
): boolean {
  if (maintenance.maxDiskBytes == null || maintenance.highWaterBytes == null) {
    return false;
  }
  const db = getSessionKysely(database.db);
  const entryRow = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_entries").select(sumSessionEntryJsonBytes()),
  );
  const transcriptRow = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("transcript_events").select(sumEventJsonBytes()),
  );
  const trajectoryRow = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("trajectory_runtime_events").select(sumEventJsonBytes()),
  );
  const entryBytes = normalizeSqliteNumber(entryRow?.entry_json_bytes ?? 0);
  const transcriptBytes = normalizeSqliteNumber(transcriptRow?.event_json_bytes ?? 0);
  const trajectoryBytes = normalizeSqliteNumber(trajectoryRow?.event_json_bytes ?? 0);
  return entryBytes + transcriptBytes + trajectoryBytes > maintenance.maxDiskBytes;
}

function applySqliteSessionDiskBudget(params: {
  database: OpenClawAgentDatabase;
  store: Record<string, SessionEntry>;
  maintenance: ResolvedSessionMaintenanceConfig;
  preserveKeys: ReadonlySet<string>;
  rememberRemovedEntry: (removed: { key: string; entry: SessionEntry }) => void;
}): void {
  enforceSqliteSessionDiskBudgetInStore({
    database: params.database,
    store: params.store,
    maintenance: params.maintenance,
    preserveKeys: params.preserveKeys,
    onRemoveEntry: params.rememberRemovedEntry,
  });
}

function enforceSqliteSessionDiskBudgetInStore(params: {
  database: OpenClawAgentDatabase;
  store: Record<string, SessionEntry>;
  maintenance: Pick<ResolvedSessionMaintenanceConfig, "maxDiskBytes" | "highWaterBytes">;
  preserveKeys?: ReadonlySet<string>;
  onRemoveEntry?: (removed: { key: string; entry: SessionEntry }) => void;
}): SessionDiskBudgetSweepResult | null {
  return enforceSqliteSessionDiskBudget({
    collectStateIds: collectSqliteSessionStateIdsForEntry,
    maintenance: params.maintenance,
    onRemoveEntry: params.onRemoveEntry,
    preserveKeys: params.preserveKeys,
    rowBytes: readSqliteSessionRowBytes(params.database),
    store: params.store,
  });
}

export function previewSqliteSessionDiskBudget(params: {
  agentId?: string;
  activeSessionKey?: string;
  store: Record<string, SessionEntry>;
  storePath: string;
  maintenance: Pick<ResolvedSessionMaintenanceConfig, "maxDiskBytes" | "highWaterBytes">;
  preserveKeys?: ReadonlySet<string>;
}): { diskBudget: SessionDiskBudgetSweepResult | null; removedKeys: Set<string> } {
  const removedKeys = new Set<string>();
  if (params.maintenance.maxDiskBytes == null || params.maintenance.highWaterBytes == null) {
    return { diskBudget: null, removedKeys };
  }
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: "",
    storePath: params.storePath,
  });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const baseKeys = collectSqliteSessionMaintenanceBaseKeys(
    params.store,
    params.activeSessionKey ?? "",
  );
  const preserveKeys =
    baseKeys.length > 0 || params.preserveKeys
      ? new Set([...(params.preserveKeys ?? []), ...baseKeys])
      : undefined;
  const diskBudget = enforceSqliteSessionDiskBudgetInStore({
    database,
    store: params.store,
    maintenance: params.maintenance,
    preserveKeys,
    onRemoveEntry: ({ key }) => {
      removedKeys.add(key);
    },
  });
  return { diskBudget, removedKeys };
}

function readExactSessionEntryRow(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): ResolvedSessionEntryRow | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_entries").selectAll().where("session_key", "=", sessionKey),
  );
  if (!row) {
    return undefined;
  }
  const entry = parseSessionEntryRow(row);
  return entry ? { entry, legacyKeys: [], row } : undefined;
}

function readSqliteSessionEntryStore(
  database: OpenClawAgentDatabase,
): Record<string, SessionEntry> {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").select(["session_key", "entry_json"]).orderBy("session_key"),
  ).rows;
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    const entry = parseSessionEntryRow(row);
    if (entry) {
      store[row.session_key] = entry;
    }
  }
  return store;
}

function readSqliteSessionEntryCount(database: OpenClawAgentDatabase): number {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_entries").select((eb) => eb.fn.countAll<number>().as("entry_count")),
  );
  const count = row?.entry_count;
  return count === undefined || count === null ? 0 : normalizeSqliteNumber(count);
}

function hasStaleSqliteSessionEntryCandidate(
  database: OpenClawAgentDatabase,
  pruneAfterMs: number,
  preserveKeys: ReadonlySet<string> | undefined,
): boolean {
  const cutoffMs = Date.now() - pruneAfterMs;
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_entries")
      .select("session_key")
      .where("updated_at", "<", cutoffMs)
      .orderBy("updated_at", "asc"),
  ).rows;
  return rows.some((row) => !preserveKeys?.has(normalizeStoreSessionKey(row.session_key)));
}

function resolveSqliteLifecyclePrimaryEntry(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
): { key: string; entry: SessionEntry } | undefined {
  let freshest: { key: string; entry: SessionEntry } | undefined;
  for (const key of target.storeKeys) {
    const row = readExactSessionEntryRow(database, key.trim());
    if (!row) {
      continue;
    }
    if (!freshest || (row.entry.updatedAt ?? 0) > (freshest.entry.updatedAt ?? 0)) {
      freshest = { key, entry: row.entry };
    }
  }
  return freshest ?? undefined;
}

function readSqliteLifecycleTargetSnapshot(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
): SqliteLifecycleTargetSnapshot {
  const normalized = normalizeSqliteLifecycleTarget(target);
  return {
    primary: resolveSqliteLifecyclePrimaryEntry(database, normalized),
    rows: normalized.storeKeys.flatMap((sessionKey) => {
      const row = readExactSessionEntryRow(database, sessionKey);
      return row ? [{ entry: cloneSessionEntry(row.entry), sessionKey }] : [];
    }),
  };
}

function assertSqliteLifecycleTargetSnapshotUnchanged(
  expected: SqliteLifecycleTargetSnapshot,
  current: SqliteLifecycleTargetSnapshot,
  operationLabel: string,
): void {
  const primaryMatches =
    expected.primary?.key === current.primary?.key &&
    sqliteSessionEntriesEqual(expected.primary?.entry, current.primary?.entry);
  if (!primaryMatches || !sqliteSessionSnapshotRowsEqual(expected.rows, current.rows)) {
    throw new SqliteSessionMutationConflictError(operationLabel);
  }
}

function normalizeSqliteLifecycleTarget(target: { canonicalKey: string; storeKeys: string[] }): {
  canonicalKey: string;
  storeKeys: string[];
} {
  const canonicalKey = normalizeSqliteSessionKey(target.canonicalKey);
  return {
    canonicalKey,
    storeKeys: uniqueStrings([canonicalKey, ...target.storeKeys.map(normalizeSqliteSessionKey)]),
  };
}

function deleteSqliteSessionEntryRows(database: OpenClawAgentDatabase, sessionKey: string): void {
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_routes").where("session_key", "=", sessionKey),
  );
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_entries").where("session_key", "=", sessionKey),
  );
}

function deleteSqliteLifecycleTargetRows(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
): void {
  for (const sessionKey of uniqueStrings([target.canonicalKey, ...target.storeKeys])) {
    const trimmed = sessionKey.trim();
    if (trimmed) {
      deleteSqliteSessionEntryRows(database, trimmed);
    }
  }
}

function shouldRemoveSqliteSessionEntry(
  entry: SessionEntry | undefined,
  removal: SessionEntryLifecycleRemoval,
): entry is SessionEntry {
  if (!entry) {
    return false;
  }
  if (
    removal.expectedEntry !== undefined &&
    JSON.stringify(entry) !== JSON.stringify(removal.expectedEntry)
  ) {
    return false;
  }
  if (removal.expectedSessionId !== undefined && entry.sessionId !== removal.expectedSessionId) {
    return false;
  }
  if (
    removal.expectedLifecycleRevision !== undefined &&
    entry.lifecycleRevision !== removal.expectedLifecycleRevision
  ) {
    return false;
  }
  if (removal.expectedUpdatedAt !== undefined && entry.updatedAt !== removal.expectedUpdatedAt) {
    return false;
  }
  return true;
}

function shouldDeleteSqliteSessionEntryLifecycle(
  entry: SessionEntry | undefined,
  params: DeleteSessionEntryLifecycleParams,
): entry is SessionEntry {
  if (!entry) {
    return false;
  }
  if (
    params.expectedEntry !== undefined &&
    !sqliteSessionEntriesEqual(entry, params.expectedEntry)
  ) {
    return false;
  }
  if (params.expectedSessionId !== undefined && entry.sessionId !== params.expectedSessionId) {
    return false;
  }
  if (
    params.expectedLifecycleRevision !== undefined &&
    entry.lifecycleRevision !== params.expectedLifecycleRevision
  ) {
    return false;
  }
  if (params.expectedUpdatedAt !== undefined && entry.updatedAt !== params.expectedUpdatedAt) {
    return false;
  }
  return true;
}

function sqliteSessionEntriesEqual(
  left: SessionEntry | undefined,
  right: SessionEntry | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function sqliteSessionSnapshotRowsEqual(
  left: Array<{ entry: SessionEntry; sessionKey: string }>,
  right: Array<{ entry: SessionEntry; sessionKey: string }>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (row, index) =>
        row.sessionKey === right[index]?.sessionKey &&
        sqliteSessionEntriesEqual(row.entry, right[index]?.entry),
    )
  );
}

function sqliteLifecycleTargetMatchesExpectedEntry(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  expectedEntry: SessionEntry | undefined,
): boolean {
  const current = resolveSqliteLifecyclePrimaryEntry(database, target)?.entry;
  if (!current || !expectedEntry) {
    return current === expectedEntry;
  }
  return sqliteSessionEntriesEqual(current, expectedEntry);
}

function assertSqliteLifecycleTargetUnchanged(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  expectedEntry: SessionEntry | undefined,
  operation: "deleted" | "reset",
): void {
  if (sqliteLifecycleTargetMatchesExpectedEntry(database, target, expectedEntry)) {
    return;
  }
  throw new Error(`SQLite session entry changed before ${operation} lifecycle mutation`);
}

function deleteLegacySessionEntryRows(
  database: OpenClawAgentDatabase,
  legacyKeys: string[],
  sessionKey: string,
): void {
  if (legacyKeys.length === 0) {
    return;
  }
  const db = getSessionKysely(database.db);
  for (const legacyKey of legacyKeys) {
    if (legacyKey === sessionKey) {
      continue;
    }
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_routes").where("session_key", "=", legacyKey),
    );
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_entries").where("session_key", "=", legacyKey),
    );
  }
}

function applySqliteSessionEntryMaintenance(
  database: OpenClawAgentDatabase,
  params: {
    activeSessionKey: string;
    archiveDirectory: string;
    forceMaintenance?: boolean;
    maintenanceConfig?: ResolvedSessionMaintenanceConfig;
    skipMaintenance?: boolean;
  },
): SqliteSessionEntryMaintenancePlan {
  if (params.skipMaintenance) {
    return { entryRemovals: [], stateDeletePlans: [] };
  }
  const maintenance = params.maintenanceConfig ?? resolveMaintenanceConfig();
  if (maintenance.mode === "warn") {
    return { entryRemovals: [], stateDeletePlans: [] };
  }

  const entryCount = readSqliteSessionEntryCount(database);
  const preserveCandidateKeys = collectSessionMaintenancePreserveKeys([params.activeSessionKey]);
  const hasStaleCandidate = hasStaleSqliteSessionEntryCandidate(
    database,
    maintenance.pruneAfterMs,
    preserveCandidateKeys,
  );
  const hasDiskBudgetOverflow = hasSqliteSessionDiskBudgetOverflow(database, maintenance);
  const shouldLoadStore =
    params.forceMaintenance === true ||
    entryCount > maintenance.maxEntries ||
    hasStaleCandidate ||
    hasDiskBudgetOverflow ||
    shouldRunModelRunPrune({
      maintenance,
      entryCount,
      force: params.forceMaintenance,
    }) ||
    shouldRunSessionEntryMaintenance({
      entryCount,
      maxEntries: maintenance.maxEntries,
      force: params.forceMaintenance,
    });
  if (!shouldLoadStore) {
    return { entryRemovals: [], stateDeletePlans: [] };
  }

  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").select(["session_key", "entry_json"]).orderBy("session_key"),
  ).rows;
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    const entry = parseSessionEntryRow(row);
    if (entry) {
      store[row.session_key] = entry;
    }
  }

  const removedKeys = new Set<string>();
  const removedEntriesByKey = new Map<string, SessionEntry>();
  const removedSessionIds = new Set<string>();
  const rememberRemovedEntry = (removed: { key: string; entry: SessionEntry }) => {
    removedKeys.add(removed.key);
    removedEntriesByKey.set(removed.key, cloneSessionEntry(removed.entry));
    for (const sessionId of collectSqliteSessionStateIdsForEntry(removed.entry)) {
      removedSessionIds.add(sessionId);
    }
  };
  const preserveKeys =
    collectSessionMaintenancePreserveKeys(
      collectSqliteSessionMaintenanceBaseKeys(store, params.activeSessionKey),
    ) ?? new Set<string>();
  if (
    shouldRunModelRunPrune({
      maintenance,
      entryCount: Object.keys(store).length,
      force: params.forceMaintenance,
    })
  ) {
    pruneStaleModelRunEntries(store, maintenance.modelRunPruneAfterMs, {
      log: false,
      onPruned: rememberRemovedEntry,
      preserveKeys,
    });
  }
  if (
    params.forceMaintenance === true ||
    hasStaleCandidate ||
    Object.keys(store).length > maintenance.maxEntries
  ) {
    pruneStaleEntries(store, maintenance.pruneAfterMs, {
      log: false,
      onPruned: rememberRemovedEntry,
      preserveKeys,
    });
  }
  if (
    shouldRunSessionEntryMaintenance({
      entryCount: Object.keys(store).length,
      maxEntries: maintenance.maxEntries,
      force: params.forceMaintenance,
    })
  ) {
    capEntryCount(store, maintenance.maxEntries, {
      log: false,
      onCapped: rememberRemovedEntry,
      preserveKeys,
    });
  }
  applySqliteSessionDiskBudget({
    database,
    store,
    maintenance,
    preserveKeys,
    rememberRemovedEntry,
  });

  const referencedSessionIds = collectProjectedReferencedSqliteSessionIds({
    database,
    excludedSessionKeys: removedKeys,
    projectedStore: store,
  });
  const deletePlans: SqliteSessionStateDeletePlan[] = [];
  for (const sessionId of removedSessionIds) {
    const plan = planSqliteSessionStateDeleteIfUnreferenced({
      archiveTranscript: true,
      archiveDirectory: params.archiveDirectory,
      database,
      referencedSessionIds,
      sessionId,
    });
    if (plan) {
      deletePlans.push(plan);
    }
  }
  return {
    entryRemovals: [...removedKeys].map((sessionKey) => ({
      expectedEntry: removedEntriesByKey.get(sessionKey),
      sessionKey,
    })),
    stateDeletePlans: deletePlans,
  };
}

function sessionKeySegmentStartsWith(sessionKey: string, prefix: string): boolean {
  const firstSeparator = sessionKey.indexOf(":");
  if (firstSeparator < 0) {
    return sessionKey.startsWith(prefix);
  }
  const secondSeparator = sessionKey.indexOf(":", firstSeparator + 1);
  const sessionSegment = secondSeparator < 0 ? sessionKey : sessionKey.slice(secondSeparator + 1);
  return sessionSegment.startsWith(prefix);
}

function readSessionTranscriptUpdatedAt(
  database: OpenClawAgentDatabase,
  sessionId: string,
): number | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => eb.fn.max<number | bigint>("created_at").as("updated_at"))
      .where("session_id", "=", sessionId),
  );
  if (row?.updated_at === null || row?.updated_at === undefined) {
    return undefined;
  }
  return normalizeSqliteNumber(row.updated_at);
}

function sqliteTranscriptStateIsReclaimable(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  nowMs: number;
  orphanTranscriptMinAgeMs: number;
}): boolean {
  const updatedAt = readSessionTranscriptUpdatedAt(params.database, params.sessionId);
  return updatedAt === undefined || params.nowMs - updatedAt >= params.orphanTranscriptMinAgeMs;
}

function sqliteTranscriptStateHasMarker(params: {
  database: OpenClawAgentDatabase;
  sessionId: string;
  transcriptContentMarker: string;
}): boolean {
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("transcript_events")
      .select("event_json")
      .where("session_id", "=", params.sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  return rows.some((row) => row.event_json.includes(params.transcriptContentMarker));
}

function readReferencedSqliteSessionIds(database: OpenClawAgentDatabase): Set<string> {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").select(["entry_json", "session_id"]),
  ).rows;
  const sessionIds = new Set<string>();
  for (const row of rows) {
    sessionIds.add(row.session_id);
    const entry = parseSessionEntryRow(row);
    if (!entry) {
      continue;
    }
    for (const sessionId of collectSqliteSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}

// Projects references after a lifecycle mutation so reset/delete can archive
// before removing entry rows while still preserving shared session ids.
function readReferencedSqliteSessionIdsAfterTargetMutation(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  nextEntry?: SessionEntry,
): Set<string> {
  const removedKeys = new Set(
    uniqueStrings([target.canonicalKey, ...target.storeKeys].map((key) => key.trim())),
  );
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").select(["entry_json", "session_key", "session_id"]),
  ).rows;
  const sessionIds = new Set<string>();
  for (const row of rows) {
    if (removedKeys.has(row.session_key)) {
      continue;
    }
    sessionIds.add(row.session_id);
    const entry = parseSessionEntryRow(row);
    if (!entry) {
      continue;
    }
    for (const sessionId of collectSqliteSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  if (nextEntry) {
    for (const sessionId of collectSqliteSessionStateIdsForEntry(nextEntry)) {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}

function readSqliteTranscriptArchiveLines(
  database: OpenClawAgentDatabase,
  sessionId: string,
): string[] {
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select("event_json")
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  ).rows.map((row) => row.event_json);
}

function planSqliteSessionStateDeleteIfUnreferenced(params: {
  archiveTranscript?: boolean;
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  reason?: "deleted" | "reset";
  referencedSessionIds: ReadonlySet<string>;
  sessionId: string;
}): SqliteSessionStateDeletePlan | null {
  if (params.referencedSessionIds.has(params.sessionId)) {
    return null;
  }
  const lines = readSqliteTranscriptArchiveLines(params.database, params.sessionId);
  return {
    archiveDirectory: params.archiveDirectory,
    archiveTranscript: params.archiveTranscript !== false,
    content: serializeJsonlLines(lines),
    hadTranscriptState:
      readSessionTranscriptUpdatedAt(params.database, params.sessionId) !== undefined,
    reason: params.reason ?? "deleted",
    sessionId: params.sessionId,
  };
}

function finalizeSqliteSessionEntryMaintenancePlansBestEffort(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  plans: readonly SqliteSessionEntryMaintenancePlan[],
): SessionLifecycleArchivedTranscript[] {
  const entryRemovals = plans.flatMap((plan) => plan.entryRemovals);
  const stateDeletePlans = plans.flatMap((plan) => plan.stateDeletePlans);
  if (entryRemovals.length === 0 && stateDeletePlans.length === 0) {
    return [];
  }
  try {
    const materializedPlans = materializeSqliteSessionStateDeletePlans(stateDeletePlans);
    let archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
    runOpenClawAgentWriteTransaction((database) => {
      deletePlannedSqliteLifecycleArtifactEntries(database, entryRemovals);
      archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(database, materializedPlans);
    }, toDatabaseOptions(scope));
    emitCommittedSessionEntryRemovals(entryRemovals);
    return archivedTranscripts;
  } catch (error) {
    getChildLogger({ subsystem: "session-sqlite" }).warn(
      "SQLite session maintenance cleanup failed",
      {
        agentId: scope.agentId,
        error,
        path: scope.path,
        sessionIds: uniqueStrings(stateDeletePlans.map((plan) => plan.sessionId)),
      },
    );
    return [];
  }
}

// Revalidates transcript bytes before row deletion so a concurrent append is
// not dropped by an archive prepared from older content.
function deleteMaterializedSqliteSessionStatePlans(
  database: OpenClawAgentDatabase,
  plans: readonly MaterializedSqliteSessionStateDeletePlan[],
): SessionLifecycleArchivedTranscript[] {
  const archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
  const referencedSessionIds = readReferencedSqliteSessionIds(database);
  for (const plan of plans) {
    if (referencedSessionIds.has(plan.sessionId)) {
      continue;
    }
    if (plan.archiveTranscript) {
      const currentContent = serializeJsonlLines(
        readSqliteTranscriptArchiveLines(database, plan.sessionId),
      );
      if (currentContent !== plan.content) {
        throw new Error(`SQLite transcript changed before archive deletion for ${plan.sessionId}`);
      }
    }
    deleteSqliteSessionStateRows(database, plan.sessionId);
    if (plan.hadTranscriptState && plan.archivedTranscript) {
      archivedTranscripts.push(plan.archivedTranscript);
    }
  }
  return archivedTranscripts;
}

// Builds delete plans from the session ids owned by an entry after callers
// have projected which ids remain referenced.
function planSqliteSessionStateAfterEntryRemoval(params: {
  archiveDirectory: string;
  archiveTranscript?: boolean;
  database: OpenClawAgentDatabase;
  entry: SessionEntry;
  reason: "deleted" | "reset";
  referencedSessionIds?: ReadonlySet<string>;
}): SqliteSessionStateDeletePlan[] {
  const referencedSessionIds =
    params.referencedSessionIds ?? readReferencedSqliteSessionIds(params.database);
  const plans: SqliteSessionStateDeletePlan[] = [];
  for (const sessionId of collectSqliteSessionStateIdsForEntry(params.entry)) {
    const plan = planSqliteSessionStateDeleteIfUnreferenced({
      archiveTranscript: params.archiveTranscript,
      archiveDirectory: params.archiveDirectory,
      database: params.database,
      reason: params.reason,
      referencedSessionIds,
      sessionId,
    });
    if (plan) {
      plans.push(plan);
    }
  }
  return plans;
}

// Projects removals and upserts before archive materialization so same-call
// upserts can keep a transcript live without producing a spurious archive.
async function projectSqliteSessionEntryLifecycleMutation(
  database: OpenClawAgentDatabase,
  params: {
    archiveDirectory: string;
    removals: readonly SessionEntryLifecycleRemoval[];
    upserts: readonly SessionEntryLifecycleUpsert[];
  },
): Promise<SqliteProjectedLifecycleMutation> {
  const store = readSqliteSessionEntryStore(database);
  const removedEntries: Array<{ archiveTranscript: boolean; entry: SessionEntry }> = [];
  const changedSessionKeys = new Set<string>();
  const projectedRemovals: SqliteProjectedLifecycleMutation["removals"] = [];
  for (const removal of params.removals) {
    const sessionKey = removal.sessionKey.trim();
    const entry = sessionKey ? store[sessionKey] : undefined;
    if (!shouldRemoveSqliteSessionEntry(entry, removal)) {
      continue;
    }
    projectedRemovals.push({
      expectedEntry: cloneSessionEntry(entry),
      removal,
      sessionKey,
    });
    removedEntries.push({
      archiveTranscript: removal.archiveRemovedTranscript === true,
      entry,
    });
    changedSessionKeys.add(sessionKey);
    delete store[sessionKey];
  }
  const upsertedEntries: SqliteProjectedLifecycleMutation["upsertedEntries"] = [];
  for (const upsert of params.upserts) {
    const sessionKey = upsert.sessionKey.trim();
    if (!sessionKey) {
      continue;
    }
    const expectedEntry = store[sessionKey] ? cloneSessionEntry(store[sessionKey]) : undefined;
    const entry =
      upsert.buildEntry === undefined
        ? upsert.entry
        : await upsert.buildEntry({
            currentEntry: expectedEntry ? cloneSessionEntry(expectedEntry) : undefined,
            sessionKey,
            store,
          });
    if (!entry) {
      continue;
    }
    const cloned = cloneSessionEntry(entry);
    store[sessionKey] = cloned;
    changedSessionKeys.add(sessionKey);
    upsertedEntries.push({ expectedEntry, sessionKey, entry: cloned });
  }
  const referencedSessionIds = collectProjectedReferencedSqliteSessionIds({
    database,
    excludedSessionKeys: changedSessionKeys,
    projectedStore: store,
  });
  const deletePlans = removedEntries.flatMap(({ archiveTranscript, entry }) =>
    planSqliteSessionStateAfterEntryRemoval({
      archiveDirectory: params.archiveDirectory,
      archiveTranscript,
      database,
      entry,
      reason: "deleted",
      referencedSessionIds,
    }),
  );
  return { deletePlans, removals: projectedRemovals, upsertedEntries };
}

// Builds the post-removal reference set from an in-memory projected store.
function collectReferencedSqliteSessionIdsFromStore(
  store: Record<string, SessionEntry>,
): Set<string> {
  const sessionIds = new Set<string>();
  for (const entry of Object.values(store)) {
    for (const sessionId of collectSqliteSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}

// Projected deletes must preserve raw session_entries.session_id references for
// remaining rows whose entry_json cannot be parsed into a SessionEntry.
function collectProjectedReferencedSqliteSessionIds(params: {
  database: OpenClawAgentDatabase;
  excludedSessionKeys: Iterable<string>;
  projectedStore: Record<string, SessionEntry>;
}): Set<string> {
  const excludedSessionKeys = new Set(params.excludedSessionKeys);
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db.selectFrom("session_entries").select(["entry_json", "session_key", "session_id"]),
  ).rows;
  const sessionIds = new Set<string>();
  for (const row of rows) {
    if (excludedSessionKeys.has(row.session_key)) {
      continue;
    }
    sessionIds.add(row.session_id);
    const entry = parseSessionEntryRow(row);
    if (!entry) {
      continue;
    }
    for (const sessionId of collectSqliteSessionStateIdsForEntry(entry)) {
      sessionIds.add(sessionId);
    }
  }
  for (const sessionId of collectReferencedSqliteSessionIdsFromStore(params.projectedStore)) {
    sessionIds.add(sessionId);
  }
  return sessionIds;
}

function collectSqliteSessionStateIdsForEntry(entry: SessionEntry): string[] {
  const sessionIds: string[] = [];
  const add = (sessionId: string | undefined) => {
    const normalized = sessionId?.trim();
    if (normalized) {
      sessionIds.push(normalized);
    }
  };
  add(entry.sessionId);
  for (const sessionId of entry.usageFamilySessionIds ?? []) {
    add(sessionId);
  }
  for (const checkpoint of entry.compactionCheckpoints ?? []) {
    add(checkpoint.sessionId);
    add(checkpoint.preCompaction.sessionId);
    add(checkpoint.postCompaction.sessionId);
  }
  return uniqueStrings(sessionIds);
}

function emitArchivedSqliteTranscriptUpdates(
  archivedTranscripts: readonly SessionLifecycleArchivedTranscript[],
): void {
  for (const archived of archivedTranscripts) {
    emitSessionTranscriptUpdate({ sessionFile: archived.archivedPath });
  }
}

function deleteSqliteSessionStateRows(database: OpenClawAgentDatabase, sessionId: string): void {
  const db = getSessionKysely(database.db);
  // The sessions row cascades canonical transcript tables, but FTS is virtual
  // and its watermark has no cascade; clear both before dropping the owner row.
  deleteSessionTranscriptIndexInTransaction(database.db, sessionId);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("sessions").where("session_id", "=", sessionId),
  );
}

// Plans orphan cleanup without file writes or row deletion; finalization
// handles archive durability before removing rows.
function planSqliteOrphanLifecycleTranscriptStateDeletes(params: {
  archiveRemovedEntryTranscripts: boolean;
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  excludedSessionIds?: ReadonlySet<string>;
  referencedSessionIds: ReadonlySet<string>;
  transcriptContentMarker: string;
  orphanTranscriptMinAgeMs: number;
  nowMs: number;
}): SqliteSessionStateDeletePlan[] {
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db.selectFrom("sessions").select("session_id").orderBy("session_id", "asc"),
  ).rows;

  const deletePlans: SqliteSessionStateDeletePlan[] = [];
  // Orphan transcript state is represented by a sessions row without a live
  // session entry. The marker keeps this scoped to the caller-owned lifecycle.
  for (const row of rows) {
    if (
      params.referencedSessionIds.has(row.session_id) ||
      params.excludedSessionIds?.has(row.session_id)
    ) {
      continue;
    }
    if (
      !sqliteTranscriptStateIsReclaimable({
        database: params.database,
        sessionId: row.session_id,
        nowMs: params.nowMs,
        orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      }) ||
      !sqliteTranscriptStateHasMarker({
        database: params.database,
        sessionId: row.session_id,
        transcriptContentMarker: params.transcriptContentMarker,
      })
    ) {
      continue;
    }
    const plan = planSqliteSessionStateDeleteIfUnreferenced({
      archiveTranscript: params.archiveRemovedEntryTranscripts,
      archiveDirectory: params.archiveDirectory,
      database: params.database,
      reason: "deleted",
      referencedSessionIds: params.referencedSessionIds,
      sessionId: row.session_id,
    });
    if (plan) {
      deletePlans.push(plan);
    }
  }
  return deletePlans;
}

function planSqliteSessionLifecycleArtifactCleanup(
  database: OpenClawAgentDatabase,
  params: {
    archiveRemovedEntryTranscripts: boolean;
    archiveDirectory: string;
    sessionKeySegmentPrefix: string;
    transcriptContentMarker: string;
    orphanTranscriptMinAgeMs: number;
    nowMs: number;
  },
): SqliteLifecycleArtifactCleanupPlan {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_entries")
      .select(["entry_json", "session_key", "session_id"])
      .orderBy("session_key", "asc"),
  ).rows;

  const removedSessionIds = new Set<string>();
  const entries: SqliteLifecycleArtifactCleanupPlan["entries"] = [];
  const projectedStore = readSqliteSessionEntryStore(database);
  for (const row of rows) {
    if (!sessionKeySegmentStartsWith(row.session_key, params.sessionKeySegmentPrefix)) {
      continue;
    }
    if (
      !sqliteTranscriptStateIsReclaimable({
        database,
        sessionId: row.session_id,
        nowMs: params.nowMs,
        orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      })
    ) {
      continue;
    }
    const entry = parseSessionEntryRow(row);
    for (const sessionId of entry
      ? collectSqliteSessionStateIdsForEntry(entry)
      : [row.session_id]) {
      removedSessionIds.add(sessionId);
    }
    entries.push({
      expectedEntry: entry ? cloneSessionEntry(entry) : undefined,
      sessionKey: row.session_key,
    });
    delete projectedStore[row.session_key];
  }

  const referencedSessionIds = collectProjectedReferencedSqliteSessionIds({
    database,
    excludedSessionKeys: entries.map((entry) => entry.sessionKey),
    projectedStore,
  });
  const deletePlans: SqliteSessionStateDeletePlan[] = [];
  for (const sessionId of removedSessionIds) {
    const plan = planSqliteSessionStateDeleteIfUnreferenced({
      archiveTranscript: params.archiveRemovedEntryTranscripts,
      archiveDirectory: params.archiveDirectory,
      database,
      referencedSessionIds,
      sessionId,
    });
    if (plan) {
      deletePlans.push(plan);
    }
  }
  deletePlans.push(
    ...planSqliteOrphanLifecycleTranscriptStateDeletes({
      archiveRemovedEntryTranscripts: params.archiveRemovedEntryTranscripts,
      archiveDirectory: params.archiveDirectory,
      database,
      excludedSessionIds: removedSessionIds,
      referencedSessionIds,
      transcriptContentMarker: params.transcriptContentMarker,
      orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
      nowMs: params.nowMs,
    }),
  );
  return { deletePlans, entries };
}

function deletePlannedSqliteLifecycleArtifactEntries(
  database: OpenClawAgentDatabase,
  entries: readonly SqliteSessionEntryRemovalPlan[],
): number {
  let removedEntries = 0;
  for (const planned of entries) {
    const current = readExactSessionEntryRow(database, planned.sessionKey)?.entry;
    if (!sqliteSessionEntriesEqual(current, planned.expectedEntry)) {
      throw new Error(`SQLite lifecycle cleanup entry changed for ${planned.sessionKey}`);
    }
    deleteSqliteSessionEntryRows(database, planned.sessionKey);
    removedEntries += 1;
  }
  return removedEntries;
}

function writeSessionEntry(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
): void {
  const db = getSessionKysely(database.db);
  const normalizedEntry = normalizeSqliteSessionEntryTimestamp(entry);
  const updatedAt = normalizedEntry.updatedAt;
  const previousEntry = readExactSessionEntryRow(database, sessionKey)?.entry;
  // Registry writes snapshot the current transcript watermark so recovery can
  // distinguish same-millisecond transcript writes before and after this row.
  const transcriptObservedAt =
    readTranscriptMutationStateInTransaction(database, normalizedEntry.sessionId).updatedAt ??
    updatedAt;
  const boundSessionRoot = bindSqliteSessionRoot({
    entry: normalizedEntry,
    sessionKey,
    updatedAt,
  });
  const boundSessionRow = {
    ...boundSessionRoot,
    transcript_observed_at: transcriptObservedAt,
  };
  const sessionRow = resolveSessionEntryProvenanceRow({
    boundSessionRow,
    database,
    entry: normalizedEntry,
    previousEntry,
  });
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("sessions")
      .values(sessionRow)
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          session_key: sessionKey,
          session_scope: sessionRow.session_scope,
          transcript_observed_at: transcriptObservedAt,
          session_entry_provenance: sessionRow.session_entry_provenance,
          acp_owned: sessionRow.acp_owned,
          plugin_owner_id: sessionRow.plugin_owner_id,
          hook_external_content_source: sessionRow.hook_external_content_source,
          updated_at: updatedAt,
          started_at: sessionRow.started_at,
          ended_at: sessionRow.ended_at,
          status: sessionRow.status,
          chat_type: sessionRow.chat_type,
          channel: sessionRow.channel,
          account_id: sessionRow.account_id,
          model_provider: sessionRow.model_provider,
          model: sessionRow.model,
          agent_harness_id: sessionRow.agent_harness_id,
          parent_session_key: sessionRow.parent_session_key,
          spawned_by: sessionRow.spawned_by,
          display_name: sessionRow.display_name,
        }),
      ),
  );
  writeSessionRoute(database, {
    sessionId: sessionRow.session_id,
    sessionKey,
    updatedAt,
  });
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_entries")
      .values({
        session_key: sessionKey,
        session_id: normalizedEntry.sessionId,
        entry_json: JSON.stringify(normalizedEntry),
        updated_at: updatedAt,
        status: normalizeSqliteStatus(normalizedEntry.status),
      })
      .onConflict((conflict) =>
        conflict.column("session_key").doUpdateSet({
          session_id: normalizedEntry.sessionId,
          entry_json: JSON.stringify(normalizedEntry),
          updated_at: updatedAt,
          status: normalizeSqliteStatus(normalizedEntry.status),
        }),
      ),
  );
}

/** Resolves the parent fork decision using SQLite transcript rows when totals are stale. */
export async function resolveSqliteSessionParentForkDecision(params: {
  parentEntry: SessionEntry;
  storePath: string;
}): Promise<SessionParentForkDecision> {
  const parentSessionId =
    typeof params.parentEntry.sessionId === "string" ? params.parentEntry.sessionId : "";
  const needsTranscriptTokenEstimate =
    typeof resolveFreshSessionTotalTokens(params.parentEntry) !== "number" &&
    parentSessionId.length > 0;
  if (!needsTranscriptTokenEstimate) {
    return resolveSqliteParentForkDecision(params.parentEntry);
  }
  const resolved = resolveSqliteStoreScope(params.storePath);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return resolveSqliteParentForkDecision(
    params.parentEntry,
    estimateSqliteTranscriptPromptTokens(
      loadSqliteTranscriptEventsFromDatabase(database, parentSessionId),
    ),
  );
}

function forkSqliteParentTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  params: {
    parentEntry: SessionEntry;
    parentSessionKey: string;
    targetSessionId?: string;
    targetSessionKey: string;
  },
): ForkSessionFromParentTranscriptResult {
  if (!params.parentEntry.sessionId) {
    return { status: "missing-parent" };
  }
  const source = resolveSqliteParentForkSourceTranscript(
    loadSqliteTranscriptEventsFromDatabase(database, params.parentEntry.sessionId),
  );
  if (!source) {
    return { status: "failed" };
  }
  const sessionId = params.targetSessionId ?? randomUUID();
  const targetScope = {
    ...resolved,
    sessionId,
    sessionKey: normalizeSqliteSessionKey(params.targetSessionKey),
  };
  const parentSessionFile = formatSqliteSessionMarkerForScope({
    ...resolved,
    sessionId: params.parentEntry.sessionId,
    sessionKey: normalizeSqliteSessionKey(params.parentSessionKey),
  });
  const sessionFile = formatSqliteSessionMarkerForScope(targetScope);
  writeSqliteForkedChildTranscriptInTransaction(database, targetScope, {
    parentSessionFile,
    source,
  });
  return {
    status: "created",
    transcript: {
      sessionFile,
      sessionId,
    },
  };
}

function branchSqliteCompactionCheckpointSessionInTransaction(
  database: OpenClawAgentDatabase,
  params: {
    checkpointId: string;
    parentSessionKey: string;
    resolved: ResolvedSqliteScope;
    sourceKey: string;
    targetKey: string;
  },
): SqliteCompactionCheckpointSessionMutationResult {
  const currentEntry = readSessionEntryRow(database, params.sourceKey)?.entry;
  if (!currentEntry?.sessionId) {
    return { status: "missing-session" };
  }
  const checkpoint = readSessionCompactionCheckpoint(currentEntry, params.checkpointId);
  if (!checkpoint) {
    return { status: "missing-checkpoint" };
  }
  const forked = forkSqliteCheckpointTranscriptInTransaction(database, params.resolved, {
    checkpoint,
    targetSessionKey: params.targetKey,
  });
  if (forked.status !== "created") {
    return forked;
  }

  const label = currentEntry.label?.trim()
    ? `${currentEntry.label.trim()} (checkpoint)`
    : "Checkpoint branch";
  const nextEntry = cloneSqliteCheckpointSessionEntry({
    currentEntry,
    label,
    nextSessionFile: forked.sessionFile,
    nextSessionId: forked.sessionId,
    parentSessionKey: params.parentSessionKey,
    totalTokens: forked.totalTokens,
  });
  writeSessionEntry(database, params.targetKey, nextEntry);
  return {
    status: "created",
    key: params.targetKey,
    checkpoint,
    entry: nextEntry,
  };
}

function restoreSqliteCompactionCheckpointSessionInTransaction(
  database: OpenClawAgentDatabase,
  params: {
    checkpointId: string;
    resolved: ResolvedSqliteScope;
    sourceKey: string;
    targetKey: string;
  },
): SqliteCompactionCheckpointSessionMutationResult {
  const currentEntry = readSessionEntryRow(database, params.sourceKey)?.entry;
  if (!currentEntry?.sessionId) {
    return { status: "missing-session" };
  }
  const checkpoint = readSessionCompactionCheckpoint(currentEntry, params.checkpointId);
  if (!checkpoint) {
    return { status: "missing-checkpoint" };
  }
  const restored = forkSqliteCheckpointTranscriptInTransaction(database, params.resolved, {
    checkpoint,
    targetSessionKey: params.targetKey,
  });
  if (restored.status !== "created") {
    return restored;
  }

  const nextEntry = cloneSqliteCheckpointSessionEntry({
    currentEntry,
    nextSessionFile: restored.sessionFile,
    nextSessionId: restored.sessionId,
    preserveCompactionCheckpoints: true,
    totalTokens: restored.totalTokens,
  });
  writeSessionEntry(database, params.targetKey, nextEntry);
  return {
    status: "created",
    key: params.targetKey,
    checkpoint,
    entry: nextEntry,
  };
}

function forkSqliteCheckpointTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  params: {
    checkpoint: SessionCompactionCheckpoint;
    targetSessionKey: string;
  },
):
  | {
      status: "created";
      sessionId: string;
      sessionFile: string;
      totalTokens?: number;
    }
  | { status: "missing-boundary" }
  | { status: "failed" } {
  const sources = resolveSqliteCheckpointTranscriptForkSources(params.checkpoint);
  if (sources.length === 0) {
    return { status: "missing-boundary" };
  }
  let lastFailure: { status: "missing-boundary" } | { status: "failed" } = {
    status: "missing-boundary",
  };
  let selected:
    | {
        source: SqliteCheckpointTranscriptForkSource;
        rows: TranscriptEvent[];
      }
    | undefined;
  for (const source of sources) {
    const rows = readSqliteTranscriptRowsForFork(database, source);
    if (rows.status === "created") {
      selected = { source, rows: rows.events };
      break;
    }
    lastFailure = rows;
  }
  if (!selected) {
    return lastFailure;
  }

  const sessionId = randomUUID();
  const targetScope = {
    ...resolved,
    sessionId,
    sessionKey: params.targetSessionKey,
  };
  const sessionFile = formatSqliteSessionMarkerForScope(targetScope);
  appendTranscriptEventsInTransaction(database, targetScope, [
    createSessionTranscriptHeader({
      cwd: readTranscriptHeaderCwd(selected.rows),
      sessionId,
    }),
    ...selected.rows.filter((event) => !isSessionTranscriptHeader(event)),
  ]);
  return {
    status: "created",
    sessionId,
    sessionFile,
    ...(typeof selected.source.totalTokens === "number"
      ? { totalTokens: selected.source.totalTokens }
      : {}),
  };
}

function resolveSqliteCheckpointTranscriptForkSources(
  checkpoint: SessionCompactionCheckpoint,
): SqliteCheckpointTranscriptForkSource[] {
  const sources: SqliteCheckpointTranscriptForkSource[] = [];
  if (checkpoint.preCompaction.sessionId) {
    const preLeafId = checkpoint.preCompaction.entryId ?? checkpoint.preCompaction.leafId;
    sources.push({
      sessionId: checkpoint.preCompaction.sessionId,
      ...(preLeafId ? { leafId: preLeafId } : {}),
      ...(typeof checkpoint.tokensBefore === "number"
        ? { totalTokens: checkpoint.tokensBefore }
        : {}),
    });
  }

  const postLeafId = checkpoint.postCompaction.entryId ?? checkpoint.postCompaction.leafId;
  if (checkpoint.postCompaction.sessionId && postLeafId) {
    sources.push({
      sessionId: checkpoint.postCompaction.sessionId,
      leafId: postLeafId,
      ...(typeof checkpoint.tokensAfter === "number"
        ? { totalTokens: checkpoint.tokensAfter }
        : {}),
    });
  }

  return sources;
}

function readSqliteTranscriptRowsForFork(
  database: OpenClawAgentDatabase,
  source: { sessionId: string; leafId?: string },
): { status: "created"; events: TranscriptEvent[] } | { status: "missing-boundary" | "failed" } {
  const boundarySeq = source.leafId
    ? readTranscriptIdentityByEventId(database, source.sessionId, source.leafId)?.seq
    : undefined;
  if (source.leafId && boundarySeq === undefined) {
    return { status: "missing-boundary" };
  }

  const db = getSessionKysely(database.db);
  const query = db
    .selectFrom("transcript_events")
    .select(["event_json", "seq"])
    .where("session_id", "=", source.sessionId)
    .orderBy("seq", "asc");
  const rows = executeSqliteQuerySync(
    database.db,
    boundarySeq === undefined ? query : query.where("seq", "<=", boundarySeq),
  ).rows;
  if (rows.length === 0) {
    return { status: "failed" };
  }
  try {
    return {
      status: "created",
      events: rows.map((row) => JSON.parse(row.event_json) as TranscriptEvent),
    };
  } catch {
    return { status: "failed" };
  }
}

function readSessionCompactionCheckpoint(
  entry: Pick<SessionEntry, "compactionCheckpoints">,
  checkpointId: string,
): SessionCompactionCheckpoint | undefined {
  const normalizedCheckpointId = checkpointId.trim();
  if (!normalizedCheckpointId || !Array.isArray(entry.compactionCheckpoints)) {
    return undefined;
  }
  return entry.compactionCheckpoints.find(
    (checkpoint) => checkpoint.checkpointId === normalizedCheckpointId,
  );
}

function cloneSqliteCheckpointSessionEntry(params: {
  currentEntry: SessionEntry;
  nextSessionId: string;
  nextSessionFile: string;
  label?: string;
  parentSessionKey?: string;
  totalTokens?: number;
  preserveCompactionCheckpoints?: boolean;
}): SessionEntry {
  const hasTotalTokens =
    typeof params.totalTokens === "number" && Number.isFinite(params.totalTokens);
  return {
    ...params.currentEntry,
    sessionId: params.nextSessionId,
    sessionFile: params.nextSessionFile,
    updatedAt: Date.now(),
    systemSent: false,
    abortedLastRun: false,
    startedAt: undefined,
    endedAt: undefined,
    runtimeMs: undefined,
    status: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    estimatedCostUsd: undefined,
    totalTokens: hasTotalTokens ? params.totalTokens : undefined,
    totalTokensFresh: hasTotalTokens ? true : undefined,
    label: params.label ?? params.currentEntry.label,
    parentSessionKey: params.parentSessionKey ?? params.currentEntry.parentSessionKey,
    compactionCheckpoints: params.preserveCompactionCheckpoints
      ? params.currentEntry.compactionCheckpoints
      : undefined,
  };
}

function readTranscriptHeaderCwd(events: readonly TranscriptEvent[]): string | undefined {
  const header = events.find(isSessionTranscriptHeader) as { cwd?: unknown } | undefined;
  return typeof header?.cwd === "string" && header.cwd.trim() ? header.cwd : undefined;
}

function isSessionTranscriptHeader(event: TranscriptEvent): boolean {
  return Boolean(
    event &&
    typeof event === "object" &&
    !Array.isArray(event) &&
    (event as { type?: unknown }).type === "session",
  );
}

/** Records inbound session metadata without refreshing activity timestamps. */
export async function recordSqliteInboundSessionMeta(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const createIfMissing = params.createIfMissing ?? true;
  return await patchSqliteSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (_entry, context) =>
      deriveSessionMetaPatch({
        ctx: params.ctx,
        sessionKey: params.sessionKey,
        existing: context.existingEntry,
        groupResolution: params.groupResolution,
      }),
    {
      // Inbound metadata must not refresh activity timestamps; idle reset
      // evaluation relies on updatedAt from actual session turns.
      preserveActivity: true,
      ...(createIfMissing ? { fallbackEntry: mergeSessionEntry(undefined, {}) } : {}),
    },
  );
}

/** Updates last-route/delivery metadata without refreshing activity timestamps. */
export async function updateSqliteSessionLastRoute(params: {
  storePath: string;
  sessionKey: string;
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  route?: SessionEntry["route"];
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const createIfMissing = params.createIfMissing ?? true;
  return await patchSqliteSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (_entry, context) =>
      deriveLastRoutePatch({
        channel: params.channel,
        to: params.to,
        accountId: params.accountId,
        threadId: params.threadId,
        route: params.route,
        deliveryContext: params.deliveryContext,
        ctx: params.ctx,
        groupResolution: params.groupResolution,
        existing: context.existingEntry,
        sessionKey: params.sessionKey,
      }),
    {
      // Route updates must not refresh activity timestamps (#49515).
      preserveActivity: true,
      ...(createIfMissing ? { fallbackEntry: mergeSessionEntry(undefined, {}) } : {}),
    },
  );
}

/** Writes the forked child's transcript rows (copied branch or header-only). */
function writeSqliteForkedChildTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  targetScope: ResolvedTranscriptScope,
  params: {
    parentSessionFile: string;
    source: SqliteParentForkSourceTranscript;
  },
): void {
  appendTranscriptEventsInTransaction(
    database,
    targetScope,
    buildSqliteForkedChildTranscriptEvents({
      parentSessionFile: params.parentSessionFile,
      source: params.source,
      targetSessionId: targetScope.sessionId,
    }),
  );
}
