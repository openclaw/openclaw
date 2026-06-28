import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveTimestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { Selectable } from "kysely";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import { deriveSessionTotalTokens, normalizeUsage } from "../../agents/usage.js";
import { resolveStoredSessionOwnerAgentId } from "../../gateway/session-store-key.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { redactSecrets } from "../../logging/redact.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { extractAssistantVisibleText } from "../../shared/chat-message-content.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../../shared/store-writer-queue.js";
import { isTranscriptOnlyOpenClawAssistantModel } from "../../shared/transcript-only-openclaw-assistant.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { formatSessionArchiveTimestamp } from "./artifacts.js";
import type {
  ExactSessionEntry,
  ForkSessionEntryFromParentTargetParams,
  ForkSessionEntryFromParentTargetResult,
  ForkSessionFromParentTranscriptParams,
  ForkSessionFromParentTranscriptResult,
  LatestTranscriptAssistantMessage,
  LatestTranscriptMessage,
  LatestTranscriptAssistantText,
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
  SessionEntrySummary,
  SessionEntryTargetPatchScope,
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
  SessionEntryUpdateOptions,
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
} from "./session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { normalizeStoreSessionKey, resolveSessionStoreEntry } from "./store-entry.js";
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
import {
  isSessionTranscriptLeafControl,
  mergeSessionTranscriptVisiblePathWithOpaqueAppendPath,
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";
import { resolveVisibleTranscriptAppendParentId } from "./transcript-visible-events.js";
import type { SessionCompactionCheckpoint, SessionEntry } from "./types.js";
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

type SessionSqliteDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "conversations"
  | "session_conversations"
  | "session_entries"
  | "session_routes"
  | "sessions"
  | "transcript_event_identities"
  | "transcript_events"
>;
type SessionEntryRow = Selectable<OpenClawAgentKyselyDatabase["session_entries"]>;
type ResolvedSessionEntryRow = {
  entry: SessionEntry;
  legacyKeys: string[];
  row: SessionEntryRow;
};
type SqliteSessionEntryPatchOptions = SessionEntryPatchOptions & {
  skipMaintenance?: boolean;
};

type ResolvedSqliteScope = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
  sessionKey: string;
};

type ResolvedSqliteReadScope = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
  sessionKey?: string;
};

type ResolvedTranscriptScope = ResolvedSqliteScope & {
  sessionId: string;
};

type ResolvedTranscriptReadScope = ResolvedSqliteReadScope & {
  sessionId: string;
};

type SqliteCheckpointTranscriptForkSource = {
  sessionId: string;
  leafId?: string;
  totalTokens?: number;
};

type SqliteParentForkSourceTranscript = {
  appendMode?: "side";
  appendParentId: string | null;
  branchEntries: TranscriptEvent[];
  cwd?: string;
  labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }>;
  leafId: string | null;
  preserveLeafControl: boolean;
};

/** Result from SQLite compaction checkpoint branch or restore operations. */
export type SqliteCompactionCheckpointSessionMutationResult =
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
export type SqliteBranchCheckpointSessionParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  sourceKey: string;
  sourceStoreKey?: string;
  nextKey: string;
  checkpointId: string;
};

/** Parameters for restoring a SQLite session from a compaction checkpoint. */
export type SqliteRestoreCheckpointSessionParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  sessionKey: string;
  sessionStoreKey?: string;
  checkpointId: string;
};

/** Internal doctor/migration import target for one legacy session row. */
export type SqliteSessionImportRowsParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
  sessionKey: string;
  entry: SessionEntry;
  readTranscriptEvents?: (append: (event: TranscriptEvent) => void) => void;
};

/** Summary of rows written by an internal doctor/migration import. */
export type SqliteSessionImportRowsResult = {
  sessionId: string;
  sessionKey: string;
  transcriptEvents: number;
};

export type SqliteExpectedSessionTranscriptTurnResult = {
  appendedMessages: TranscriptMessageAppendResult<unknown>[];
  rejectedReason?: "session-rebound";
  sessionEntry: SessionEntry | undefined;
  sessionFile: string;
};

export type SqliteTranscriptWriteLockContext = {
  appendMessage: <TMessage>(
    options: TranscriptMessageAppendOptions<TMessage>,
  ) => Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
  readEvents: () => Promise<TranscriptEvent[]>;
  replaceEvents: (events: readonly TranscriptEvent[]) => Promise<void>;
};

const SQLITE_SESSION_WRITER_QUEUES = new Map<string, StoreWriterQueue>();

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
      .selectFrom("session_entries")
      .select("session_key")
      .where("session_id", "=", resolved.sessionId)
      .orderBy("updated_at", "desc")
      .orderBy("session_key", "asc")
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
      const entry = parseSessionEntryRow(row);
      return entry ? { sessionKey: row.session_key, entry } : undefined;
    })
    .filter((entry): entry is SessionEntrySummary => entry !== undefined);
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
    const existing = (
      options.replaceEntry
        ? readExactSessionEntryRow(database, resolved.sessionKey)
        : readSessionEntryRow(database, resolved.sessionKey)
    )?.entry;
    const base = existing ?? options.fallbackEntry;
    if (!base) {
      return null;
    }
    const patch = await update(cloneSessionEntry(base), {
      existingEntry: existing ? cloneSessionEntry(existing) : undefined,
    });
    if (!patch) {
      return cloneSessionEntry(base);
    }

    let result: SessionEntry | null = null;
    runOpenClawAgentWriteTransaction((writeDatabase) => {
      const fresh = options.replaceEntry
        ? readExactSessionEntryRow(writeDatabase, resolved.sessionKey)
        : readSessionEntryRow(writeDatabase, resolved.sessionKey);
      const writeBase = fresh?.entry ?? options.fallbackEntry;
      if (!writeBase) {
        result = null;
        return;
      }
      const next = options.replaceEntry
        ? cloneSessionEntry(patch as SessionEntry)
        : options.preserveActivity
          ? mergeSessionEntryPreserveActivity(writeBase, patch)
          : mergeSessionEntry(writeBase, patch);
      writeSessionEntry(writeDatabase, resolved.sessionKey, next);
      deleteLegacySessionEntryRows(writeDatabase, fresh?.legacyKeys ?? [], resolved.sessionKey);
      applySqliteSessionEntryMaintenance(writeDatabase, {
        activeSessionKey: resolved.sessionKey,
        archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
        maintenanceConfig: options.maintenanceConfig,
        skipMaintenance: options.skipMaintenance,
      });
      result = cloneSessionEntry(next);
    }, toDatabaseOptions(resolved));
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
  const resolved = resolveSqliteStoreScope(scope.storePath);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const existing = resolveSqliteLifecyclePrimaryEntry(database, scope.target)?.entry;
    const base = existing ?? options.fallbackEntry;
    if (!base) {
      return null;
    }
    const patch = await update(cloneSessionEntry(base), {
      existingEntry: existing ? cloneSessionEntry(existing) : undefined,
    });
    if (!patch) {
      return cloneSessionEntry(base);
    }

    let result: SessionEntry | null = null;
    runOpenClawAgentWriteTransaction((writeDatabase) => {
      const fresh = resolveSqliteLifecyclePrimaryEntry(writeDatabase, scope.target);
      const writeBase = fresh?.entry ?? options.fallbackEntry;
      if (!writeBase) {
        result = null;
        return;
      }
      const next = options.replaceEntry
        ? cloneSessionEntry(patch as SessionEntry)
        : options.preserveActivity
          ? mergeSessionEntryPreserveActivity(writeBase, patch)
          : mergeSessionEntry(writeBase, patch);
      deleteSqliteLifecycleTargetRows(writeDatabase, scope.target);
      writeSessionEntry(writeDatabase, scope.target.canonicalKey, next);
      applySqliteSessionEntryMaintenance(writeDatabase, {
        activeSessionKey: scope.target.canonicalKey,
        archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
        maintenanceConfig: options.maintenanceConfig,
        skipMaintenance: options.skipMaintenance,
      });
      result = cloneSessionEntry(next);
    }, toDatabaseOptions(resolved));
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
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let result: ForkSessionFromParentTranscriptResult = { status: "failed" };
    runOpenClawAgentWriteTransaction((database) => {
      result = forkSqliteParentTranscriptInTransaction(database, resolved, {
        parentEntry: params.parentEntry,
        parentSessionKey: params.parentSessionKey,
        targetSessionKey: params.sessionKey,
      });
    }, toDatabaseOptions(resolved));
    return result;
  });
}

/** Forks parent context into a child session entry using SQLite rows only. */
export async function forkSqliteSessionEntryFromParentTarget(
  params: ForkSessionEntryFromParentTargetParams,
): Promise<ForkSessionEntryFromParentTargetResult> {
  const resolved = resolveSqliteStoreScope(params.storePath);
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
      deleteSqliteLifecycleTargetRows(writeDatabase, sessionTarget);
      writeSessionEntry(writeDatabase, sessionTarget.canonicalKey, next);
      applySqliteSessionEntryMaintenance(writeDatabase, {
        activeSessionKey: sessionTarget.canonicalKey,
        archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
        skipMaintenance: true,
      });
      result = {
        status: "forked",
        decision,
        fork: fork.transcript,
        parentEntry: cloneSessionEntry(freshParent),
        sessionEntry: cloneSessionEntry(next),
      };
    }, toDatabaseOptions(resolved));
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
  const next = mergeSessionEntry(params.entry, params.patch);
  runOpenClawAgentWriteTransaction((database) => {
    deleteSqliteLifecycleTargetRows(database, params.sessionTarget);
    writeSessionEntry(database, params.sessionTarget.canonicalKey, next);
    applySqliteSessionEntryMaintenance(database, {
      activeSessionKey: params.sessionTarget.canonicalKey,
      archiveDirectory: resolveSqliteTranscriptArchiveDirectory(params.resolved),
      skipMaintenance: true,
    });
  }, toDatabaseOptions(params.resolved));
  return cloneSessionEntry(next);
}

/** Updates an existing entry in the additive SQLite session store. */
export async function updateSqliteSessionEntry(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SessionEntryUpdateOptions = {},
): Promise<SessionEntry | null> {
  const resolved = resolveSqliteScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const existing = readSessionEntryRow(database, resolved.sessionKey)?.entry;
    if (!existing) {
      return null;
    }
    const patch = await update(cloneSessionEntry(existing));
    if (!patch) {
      return cloneSessionEntry(existing);
    }

    let result: SessionEntry | null = null;
    runOpenClawAgentWriteTransaction((writeDatabase) => {
      const fresh = readSessionEntryRow(writeDatabase, resolved.sessionKey);
      if (!fresh) {
        result = null;
        return;
      }
      const next = mergeSessionEntry(fresh.entry, patch);
      writeSessionEntry(writeDatabase, resolved.sessionKey, next);
      deleteLegacySessionEntryRows(writeDatabase, fresh.legacyKeys, resolved.sessionKey);
      applySqliteSessionEntryMaintenance(writeDatabase, {
        activeSessionKey: resolved.sessionKey,
        archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
        skipMaintenance: options.skipMaintenance,
      });
      result = cloneSessionEntry(next);
    }, toDatabaseOptions(resolved));
    return result;
  });
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
    let result: SessionLifecycleArtifactCleanupResult = {
      removedEntries: 0,
      archivedTranscriptArtifacts: 0,
    };
    runOpenClawAgentWriteTransaction((database) => {
      result = cleanupSqliteSessionLifecycleArtifactsInTransaction(database, {
        archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
        sessionKeySegmentPrefix,
        transcriptContentMarker,
        orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
        nowMs: params.nowMs ?? Date.now(),
      });
    }, toDatabaseOptions(resolved));
    return result;
  });
}

/** Resets one persisted session entry using SQLite session rows. */
export async function resetSqliteSessionEntryLifecycle(
  params: ResetSessionEntryLifecycleParams,
): Promise<ResetSessionEntryLifecycleResult> {
  const resolved = resolveSqliteStoreScope(params.storePath);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const current = resolveSqliteLifecyclePrimaryEntry(database, params.target);
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
    runOpenClawAgentWriteTransaction((transactionDb) => {
      deleteSqliteLifecycleTargetRows(transactionDb, params.target);
      writeSessionEntry(transactionDb, params.target.canonicalKey, nextEntry);
    }, toDatabaseOptions(resolved));
    await params.afterEntryMutation?.(mutation);
    runOpenClawAgentWriteTransaction((transactionDb) => {
      archivedTranscripts = current?.entry.sessionId
        ? archiveSqliteSessionStateAfterEntryRemoval({
            archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
            database: transactionDb,
            entry: current.entry,
            reason: "reset",
          })
        : [];
    }, toDatabaseOptions(resolved));
    emitArchivedSqliteTranscriptUpdates(archivedTranscripts);
    return {
      ...mutation,
      archivedTranscripts,
    };
  });
}

/** Deletes one persisted session entry using SQLite session rows. */
export async function deleteSqliteSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams,
): Promise<DeleteSessionEntryLifecycleResult> {
  const resolved = resolveSqliteStoreScope(params.storePath);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let result: DeleteSessionEntryLifecycleResult = {
      archivedTranscripts: [],
      deleted: false,
    };
    runOpenClawAgentWriteTransaction((database) => {
      const current = resolveSqliteLifecyclePrimaryEntry(database, params.target);
      if (!current) {
        return;
      }
      deleteSqliteLifecycleTargetRows(database, params.target);
      const archivedTranscripts = params.archiveTranscript
        ? archiveSqliteSessionStateAfterEntryRemoval({
            archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
            database,
            entry: current.entry,
            reason: "deleted",
          })
        : [];
      result = {
        archivedTranscripts,
        deleted: true,
        deletedEntry: cloneSessionEntry(current.entry),
        ...(current.entry.sessionFile ? { deletedSessionFile: current.entry.sessionFile } : {}),
        ...(current.entry.sessionId ? { deletedSessionId: current.entry.sessionId } : {}),
      };
    }, toDatabaseOptions(resolved));
    emitArchivedSqliteTranscriptUpdates(result.archivedTranscripts);
    return result;
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
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const store = readSqliteSessionEntryStore(database);
    const removedSessionKeys: string[] = [];
    const removedEntriesToArchive: SessionEntry[] = [];
    const upsertedEntries: Array<{ sessionKey: string; entry: SessionEntry }> = [];
    const archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
    let artifactCleanupError: unknown;
    let afterCount = 0;
    const captureArtifactCleanupError = (error: unknown): void => {
      if (params.captureArtifactCleanupError === true) {
        artifactCleanupError ??= error;
        return;
      }
      throw error;
    };
    for (const removal of params.removals ?? []) {
      const sessionKey = removal.sessionKey.trim();
      if (!sessionKey) {
        continue;
      }
      const entry = store[sessionKey];
      if (!shouldRemoveSqliteSessionEntry(entry, removal)) {
        continue;
      }
      if (removal.archiveRemovedTranscript === true) {
        removedEntriesToArchive.push(entry);
      }
      delete store[sessionKey];
      removedSessionKeys.push(sessionKey);
    }
    for (const upsert of params.upserts ?? []) {
      const sessionKey = upsert.sessionKey.trim();
      if (!sessionKey) {
        continue;
      }
      const entry =
        upsert.buildEntry === undefined
          ? upsert.entry
          : await upsert.buildEntry({
              currentEntry: store[sessionKey] ? cloneSessionEntry(store[sessionKey]) : undefined,
              sessionKey,
              store,
            });
      if (!entry) {
        continue;
      }
      const cloned = cloneSessionEntry(entry);
      store[sessionKey] = cloned;
      upsertedEntries.push({ sessionKey, entry: cloned });
    }
    runOpenClawAgentWriteTransaction((transactionDb) => {
      for (const sessionKey of removedSessionKeys) {
        deleteSqliteSessionEntryRows(transactionDb, sessionKey);
      }
      for (const { sessionKey, entry } of upsertedEntries) {
        writeSessionEntry(transactionDb, sessionKey, entry);
      }
      applySqliteSessionEntryMaintenance(database, {
        activeSessionKey: params.activeSessionKey ?? "",
        archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
        forceMaintenance: params.maintenanceOverride !== undefined,
        maintenanceConfig: params.maintenanceOverride
          ? { ...resolveMaintenanceConfig(), ...params.maintenanceOverride }
          : undefined,
        skipMaintenance: params.skipMaintenance,
      });
      const referencedSessionIds = readReferencedSqliteSessionIds(transactionDb);
      for (const entry of removedEntriesToArchive) {
        for (const sessionId of collectSqliteSessionStateIdsForEntry(entry)) {
          try {
            const archived = deleteSqliteSessionStateIfUnreferenced({
              archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
              database: transactionDb,
              referencedSessionIds,
              sessionId,
            });
            if (archived) {
              archivedTranscripts.push(archived);
            }
          } catch (error) {
            captureArtifactCleanupError(error);
          }
        }
      }
      afterCount = Object.keys(readSqliteSessionEntryStore(database)).length;
    }, toDatabaseOptions(resolved));
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
  const resolved = resolveSqliteStoreScope(params.storePath);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const removedSessionKeys: string[] = [];
    let afterCount = 0;
    runOpenClawAgentWriteTransaction((database) => {
      const store = readSqliteSessionEntryStore(database);
      for (const sessionKey of Object.keys(store)) {
        const ownerAgentId = resolveStoredSessionOwnerAgentId({
          cfg: params.cfg,
          agentId: params.storeAgentId,
          sessionKey,
        });
        if (ownerAgentId !== params.agentId) {
          continue;
        }
        deleteSqliteSessionEntryRows(database, sessionKey);
        delete store[sessionKey];
        removedSessionKeys.push(sessionKey);
      }
      applySqliteSessionEntryMaintenance(database, {
        activeSessionKey: "",
        archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
      });
      afterCount = Object.keys(readSqliteSessionEntryStore(database)).length;
    }, toDatabaseOptions(resolved));
    return {
      removedEntries: removedSessionKeys.length,
      removedSessionKeys,
      archivedTranscriptDirectories: [],
      unreferencedArtifacts: null,
      maintenanceReport: null,
      afterCount,
    };
  });
}

/** Loads raw transcript events from the additive SQLite transcript store. */
export async function loadSqliteTranscriptEvents(
  scope: SessionTranscriptReadScope,
): Promise<TranscriptEvent[]> {
  return loadSqliteTranscriptEventsSync(scope);
}

/** Loads raw transcript events synchronously from the additive SQLite transcript store. */
export function loadSqliteTranscriptEventsSync(
  scope: SessionTranscriptReadScope,
): TranscriptEvent[] {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return loadSqliteTranscriptEventsFromDatabase(database, resolved.sessionId);
}

function loadSqliteTranscriptEventsFromDatabase(
  database: OpenClawAgentDatabase,
  sessionId: string,
): TranscriptEvent[] {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  return rows.map((row) => JSON.parse(row.event_json) as TranscriptEvent);
}

function readTranscriptEventJsonSetInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
): Set<string> {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("transcript_events").select("event_json").where("session_id", "=", sessionId),
  ).rows;
  return new Set(rows.map((row) => row.event_json));
}

/** Reads the latest visible assistant text from SQLite transcript rows in reverse order. */
export function loadLatestSqliteAssistantText(
  scope: SessionTranscriptReadScope,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptAssistantText | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const statement = database.db.prepare(`
    SELECT te.event_json AS event_json
    FROM transcript_events te
    INNER JOIN transcript_event_identities ti
      ON ti.session_id = te.session_id
      AND ti.seq = te.seq
    WHERE te.session_id = ?
      AND ti.event_type = 'message'
    ORDER BY te.seq DESC
  `);
  for (const row of statement.iterate(resolved.sessionId) as Iterable<{ event_json: string }>) {
    const latest = parseLatestAssistantMessageEvent(row.event_json, options);
    if (!latest) {
      continue;
    }
    const text = parseLatestAssistantText(latest);
    if (text) {
      return text;
    }
  }
  return undefined;
}

/** Reads the latest assistant message payload from SQLite transcript rows in reverse order. */
export function loadLatestSqliteAssistantMessage(
  scope: SessionTranscriptReadScope,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptAssistantMessage | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const statement = database.db.prepare(`
    SELECT te.event_json AS event_json
    FROM transcript_events te
    INNER JOIN transcript_event_identities ti
      ON ti.session_id = te.session_id
      AND ti.seq = te.seq
    WHERE te.session_id = ?
      AND ti.event_type = 'message'
    ORDER BY te.seq DESC
  `);
  for (const row of statement.iterate(resolved.sessionId) as Iterable<{ event_json: string }>) {
    const latest = parseLatestAssistantMessageEvent(row.event_json, options);
    if (latest) {
      return latest;
    }
  }
  return undefined;
}

/** Reads the newest transcript message payload from SQLite transcript rows. */
export function loadLatestSqliteMessage(
  scope: SessionTranscriptReadScope,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptMessage | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const statement = database.db.prepare(`
    SELECT te.event_json AS event_json
    FROM transcript_events te
    INNER JOIN transcript_event_identities ti
      ON ti.session_id = te.session_id
      AND ti.seq = te.seq
    WHERE te.session_id = ?
      AND ti.event_type = 'message'
    ORDER BY te.seq DESC
    LIMIT 1
  `);
  const row = statement.get(resolved.sessionId) as { event_json: string } | undefined;
  return row ? parseLatestMessageEvent(row.event_json, options) : undefined;
}

function parseLatestAssistantText(
  latest: LatestTranscriptAssistantMessage,
): LatestTranscriptAssistantText | undefined {
  const message = latest.message as {
    timestamp?: unknown;
  };
  const text = extractAssistantVisibleText(latest.message)?.trim();
  if (!text) {
    return undefined;
  }
  return {
    ...(latest.id ? { id: latest.id } : {}),
    text,
    ...(typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? { timestamp: message.timestamp }
      : {}),
  };
}

function parseLatestAssistantMessageEvent(
  raw: string,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptAssistantMessage | undefined {
  let parsed: {
    id?: unknown;
    message?: {
      model?: unknown;
      provider?: unknown;
      role?: unknown;
      timestamp?: unknown;
    };
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return undefined;
  }
  const message = parsed.message;
  if (!message || message.role !== "assistant") {
    return undefined;
  }
  if (
    !options.includeTranscriptOnlyOpenClawAssistant &&
    isTranscriptOnlyOpenClawAssistantModel(message.provider, message.model)
  ) {
    return undefined;
  }
  return {
    ...(typeof parsed.id === "string" && parsed.id.trim() ? { id: parsed.id } : {}),
    message,
  };
}

function parseLatestMessageEvent(
  raw: string,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptMessage | undefined {
  let parsed: {
    id?: unknown;
    message?: {
      model?: unknown;
      provider?: unknown;
      role?: unknown;
    };
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return undefined;
  }
  const message = parsed.message;
  if (!message || typeof message.role !== "string") {
    return undefined;
  }
  if (
    message.role === "assistant" &&
    !options.includeTranscriptOnlyOpenClawAssistant &&
    isTranscriptOnlyOpenClawAssistantModel(message.provider, message.model)
  ) {
    return undefined;
  }
  return {
    ...(typeof parsed.id === "string" && parsed.id.trim() ? { id: parsed.id } : {}),
    message,
  };
}

/** Checks whether the additive SQLite transcript store has rows for a transcript. */
export function sqliteTranscriptExists(scope: SessionTranscriptReadScope): boolean {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", resolved.sessionId)
      .limit(1),
  );
  return row !== undefined;
}

/** Deletes rows for one transcript from the additive SQLite transcript store. */
export async function deleteSqliteTranscript(scope: SessionTranscriptReadScope): Promise<boolean> {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let deleted = false;
    runOpenClawAgentWriteTransaction((database) => {
      deleted = deleteSqliteTranscriptEventsInTransaction(database, resolved.sessionId);
    }, toDatabaseOptions(resolved));
    return deleted;
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
      writeSessionEntry(database, resolved.sessionKey, params.entry);
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
          if (appendTranscriptEventInTransaction(database, transcriptScope, event)) {
            existingEventJson.add(eventJson);
            transcriptEvents += 1;
          }
        });
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

/** Appends raw transcript events to the additive SQLite transcript store in one transaction. */
export async function appendSqliteTranscriptEvents(
  scope: SessionTranscriptAccessScope,
  events: TranscriptEvent[],
): Promise<void> {
  if (events.length === 0) {
    return;
  }
  const resolved = resolveSqliteTranscriptScope(scope);
  await runExclusiveSqliteSessionWrite(resolved, async () => {
    runOpenClawAgentWriteTransaction((database) => {
      for (const event of events) {
        appendTranscriptEventInTransaction(database, resolved, event);
      }
    }, toDatabaseOptions(resolved));
  });
}

/** Appends a guarded transcript turn and touches its session row in one queued write. */
export async function appendSqliteExpectedSessionTranscriptTurn(
  scope: SessionTranscriptWriteScope,
  options: {
    config?: import("../types.openclaw.js").OpenClawConfig;
    cwd?: string;
    expectedSessionId: string;
    messages: readonly SessionTranscriptTurnMessageAppend[];
    sessionFile: string;
    touchSessionEntry?: boolean;
  },
): Promise<SqliteExpectedSessionTranscriptTurnResult> {
  const resolved = resolveSqliteTranscriptScope({
    ...scope,
    sessionId: options.expectedSessionId,
  });
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    const initialResult: SqliteExpectedSessionTranscriptTurnResult = {
      appendedMessages: [],
      rejectedReason: "session-rebound",
      sessionEntry: undefined,
      sessionFile: options.sessionFile,
    };
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const freshBeforeAppend = readSessionEntryRow(database, resolved.sessionKey);
    if (!freshBeforeAppend || freshBeforeAppend.entry.sessionId !== options.expectedSessionId) {
      return {
        ...initialResult,
        sessionEntry: freshBeforeAppend?.entry,
      };
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

    let result = initialResult;
    runOpenClawAgentWriteTransaction((transactionDb) => {
      const fresh = readSessionEntryRow(transactionDb, resolved.sessionKey);
      if (!fresh || fresh.entry.sessionId !== options.expectedSessionId) {
        result = {
          appendedMessages: [],
          rejectedReason: "session-rebound",
          sessionEntry: fresh?.entry,
          sessionFile: options.sessionFile,
        };
        return;
      }

      const appendedMessages: TranscriptMessageAppendResult<unknown>[] = [];
      for (const append of messages) {
        const { shouldAppend: _shouldAppend, ...appendOptions } = append;
        const appended = appendSqliteTranscriptMessageInTransaction(database, resolved, {
          ...appendOptions,
          ...((append.cwd ?? options.cwd) ? { cwd: append.cwd ?? options.cwd } : {}),
          ...((append.config ?? options.config) ? { config: append.config ?? options.config } : {}),
        });
        if (appended) {
          appendedMessages.push(appended);
        }
      }

      const appendedCount = appendedMessages.filter((message) => message.appended).length;
      const touchUpdatedAt =
        options.touchSessionEntry === true && appendedCount > 0 ? Date.now() : undefined;
      const sessionPatch: Partial<SessionEntry> = {
        ...(fresh.entry.sessionFile === options.sessionFile
          ? {}
          : { sessionFile: options.sessionFile }),
        ...(touchUpdatedAt !== undefined
          ? { updatedAt: Math.max(fresh.entry.updatedAt ?? 0, touchUpdatedAt) }
          : {}),
      };
      const next =
        Object.keys(sessionPatch).length > 0
          ? mergeSessionEntry(fresh.entry, sessionPatch)
          : fresh.entry;
      if (next !== fresh.entry) {
        writeSessionEntry(database, resolved.sessionKey, next);
        deleteLegacySessionEntryRows(database, fresh.legacyKeys, resolved.sessionKey);
      }
      result = {
        appendedMessages,
        sessionEntry: cloneSessionEntry(next),
        sessionFile: options.sessionFile,
      };
    }, toDatabaseOptions(resolved));
    return result;
  });
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
    return await run({
      readEvents: async () => loadSqliteTranscriptEventsFromDatabase(database, resolved.sessionId),
      replaceEvents: async (events) => {
        runOpenClawAgentWriteTransaction((writeDatabase) => {
          replaceSqliteTranscriptEventsInTransaction(writeDatabase, resolved, events);
        }, toDatabaseOptions(resolved));
      },
      appendMessage: async (options) => {
        let result: TranscriptMessageAppendResult<unknown> | undefined;
        runOpenClawAgentWriteTransaction((writeDatabase) => {
          result = appendSqliteTranscriptMessageInTransaction(writeDatabase, resolved, options);
        }, toDatabaseOptions(resolved));
        return result as TranscriptMessageAppendResult<typeof options.message> | undefined;
      },
    });
  });
}

function appendSqliteTranscriptMessageInTransaction<TMessage>(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): TranscriptMessageAppendResult<TMessage> | undefined {
  const idempotencyKey = readMessageIdempotencyKey(options.message);
  if (idempotencyKey && options.idempotencyLookup === "scan") {
    const existing = readTranscriptMessageByIdempotencyKey(database, resolved, idempotencyKey);
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
    dedupeByMessageIdempotency: options.idempotencyLookup !== "caller-checked",
  });
  if (!appended && idempotencyKey && options.idempotencyLookup === "scan") {
    const existing = readTranscriptMessageByIdempotencyKey(database, resolved, idempotencyKey);
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
    runOpenClawAgentWriteTransaction((database) => {
      result = branchSqliteCompactionCheckpointSessionInTransaction(database, {
        checkpointId: params.checkpointId,
        parentSessionKey: normalizeSqliteSessionKey(params.sourceKey),
        resolved,
        sourceKey,
        targetKey,
      });
    }, toDatabaseOptions(resolved));
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
    runOpenClawAgentWriteTransaction((database) => {
      result = restoreSqliteCompactionCheckpointSessionInTransaction(database, {
        checkpointId: params.checkpointId,
        resolved,
        sourceKey: sessionKey,
        targetKey,
      });
    }, toDatabaseOptions(resolved));
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

function getSessionKysely(database: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<SessionSqliteDatabase>(database);
}

async function runExclusiveSqliteSessionWrite<T>(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  fn: () => Promise<T>,
): Promise<T> {
  const databaseOptions = toDatabaseOptions(scope);
  return await runQueuedStoreWrite({
    queues: SQLITE_SESSION_WRITER_QUEUES,
    storePath: resolveOpenClawAgentSqlitePath(databaseOptions),
    label: "runExclusiveSqliteSessionWrite",
    fn,
  });
}

function resolveSqliteScope(
  scope: Pick<SessionAccessScope, "agentId" | "env" | "sessionKey" | "storePath">,
): ResolvedSqliteScope {
  const scopedAgentId = resolveExplicitSqliteAgentId(scope);
  const storeTarget = scope.storePath
    ? resolveSqliteTargetFromSessionStorePath(scope.storePath, { agentId: scopedAgentId })
    : undefined;
  const agentId = resolveSqliteAgentId({
    scopedAgentId,
    sessionKey: scope.sessionKey,
    storeAgentId: storeTarget?.agentId,
    useDefaultAgentForUnownedStore: Boolean(
      storeTarget?.path && !storeTarget.agentId && !scopedAgentId,
    ),
  });
  if (!agentId) {
    throw new Error("Cannot resolve SQLite session scope without an agent id");
  }
  return {
    agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(storeTarget ? { path: storeTarget.path } : {}),
    sessionKey: normalizeSqliteSessionKey(scope.sessionKey),
  };
}

function resolveSqliteReadScope(
  scope: Pick<SessionTranscriptReadScope, "agentId" | "env" | "sessionKey" | "storePath">,
): ResolvedSqliteReadScope {
  const sessionKey = scope.sessionKey ? normalizeSqliteSessionKey(scope.sessionKey) : undefined;
  const scopedAgentId = resolveExplicitSqliteAgentId({ ...scope, sessionKey });
  const storeTarget = scope.storePath
    ? resolveSqliteTargetFromSessionStorePath(scope.storePath, { agentId: scopedAgentId })
    : undefined;
  const agentId = resolveSqliteAgentId({
    scopedAgentId,
    sessionKey,
    storeAgentId: storeTarget?.agentId,
    useDefaultAgentForUnownedStore: Boolean(
      storeTarget?.path && !storeTarget.agentId && !scopedAgentId,
    ),
  });
  if (!agentId) {
    throw new Error("Cannot resolve SQLite transcript read scope without an agent id");
  }
  return {
    agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(storeTarget ? { path: storeTarget.path } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  };
}

function resolveExplicitSqliteAgentId(params: {
  agentId?: string;
  sessionKey?: string;
}): string | undefined {
  return params.agentId
    ? normalizeAgentId(params.agentId)
    : parseAgentSessionKey(params.sessionKey)?.agentId;
}

function resolveSqliteStoreScope(storePath: string): ResolvedSqliteScope {
  return resolveSqliteScope({ sessionKey: "", storePath });
}

function resolveSqliteAgentId(params: {
  scopedAgentId?: string;
  sessionKey?: string;
  storeAgentId?: string;
  useDefaultAgentForUnownedStore?: boolean;
}): string | undefined {
  const scopedAgentId = params.scopedAgentId ? normalizeAgentId(params.scopedAgentId) : undefined;
  if (scopedAgentId && params.storeAgentId && scopedAgentId !== params.storeAgentId) {
    throw new Error(
      `SQLite session store path belongs to agent ${params.storeAgentId}; requested agent ${scopedAgentId}.`,
    );
  }
  const resolved =
    scopedAgentId ??
    params.storeAgentId ??
    (params.sessionKey !== undefined ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined);
  return resolved ?? (params.useDefaultAgentForUnownedStore ? DEFAULT_AGENT_ID : undefined);
}

function resolveSqliteTranscriptArchiveDirectory(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
): string {
  const databasePath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope));
  const databaseDir = path.dirname(databasePath);
  if (path.basename(databaseDir) !== "agent") {
    return databaseDir;
  }
  return path.join(path.dirname(databaseDir), "sessions");
}

function resolveSqliteTranscriptScope(
  scope: Pick<
    SessionTranscriptWriteScope,
    "agentId" | "env" | "sessionId" | "sessionKey" | "storePath"
  >,
): ResolvedTranscriptScope {
  if (!scope.sessionId) {
    throw new Error(
      `Cannot resolve SQLite transcript scope without a session id: ${scope.sessionKey}`,
    );
  }
  if (!scope.sessionKey) {
    throw new Error(
      `Cannot resolve SQLite transcript scope without a session key: ${scope.sessionId}`,
    );
  }
  return {
    ...resolveSqliteScope({
      ...scope,
      sessionKey: scope.sessionKey,
    }),
    sessionId: scope.sessionId,
  };
}

function resolveSqliteTranscriptReadScope(
  scope: Pick<
    SessionTranscriptReadScope,
    "agentId" | "env" | "sessionId" | "sessionKey" | "storePath"
  >,
): ResolvedTranscriptReadScope {
  return {
    ...resolveSqliteReadScope(scope),
    sessionId: scope.sessionId,
  };
}

function toDatabaseOptions(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
): OpenClawAgentDatabaseOptions {
  return {
    agentId: scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(scope.path ? { path: scope.path } : {}),
  };
}

function normalizeSqliteSessionKey(sessionKey: string): string {
  return normalizeStoreSessionKey(sessionKey);
}

function createFallbackSessionEntry(patch: Partial<SessionEntry>): SessionEntry {
  const now = Date.now();
  return {
    sessionId: patch.sessionId ?? randomUUID(),
    updatedAt: patch.updatedAt ?? now,
    ...patch,
  };
}

function cloneSessionEntry(entry: SessionEntry): SessionEntry {
  return structuredClone(entry);
}

function normalizeSqliteText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSqliteChatType(value: unknown): "direct" | "group" | "channel" | null {
  if (value === "direct" || value === "group" || value === "channel") {
    return value;
  }
  return null;
}

function normalizeSqliteNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function parseSessionEntryRow(row: Pick<SessionEntryRow, "entry_json">): SessionEntry | null {
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as SessionEntry)
      : null;
  } catch {
    return null;
  }
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
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").selectAll().orderBy("session_key", "asc"),
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
  if (removal.expectedUpdatedAt !== undefined && entry.updatedAt !== removal.expectedUpdatedAt) {
    return false;
  }
  return true;
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
): void {
  if (params.skipMaintenance) {
    return;
  }
  const maintenance = params.maintenanceConfig ?? resolveMaintenanceConfig();
  if (maintenance.mode === "warn") {
    return;
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
  const removedSessionIds = new Set<string>();
  const rememberRemovedEntry = (removed: { key: string; entry: SessionEntry }) => {
    removedKeys.add(removed.key);
    for (const sessionId of collectSqliteSessionStateIdsForEntry(removed.entry)) {
      removedSessionIds.add(sessionId);
    }
  };
  const preserveKeys = collectSessionMaintenancePreserveKeys(
    collectSqliteSessionMaintenanceBaseKeys(store, params.activeSessionKey),
  );
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
  pruneStaleEntries(store, maintenance.pruneAfterMs, {
    log: false,
    onPruned: rememberRemovedEntry,
    preserveKeys,
  });
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

  for (const sessionKey of removedKeys) {
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_routes").where("session_key", "=", sessionKey),
    );
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_entries").where("session_key", "=", sessionKey),
    );
  }
  const referencedSessionIds = readReferencedSqliteSessionIds(database);
  for (const sessionId of removedSessionIds) {
    deleteSqliteSessionStateIfUnreferenced({
      archiveDirectory: params.archiveDirectory,
      database,
      referencedSessionIds,
      sessionId,
    });
  }
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

function resolveSqliteTranscriptArchivePath(params: {
  archiveDirectory: string;
  reason: "deleted" | "reset";
  sessionId: string;
  nowMs?: number;
}): string {
  const archiveDirectory = path.resolve(params.archiveDirectory);
  const archivePath = path.resolve(
    archiveDirectory,
    `${params.sessionId}.jsonl.${params.reason}.${formatSessionArchiveTimestamp(params.nowMs)}`,
  );
  if (path.dirname(archivePath) !== archiveDirectory) {
    throw new Error(`Cannot archive SQLite transcript outside ${archiveDirectory}`);
  }
  return archivePath;
}

function findMatchingSqliteTranscriptArchive(params: {
  archiveDirectory: string;
  content: string;
  reason: "deleted" | "reset";
  sessionId: string;
}): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(params.archiveDirectory);
  } catch {
    return null;
  }
  const prefix = `${params.sessionId}.jsonl.${params.reason}.`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) {
      continue;
    }
    const archivePath = path.join(params.archiveDirectory, entry);
    try {
      const stat = fs.statSync(archivePath);
      if (!stat.isFile() || stat.size !== Buffer.byteLength(params.content, "utf8")) {
        continue;
      }
      if (fs.readFileSync(archivePath, "utf8") === params.content) {
        return archivePath;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function writeSqliteTranscriptArchive(params: {
  archiveDirectory: string;
  content: string;
  reason: "deleted" | "reset";
  sessionId: string;
}): string {
  fs.mkdirSync(params.archiveDirectory, { recursive: true });
  const existing = findMatchingSqliteTranscriptArchive(params);
  if (existing) {
    return existing;
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const archivePath = resolveSqliteTranscriptArchivePath({
      archiveDirectory: params.archiveDirectory,
      reason: params.reason,
      sessionId: params.sessionId,
      nowMs: Date.now() + attempt,
    });
    if (fs.existsSync(archivePath)) {
      continue;
    }
    const tempPath = `${archivePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, params.content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(tempPath, archivePath);
      return archivePath;
    } catch (err) {
      fs.rmSync(tempPath, { force: true });
      if ((err as { code?: unknown })?.code === "EEXIST") {
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Could not create SQLite transcript archive for ${params.sessionId}`);
}

function archiveSqliteTranscriptRows(params: {
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  reason: "deleted" | "reset";
  sessionId: string;
}): SessionLifecycleArchivedTranscript | null {
  const lines = readSqliteTranscriptArchiveLines(params.database, params.sessionId);
  if (lines.length === 0) {
    return null;
  }
  const archivedPath = writeSqliteTranscriptArchive({
    archiveDirectory: params.archiveDirectory,
    content: serializeJsonlLines(lines),
    reason: params.reason,
    sessionId: params.sessionId,
  });
  return {
    archivedPath,
    sourcePath: path.join(params.archiveDirectory, `${params.sessionId}.jsonl`),
  };
}

function archiveSqliteSessionStateAfterEntryRemoval(params: {
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  entry: SessionEntry;
  reason: "deleted" | "reset";
}): SessionLifecycleArchivedTranscript[] {
  const referencedSessionIds = readReferencedSqliteSessionIds(params.database);
  const archived: SessionLifecycleArchivedTranscript[] = [];
  for (const sessionId of collectSqliteSessionStateIdsForEntry(params.entry)) {
    const transcript = deleteSqliteSessionStateIfUnreferenced({
      archiveDirectory: params.archiveDirectory,
      database: params.database,
      reason: params.reason,
      referencedSessionIds,
      sessionId,
    });
    if (transcript) {
      archived.push(transcript);
    }
  }
  return archived;
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

function deleteSqliteSessionStateIfUnreferenced(params: {
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  reason?: "deleted" | "reset";
  referencedSessionIds: ReadonlySet<string>;
  sessionId: string;
}): SessionLifecycleArchivedTranscript | null {
  if (params.referencedSessionIds.has(params.sessionId)) {
    return null;
  }
  const hadTranscriptState =
    readSessionTranscriptUpdatedAt(params.database, params.sessionId) !== undefined;
  const archivedTranscript = archiveSqliteTranscriptRows({
    archiveDirectory: params.archiveDirectory,
    database: params.database,
    reason: params.reason ?? "deleted",
    sessionId: params.sessionId,
  });
  const db = getSessionKysely(params.database.db);
  executeSqliteQuerySync(
    params.database.db,
    db.deleteFrom("sessions").where("session_id", "=", params.sessionId),
  );
  return hadTranscriptState ? archivedTranscript : null;
}

function cleanupSqliteOrphanLifecycleTranscriptState(params: {
  archiveDirectory: string;
  database: OpenClawAgentDatabase;
  referencedSessionIds: ReadonlySet<string>;
  transcriptContentMarker: string;
  orphanTranscriptMinAgeMs: number;
  nowMs: number;
}): number {
  const db = getSessionKysely(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db.selectFrom("sessions").select("session_id").orderBy("session_id", "asc"),
  ).rows;

  let removed = 0;
  // Orphan transcript state is represented by a sessions row without a live
  // session entry. The marker keeps this scoped to the caller-owned lifecycle.
  for (const row of rows) {
    if (params.referencedSessionIds.has(row.session_id)) {
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
    const archived = archiveSqliteTranscriptRows({
      archiveDirectory: params.archiveDirectory,
      database: params.database,
      reason: "deleted",
      sessionId: row.session_id,
    });
    executeSqliteQuerySync(
      params.database.db,
      db.deleteFrom("sessions").where("session_id", "=", row.session_id),
    );
    if (archived) {
      removed += 1;
    }
  }
  return removed;
}

function cleanupSqliteSessionLifecycleArtifactsInTransaction(
  database: OpenClawAgentDatabase,
  params: {
    archiveDirectory: string;
    sessionKeySegmentPrefix: string;
    transcriptContentMarker: string;
    orphanTranscriptMinAgeMs: number;
    nowMs: number;
  },
): SessionLifecycleArtifactCleanupResult {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_entries")
      .select(["entry_json", "session_key", "session_id"])
      .orderBy("session_key", "asc"),
  ).rows;

  const removedSessionIds = new Set<string>();
  let removedEntries = 0;
  // Delete matching lifecycle entries first; session/transcript state is only
  // removed after we rebuild the post-delete reference set below.
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
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_routes").where("session_key", "=", row.session_key),
    );
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_entries").where("session_key", "=", row.session_key),
    );
    const entry = parseSessionEntryRow(row);
    for (const sessionId of entry
      ? collectSqliteSessionStateIdsForEntry(entry)
      : [row.session_id]) {
      removedSessionIds.add(sessionId);
    }
    removedEntries += 1;
  }

  const referencedSessionIds = readReferencedSqliteSessionIds(database);
  let archivedTranscriptArtifacts = 0;
  for (const sessionId of removedSessionIds) {
    const archived = deleteSqliteSessionStateIfUnreferenced({
      archiveDirectory: params.archiveDirectory,
      database,
      referencedSessionIds,
      sessionId,
    });
    if (archived) {
      archivedTranscriptArtifacts += 1;
    }
  }
  archivedTranscriptArtifacts += cleanupSqliteOrphanLifecycleTranscriptState({
    archiveDirectory: params.archiveDirectory,
    database,
    referencedSessionIds,
    transcriptContentMarker: params.transcriptContentMarker,
    orphanTranscriptMinAgeMs: params.orphanTranscriptMinAgeMs,
    nowMs: params.nowMs,
  });
  return { removedEntries, archivedTranscriptArtifacts };
}

function writeSessionEntry(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  entry: SessionEntry,
): void {
  const db = getSessionKysely(database.db);
  const normalizedEntry = normalizeSqliteSessionEntryTimestamp(entry);
  const updatedAt = normalizedEntry.updatedAt;
  const sessionRow = bindSqliteSessionRoot({ entry: normalizedEntry, sessionKey, updatedAt });
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("sessions")
      .values(sessionRow)
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          session_key: sessionKey,
          session_scope: sessionRow.session_scope,
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
      })
      .onConflict((conflict) =>
        conflict.column("session_key").doUpdateSet({
          session_id: normalizedEntry.sessionId,
          entry_json: JSON.stringify(normalizedEntry),
          updated_at: updatedAt,
        }),
      ),
  );
}

function normalizeSqliteSessionEntryTimestamp(entry: SessionEntry): SessionEntry {
  if (typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)) {
    return entry;
  }
  const updatedAt =
    typeof entry.sessionStartedAt === "number" && Number.isFinite(entry.sessionStartedAt)
      ? entry.sessionStartedAt
      : Date.now();
  return {
    ...entry,
    updatedAt,
  };
}

function ensureTranscriptSessionRoot(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  updatedAt: number,
): void {
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("sessions")
      .values({
        session_id: scope.sessionId,
        session_key: scope.sessionKey,
        session_scope: "conversation",
        created_at: updatedAt,
        updated_at: updatedAt,
      })
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          session_key: scope.sessionKey,
          updated_at: updatedAt,
        }),
      ),
  );
  writeTranscriptSessionRoute(database, {
    sessionId: scope.sessionId,
    sessionKey: scope.sessionKey,
    updatedAt,
  });
}

function bindSqliteSessionRoot(params: {
  entry: SessionEntry;
  sessionKey: string;
  updatedAt: number;
}) {
  const updatedAt = Number.isFinite(params.entry.updatedAt)
    ? params.entry.updatedAt
    : params.updatedAt;
  return {
    session_id: params.entry.sessionId,
    session_key: params.sessionKey,
    session_scope: resolveSqliteSessionScope(params.entry, params.sessionKey),
    created_at: resolveSqliteSessionCreatedAt(params.entry, updatedAt),
    updated_at: updatedAt,
    started_at: finiteSqliteNumber(params.entry.startedAt),
    ended_at: finiteSqliteNumber(params.entry.endedAt),
    status: normalizeSqliteText(params.entry.status),
    chat_type: normalizeSqliteChatType(params.entry.chatType),
    channel: resolveSqliteSessionChannel(params.entry),
    account_id: resolveSqliteSessionAccountId(params.entry),
    primary_conversation_id: null,
    model_provider: normalizeSqliteText(params.entry.modelProvider),
    model: normalizeSqliteText(params.entry.model),
    agent_harness_id: normalizeSqliteText(params.entry.agentHarnessId),
    parent_session_key: normalizeSqliteText(params.entry.parentSessionKey),
    spawned_by: normalizeSqliteText(params.entry.spawnedBy),
    display_name: resolveSqliteSessionDisplayName(params.entry),
  };
}

function writeSessionRoute(
  database: OpenClawAgentDatabase,
  params: { sessionId: string; sessionKey: string; updatedAt: number },
): void {
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_routes")
      .values({
        session_key: params.sessionKey,
        session_id: params.sessionId,
        updated_at: params.updatedAt,
      })
      .onConflict((conflict) =>
        conflict.column("session_key").doUpdateSet({
          session_id: params.sessionId,
          updated_at: params.updatedAt,
        }),
      ),
  );
}

function writeTranscriptSessionRoute(
  database: OpenClawAgentDatabase,
  params: { sessionId: string; sessionKey: string; updatedAt: number },
): void {
  const db = getSessionKysely(database.db);
  const existing = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_routes")
      .select("session_id")
      .where("session_key", "=", params.sessionKey),
  );
  // Transcript-only appends may arrive late from an old run. They can create
  // missing routes, but must not move a current session key back to a stale id.
  if (existing && existing.session_id !== params.sessionId) {
    return;
  }
  writeSessionRoute(database, params);
}

function resolveSqliteSessionScope(
  entry: Pick<SessionEntry, "chatType">,
  sessionKey: string,
): "conversation" | "shared-main" | "group" | "channel" {
  const chatType = normalizeSqliteChatType(entry.chatType);
  const normalizedKey = sessionKey.trim().toLowerCase();
  if (chatType === "direct" && (normalizedKey === "main" || normalizedKey.endsWith(":main"))) {
    return "shared-main";
  }
  if (chatType === "group" || chatType === "channel") {
    return chatType;
  }
  return "conversation";
}

function resolveSqliteSessionCreatedAt(entry: SessionEntry, updatedAt: number): number {
  for (const candidate of [entry.sessionStartedAt, entry.startedAt, entry.updatedAt, updatedAt]) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return updatedAt;
}

function finiteSqliteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resolveSqliteSessionChannel(entry: SessionEntry): string | null {
  return (
    normalizeSqliteText(entry.channel) ??
    normalizeSqliteText(entry.deliveryContext?.channel) ??
    normalizeSqliteText(entry.lastChannel) ??
    normalizeSqliteText(entry.origin?.provider)
  );
}

function resolveSqliteSessionAccountId(entry: SessionEntry): string | null {
  return (
    normalizeSqliteText(entry.deliveryContext?.accountId) ??
    normalizeSqliteText(entry.lastAccountId) ??
    normalizeSqliteText(entry.origin?.accountId)
  );
}

function resolveSqliteSessionDisplayName(entry: SessionEntry): string | null {
  return (
    normalizeSqliteText(entry.displayName) ??
    normalizeSqliteText(entry.label) ??
    normalizeSqliteText(entry.subject) ??
    normalizeSqliteText(entry.groupId)
  );
}

function readNextTranscriptSeq(database: OpenClawAgentDatabase, sessionId: string): number {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => eb.fn.max<number | bigint>("seq").as("max_seq"))
      .where("session_id", "=", sessionId),
  );
  const maxSeq =
    row?.max_seq === null || row?.max_seq === undefined ? -1 : normalizeSqliteNumber(row.max_seq);
  return maxSeq + 1;
}

function deleteSqliteTranscriptEventsInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
): boolean {
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("transcript_event_identities").where("session_id", "=", sessionId),
  );
  const result = executeSqliteQuerySync(
    database.db,
    db.deleteFrom("transcript_events").where("session_id", "=", sessionId),
  );
  return (result.numAffectedRows ?? 0n) > 0n;
}

const DEFAULT_PARENT_FORK_MAX_TOKENS = 100_000;

function formatParentForkTooLargeMessage(params: {
  parentTokens: number;
  maxTokens: number;
}): string {
  return (
    `Parent context is too large to fork (${params.parentTokens}/${params.maxTokens} tokens); ` +
    "starting with isolated context instead."
  );
}

function resolveSqliteParentForkDecision(
  parentEntry: SessionEntry,
  transcriptParentTokens?: number,
): SessionParentForkDecision {
  const maxTokens = DEFAULT_PARENT_FORK_MAX_TOKENS;
  const parentTokens = resolveFreshSessionTotalTokens(parentEntry) ?? transcriptParentTokens;
  if (typeof parentTokens === "number" && parentTokens > maxTokens) {
    return {
      status: "skip",
      reason: "parent-too-large",
      maxTokens,
      parentTokens,
      message: formatParentForkTooLargeMessage({ parentTokens, maxTokens }),
    };
  }
  return {
    status: "fork",
    maxTokens,
    ...(typeof parentTokens === "number" ? { parentTokens } : {}),
  };
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

function estimateSqliteTranscriptPromptTokens(
  events: readonly TranscriptEvent[],
): number | undefined {
  let byteEstimate = 0;
  let usageEstimate: number | undefined;
  for (const event of events) {
    const serialized = JSON.stringify(event);
    byteEstimate += Buffer.byteLength(serialized) + 1;
    if (!isRecord(event)) {
      continue;
    }
    const message = isRecord(event.message) ? event.message : undefined;
    const usageRaw = isRecord(message?.usage)
      ? message.usage
      : isRecord(event.usage)
        ? event.usage
        : undefined;
    const usage = normalizeUsage(usageRaw);
    const totalTokens = deriveSessionTotalTokens({ usage });
    if (typeof totalTokens === "number") {
      usageEstimate = Math.max(usageEstimate ?? 0, totalTokens);
    }
  }
  const estimatedFromBytes = Math.ceil(byteEstimate / 4);
  return Math.max(usageEstimate ?? 0, estimatedFromBytes) || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function generateParentForkEntryId(existingIds: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomUUID().slice(0, 8);
    if (!existingIds.has(id)) {
      existingIds.add(id);
      return id;
    }
  }
  const id = randomUUID();
  existingIds.add(id);
  return id;
}

function hasAssistantEntry(entries: readonly TranscriptEvent[]): boolean {
  return entries.some(
    (entry) =>
      isRecord(entry) &&
      entry.type === "message" &&
      isRecord(entry.message) &&
      entry.message.role === "assistant",
  );
}

function collectParentForkBranchLabels(params: {
  allEntries: readonly TranscriptEvent[];
  pathEntryIds: Set<string>;
}): Array<{ targetId: string; label: string; timestamp: string }> {
  const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
  for (const entry of params.allEntries) {
    if (
      isRecord(entry) &&
      entry.type === "label" &&
      typeof entry.label === "string" &&
      typeof entry.targetId === "string" &&
      typeof entry.id === "string" &&
      !params.pathEntryIds.has(entry.id) &&
      params.pathEntryIds.has(entry.targetId) &&
      typeof entry.timestamp === "string"
    ) {
      labelsToWrite.push({
        targetId: entry.targetId,
        label: entry.label,
        timestamp: entry.timestamp,
      });
    }
  }
  return labelsToWrite;
}

function readSqliteParentForkSourceTranscript(
  database: OpenClawAgentDatabase,
  parentSessionId: string,
): SqliteParentForkSourceTranscript | null {
  const fileEntries = loadSqliteTranscriptEventsFromDatabase(database, parentSessionId);
  if (fileEntries.length === 0) {
    return null;
  }
  const header = fileEntries.find(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.type === "session",
  );
  const entries = fileEntries.filter((entry) => !(isRecord(entry) && entry.type === "session"));
  const tree = scanSessionTranscriptTree(entries);
  const visiblePath = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  const appendPath = selectSessionTranscriptTreePathNodes(tree, tree.appendParentId);
  const mergedPath = mergeSessionTranscriptVisiblePathWithOpaqueAppendPath({
    visiblePath,
    appendPath,
    appendParentId: tree.appendParentId,
  });
  const branchEntries = mergedPath.nodes.flatMap((node) => {
    if (!isRecord(node.entry)) {
      return [];
    }
    const parentId = node.selectedParentId;
    return [node.entry.parentId === parentId ? node.entry : { ...node.entry, parentId }];
  });
  const pathEntryIds = new Set(
    branchEntries.flatMap((entry) =>
      isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [],
    ),
  );
  const lastLeafUpdateNode = tree.nodes.findLast((node) => node.leafId !== undefined);
  const lastLeafUpdateEntry = lastLeafUpdateNode?.entry;
  return {
    appendParentId: mergedPath.appendParentId,
    ...(lastLeafUpdateNode?.appendMode ? { appendMode: lastLeafUpdateNode.appendMode } : {}),
    branchEntries,
    cwd: typeof header?.cwd === "string" ? header.cwd : undefined,
    labelsToWrite: collectParentForkBranchLabels({ allEntries: entries, pathEntryIds }),
    leafId: tree.leafId,
    preserveLeafControl: isSessionTranscriptLeafControl(lastLeafUpdateEntry),
  };
}

function buildParentForkLabelEntries(params: {
  labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }>;
  pathEntryIds: Set<string>;
  lastEntryId: string | null;
}): TranscriptEvent[] {
  let parentId = params.lastEntryId;
  const labelEntries: TranscriptEvent[] = [];
  for (const { targetId, label, timestamp } of params.labelsToWrite) {
    const labelEntry = {
      type: "label",
      id: generateParentForkEntryId(params.pathEntryIds),
      parentId,
      timestamp,
      targetId,
      label,
    };
    params.pathEntryIds.add(labelEntry.id);
    labelEntries.push(labelEntry);
    parentId = labelEntry.id;
  }
  return labelEntries;
}

function writeSqliteParentForkTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  targetScope: ResolvedTranscriptScope,
  params: {
    parentSessionFile: string;
    source: SqliteParentForkSourceTranscript;
  },
): void {
  const timestamp = new Date().toISOString();
  const pathEntries = params.source.branchEntries;
  const pathEntryIds = new Set(
    pathEntries.flatMap((entry) =>
      isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [],
    ),
  );
  const lastPathEntry = pathEntries.at(-1);
  const lastPathEntryId =
    isRecord(lastPathEntry) && typeof lastPathEntry.id === "string" ? lastPathEntry.id : null;
  const labelEntries = buildParentForkLabelEntries({
    labelsToWrite: params.source.labelsToWrite,
    pathEntryIds,
    lastEntryId: lastPathEntryId,
  });
  const leafEntry = params.source.preserveLeafControl
    ? {
        type: "leaf",
        id: generateParentForkEntryId(pathEntryIds),
        parentId: (labelEntries.at(-1) as { id?: string } | undefined)?.id ?? lastPathEntryId,
        timestamp,
        targetId: params.source.leafId,
        appendParentId: params.source.appendParentId,
        ...(params.source.appendMode ? { appendMode: params.source.appendMode } : {}),
      }
    : null;
  appendTranscriptEventInTransaction(database, targetScope, {
    ...createSessionTranscriptHeader({
      cwd: params.source.cwd,
      sessionId: targetScope.sessionId,
    }),
    parentSession: params.parentSessionFile,
  });
  for (const event of [...pathEntries, ...labelEntries, ...(leafEntry ? [leafEntry] : [])]) {
    appendTranscriptEventInTransaction(database, targetScope, event);
  }
}

function forkSqliteParentTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedSqliteScope,
  params: {
    parentEntry: SessionEntry;
    parentSessionKey: string;
    targetSessionKey: string;
  },
): ForkSessionFromParentTranscriptResult {
  if (!params.parentEntry.sessionId) {
    return { status: "missing-parent" };
  }
  const source = readSqliteParentForkSourceTranscript(database, params.parentEntry.sessionId);
  if (!source) {
    return { status: "failed" };
  }
  const sessionId = randomUUID();
  const targetScope = {
    ...resolved,
    sessionId,
    sessionKey: normalizeSqliteSessionKey(params.targetSessionKey),
  };
  const parentSessionFile = formatSqliteTranscriptTarget({
    ...resolved,
    sessionId: params.parentEntry.sessionId,
    sessionKey: normalizeSqliteSessionKey(params.parentSessionKey),
  });
  const sessionFile = formatSqliteTranscriptTarget(targetScope);
  const shouldPersistBranch = source.preserveLeafControl || hasAssistantEntry(source.branchEntries);
  if (shouldPersistBranch) {
    writeSqliteParentForkTranscriptInTransaction(database, targetScope, {
      parentSessionFile,
      source,
    });
  } else {
    appendTranscriptEventInTransaction(database, targetScope, {
      ...createSessionTranscriptHeader({ cwd: source.cwd, sessionId }),
      parentSession: parentSessionFile,
    });
  }
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
  const sessionFile = formatSqliteTranscriptTarget(targetScope);
  appendTranscriptEventInTransaction(
    database,
    targetScope,
    createSessionTranscriptHeader({
      cwd: readTranscriptHeaderCwd(selected.rows),
      sessionId,
    }),
  );
  for (const event of selected.rows) {
    if (isSessionTranscriptHeader(event)) {
      continue;
    }
    appendTranscriptEventInTransaction(database, targetScope, event);
  }
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

function appendTranscriptEventInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  event: TranscriptEvent,
  options: { dedupeByMessageIdempotency?: boolean } = {},
): boolean {
  const db = getSessionKysely(database.db);
  const createdAt = readEventTimestamp(event) ?? Date.now();
  ensureTranscriptSessionRoot(database, scope, createdAt);
  const identity = readTranscriptEventIdentity(event);
  if (identity && readTranscriptIdentityByEventId(database, scope.sessionId, identity.eventId)) {
    return false;
  }
  if (
    identity?.messageIdempotencyKey &&
    options.dedupeByMessageIdempotency &&
    readTranscriptIdentityByMessageIdempotencyKey(
      database,
      scope.sessionId,
      identity.messageIdempotencyKey,
    )
  ) {
    return false;
  }
  const seq = readNextTranscriptSeq(database, scope.sessionId);
  executeSqliteQuerySync(
    database.db,
    db.insertInto("transcript_events").values({
      session_id: scope.sessionId,
      seq,
      event_json: JSON.stringify(event),
      created_at: createdAt,
    }),
  );
  if (!identity) {
    return true;
  }
  // Caller-checked appends may intentionally keep a duplicate key in the
  // message payload, but the identity index can only point at one row.
  const indexedMessageIdempotencyKey =
    identity.messageIdempotencyKey &&
    !options.dedupeByMessageIdempotency &&
    readTranscriptIdentityByMessageIdempotencyKey(
      database,
      scope.sessionId,
      identity.messageIdempotencyKey,
    )
      ? undefined
      : identity.messageIdempotencyKey;
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("transcript_event_identities")
      .values({
        session_id: scope.sessionId,
        event_id: identity.eventId,
        seq,
        event_type: identity.eventType,
        parent_id: identity.parentId,
        message_idempotency_key: indexedMessageIdempotencyKey,
        created_at: createdAt,
      })
      .onConflict((conflict) => conflict.columns(["session_id", "event_id"]).doNothing()),
  );
  return true;
}

function ensureTranscriptHeader(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  cwd: string | undefined,
  now: number,
): void {
  const db = getSessionKysely(database.db);
  const existing = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", scope.sessionId)
      .limit(1),
  );
  if (existing) {
    return;
  }
  appendTranscriptEventInTransaction(
    database,
    scope,
    createSessionTranscriptHeader({
      cwd,
      sessionId: scope.sessionId,
    }),
  );
  ensureTranscriptSessionRoot(database, scope, now);
}

function readActiveTranscriptAppendParentId(
  database: OpenClawAgentDatabase,
  sessionId: string,
): string | null {
  return resolveVisibleTranscriptAppendParentId(
    loadSqliteTranscriptEventsFromDatabase(database, sessionId),
  );
}

function replaceSqliteTranscriptEventsInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  events: readonly TranscriptEvent[],
): void {
  deleteSqliteTranscriptEventsInTransaction(database, resolved.sessionId);
  for (const event of events) {
    appendTranscriptEventInTransaction(database, resolved, event);
  }
}

function readTranscriptIdentityByEventId(
  database: OpenClawAgentDatabase,
  sessionId: string,
  eventId: string,
): { eventId: string; seq: number } | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_event_identities")
      .select(["event_id", "seq"])
      .where("session_id", "=", sessionId)
      .where("event_id", "=", eventId),
  );
  return row ? { eventId: row.event_id, seq: row.seq } : undefined;
}

function readTranscriptIdentityByMessageIdempotencyKey(
  database: OpenClawAgentDatabase,
  sessionId: string,
  idempotencyKey: string,
): { eventId: string; seq: number } | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_event_identities")
      .select(["event_id", "seq"])
      .where("session_id", "=", sessionId)
      .where("message_idempotency_key", "=", idempotencyKey)
      .orderBy("seq", "desc")
      .limit(1),
  );
  return row ? { eventId: row.event_id, seq: row.seq } : undefined;
}

function readTranscriptMessageByIdempotencyKey(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  idempotencyKey: string,
): { messageId: string; message: unknown } | undefined {
  const identity = readTranscriptIdentityByMessageIdempotencyKey(
    database,
    scope.sessionId,
    idempotencyKey,
  );
  if (!identity) {
    return undefined;
  }
  const db = getSessionKysely(database.db);
  const eventRow = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json"])
      .where("session_id", "=", scope.sessionId)
      .where("seq", "=", identity.seq),
  );
  if (!eventRow) {
    return undefined;
  }
  const event = JSON.parse(eventRow.event_json) as { message?: unknown };
  return {
    messageId: identity.eventId,
    message: event.message,
  };
}

function readTranscriptEventIdentity(event: unknown):
  | {
      eventId: string;
      eventType: string | null;
      parentId: string | null;
      messageIdempotencyKey: string | null;
    }
  | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const record = event as Record<string, unknown>;
  const eventId = typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined;
  if (!eventId) {
    return undefined;
  }
  return {
    eventId,
    eventType: typeof record.type === "string" ? record.type : null,
    parentId: typeof record.parentId === "string" ? record.parentId : null,
    messageIdempotencyKey: readMessageIdempotencyKey(record.message),
  };
}

function readMessageIdempotencyKey(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const value = (message as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readEventTimestamp(event: unknown): number | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const value = (event as { timestamp?: unknown }).timestamp;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function redactTranscriptMessageForStorage<TMessage>(
  message: TMessage,
  options: Pick<TranscriptMessageAppendOptions<TMessage>, "config">,
): TMessage {
  if (isTranscriptAgentMessage(message)) {
    return redactTranscriptMessage(message, options.config) as TMessage;
  }
  return redactSecrets(message);
}

function isTranscriptAgentMessage(value: unknown): value is AgentMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { role?: unknown }).role === "string"
  );
}

function formatSqliteTranscriptTarget(scope: ResolvedTranscriptScope): string {
  const pathPart = scope.path ? `:${scope.path}` : "";
  return `sqlite:${scope.agentId}:${scope.sessionId}${pathPart}`;
}
