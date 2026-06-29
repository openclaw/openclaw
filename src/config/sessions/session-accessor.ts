import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
} from "../../gateway/session-store-key.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { SessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { getRuntimeConfig } from "../io.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { formatSessionArchiveTimestamp } from "./artifacts.js";
import { resolveAgentMainSessionKey } from "./main-session.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveStorePath,
} from "./paths.js";
import {
  clearPluginHostCleanupTarget,
  clearPluginOwnedSessionState,
  hasPluginHostCleanupTarget,
  matchesPluginHostCleanupSession,
  shouldSkipPluginHostCleanupStore,
  type PluginHostSessionCleanupStoreParams,
} from "./plugin-host-cleanup.js";
import {
  appendSqliteTranscriptEvent,
  appendSqliteTranscriptEventSync,
  appendSqliteTranscriptMessage,
  applySqliteSessionEntryLifecycleMutation,
  appendSqliteExpectedSessionTranscriptTurn,
  cleanupSqliteSessionLifecycleArtifacts,
  deleteSqliteSessionEntryLifecycle,
  listSqliteSessionEntries,
  appendSqliteTranscriptMessageSync,
  forkSqliteSessionEntryFromParentTarget,
  forkSqliteSessionTranscriptFromParent,
  loadExactSqliteSessionEntry,
  loadLatestSqliteAssistantText,
  loadLatestSqliteAssistantMessage,
  loadLatestSqliteMessage,
  loadSqliteSessionEntry,
  loadSqliteTranscriptEvents,
  loadSqliteTranscriptEventsSync,
  patchSqliteSessionEntry,
  patchSqliteSessionEntryTarget,
  publishSqliteTranscriptUpdate,
  purgeSqliteDeletedAgentSessionEntries,
  readSqliteSessionUpdatedAt,
  replaceSqliteTranscriptEvents,
  replaceSqliteTranscriptEventsSync,
  replaceSqliteSessionEntry,
  replaceSqliteSessionEntrySync,
  resolveSqliteSessionKeyBySessionId,
  resolveSqliteSessionParentForkDecision,
  resetSqliteSessionEntryLifecycle,
  updateSqliteSessionEntry,
  upsertSqliteSessionEntry,
  withSqliteTranscriptWriteLock,
} from "./session-accessor.sqlite.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
  sqliteSessionFileMarkerMatchesSession,
} from "./sqlite-marker.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type {
  ResolvedSessionMaintenanceConfig,
  SessionMaintenanceWarning,
} from "./store-maintenance.js";
import {
  projectSessionEntryForPersistenceRevision,
  resolveSessionStoreEntry,
  type DeleteSessionEntryLifecycleResult,
  type ResetSessionEntryLifecycleMutation,
  type ResetSessionEntryLifecycleResult,
  type DeletedAgentSessionEntryPurgeParams,
  type SessionArchivedTranscriptCleanupRule,
  type SessionEntryLifecycleMutationResult,
  type SessionEntryLifecycleRemoval,
  type SessionEntryLifecycleUpsert,
  type SessionEntryPatchProjectionContext,
  type SessionEntryPatchProjectionFailure,
  type SessionEntryPatchProjectionResult,
  type SessionEntryPatchProjectionSnapshot,
  type SessionEntryPatchProjectionTarget,
  type SessionLifecycleArchivedTranscript,
  type SessionLifecycleArtifactCleanupParams,
  type SessionLifecycleArtifactCleanupResult,
  type SessionLifecycleStoreTarget,
} from "./store.js";
import { resolveAllAgentSessionStoreTargetsSync, type SessionStoreTarget } from "./targets.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import { replayRecentUserAssistantMessages } from "./transcript-replay.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";
import { runWithOwnedSessionTranscriptWriteLock } from "./transcript-write-context.js";
import type { SessionCompactionCheckpoint, SessionEntry } from "./types.js";

/**
 * Session access API for callers that need entries or transcripts without
 * depending on the persisted store layout. Callers provide stable session
 * identity, and this module resolves the current entry/transcript target while
 * preserving canonical-key, transcript-linking, and update-notification rules.
 *
 * Ownership contract (#88838): this accessor is the permanent storage-neutral
 * domain boundary for session/transcript runtime access; the SQLite storage
 * flip implements this interface. The entry workflow helpers in store.ts are
 * the file-backend implementation it delegates to plus the plugin-SDK
 * deprecation-window surface (RFC 0007); they become internal as direct
 * callers migrate here. New runtime callers use this module, not store.ts.
 */
export type SessionAccessScope = {
  /** Agent owner used when the session key does not already encode one. */
  agentId?: string;
  /**
   * Set false only for internal read-only hot paths that will not retain or
   * mutate the returned entry.
   */
  clone?: boolean;
  /** Environment override used when resolving agent-scoped store paths in tests/tools. */
  env?: NodeJS.ProcessEnv;
  /** Set false for metadata-only reads that do not need hydrated prompt refs. */
  hydrateSkillPromptRefs?: boolean;
  /** Use latest when the caller must bypass any in-process metadata snapshot. */
  readConsistency?: "latest";
  /** Canonical or alias session key for the entry being read or written. */
  sessionKey: string;
  /** Explicit store path for callers that already resolved the owning store. */
  storePath?: string;
};

export type LogicalSessionAccessScope = {
  /** Runtime config whose session store rules define the logical session owner. */
  cfg: OpenClawConfig;
  /** Environment override used when resolving configured/discovered agent stores. */
  env?: NodeJS.ProcessEnv;
  /** Canonical or alias session key for the logical entry being read or written. */
  sessionKey: string;
};

type SessionEntryListScope = Partial<Omit<SessionAccessScope, "sessionKey">>;

export type ResolvedSessionEntryAccessTarget = {
  /** Agent owner inferred from the canonical session key. */
  agentId: string;
  /** Canonical session key returned to callers even when an alias row won. */
  canonicalKey: string;
  /** Freshest matching entry, if any. */
  entry?: SessionEntry;
  /** Original caller-supplied key after trimming. */
  requestedKey: string;
  /** Persisted key for the selected row. */
  storeKey: string;
};

type ResolvedSessionEntryStoreTarget = ResolvedSessionEntryAccessTarget & {
  storePath: string;
};

export type SessionEntryCandidateAccessScope = {
  /** Agent owner whose session store is searched. */
  agentId: string;
  /** Ordered session keys to test inside the resolved store. */
  candidateKeys: readonly string[];
  /** Runtime config whose session store rule selects the backend target. */
  cfg: OpenClawConfig;
  /** Environment override used when resolving agent-scoped store paths in tests/tools. */
  env?: NodeJS.ProcessEnv;
  /** Optional synthesized entry returned only when no candidate exists. */
  fallback?: {
    entry: SessionEntry;
    sessionKey: string;
  };
};

export type ResolvedSessionEntryCandidateTarget = {
  /** Agent owner whose session store produced this result. */
  agentId: string;
  /** Candidate key that selected the result, or the fallback key. */
  candidateKey: string;
  /** Session metadata cloned from storage or from the synthesized fallback. */
  entry: SessionEntry;
  /** False only for synthesized fallback entries that have not been written. */
  persisted: boolean;
  /** Persisted key selected by the backend, or the fallback key. */
  sessionKey: string;
};

export type ResolvedSessionEntryUpdateContext = Omit<ResolvedSessionEntryAccessTarget, "entry"> & {
  /** Mutable entry inside the storage operation. */
  entry: SessionEntry;
};

export type ResolvedSessionEntryUpdateResult<T> =
  | {
      canonicalKey: string;
      found: false;
    }
  | {
      canonicalKey: string;
      entry: SessionEntry;
      found: true;
      result: T;
      storeKey: string;
    };

export type SessionTranscriptAccessScope = Omit<SessionAccessScope, "sessionKey"> & {
  /** Deprecated transcript locator from older file-backed call sites. */
  sessionFile?: string;
  /** Runtime session id used to resolve the transcript identity. */
  sessionId: string;
  /** Required when resolving through session metadata; optional for legacy locators. */
  sessionKey?: string;
  /** Channel thread suffix used when deriving topic transcript paths. */
  threadId?: string | number;
};

export type SessionTranscriptRuntimeScope = SessionAccessScope & {
  /** Deprecated transcript locator from older file-backed call sites. */
  sessionFile?: string;
  sessionId: string;
  threadId?: string | number;
};

export type SessionTranscriptReadScope = Omit<SessionTranscriptRuntimeScope, "sessionKey"> & {
  /** Canonical key when the caller has a session-store identity for this read. */
  sessionKey?: string;
  /** Entry already loaded by hot callers; avoids rereading the session store. */
  sessionEntry?: Pick<SessionEntry, "sessionFile"> & Partial<Pick<SessionEntry, "sessionId">>;
};

export type SessionTranscriptReadTarget = Omit<
  SessionTranscriptRuntimeTarget,
  "agentId" | "sessionKey"
> & {
  agentId?: string;
  sessionKey?: string;
};

export type SessionTranscriptWriteScope = Omit<SessionTranscriptAccessScope, "sessionId"> & {
  /** Optional for appenders that resolve it from the session entry. */
  sessionId?: string;
};

export type SessionEntrySummary = {
  /** Persisted key for the entry. */
  sessionKey: string;
  /** Entry value cloned from the backing store unless the caller requested borrowed reads. */
  entry: SessionEntry;
};

/** Session entry read by the exact persisted session key, without alias resolution. */
export type ExactSessionEntry = {
  sessionKey: string;
  entry: SessionEntry;
};

/** Raw transcript record for non-message events; message records use appendTranscriptMessage. */
export type TranscriptEvent = unknown;

export type TranscriptMessageAppendOptions<TMessage> = {
  /** Runtime config used for message redaction and transcript header metadata. */
  config?: OpenClawConfig;
  /** Working directory recorded in a newly created transcript header. */
  cwd?: string;
  /** How duplicate message idempotency keys are detected before append. */
  idempotencyLookup?: "scan" | "caller-checked";
  /** Provider/channel message payload to persist. */
  message: TMessage;
  /** Testable timestamp override for the generated transcript entry. */
  now?: number;
  /** Existing transcript event id owned by a caller with its own session tree. */
  eventId?: string;
  /** Existing parent id owned by a caller with its own session tree. */
  parentId?: string | null;
  /** Optional finalizer that runs after duplicate detection but before persistence. */
  prepareMessageAfterIdempotencyCheck?: (message: TMessage) => TMessage | undefined;
  /** Allow append without parent-link migration for large legacy linear transcripts. */
  useRawWhenLinear?: boolean;
};

export type TranscriptMessageAppendResult<TMessage> = {
  /** False when idempotency lookup found an existing transcript message. */
  appended: boolean;
  /** Redacted message payload as persisted or replayed from the transcript. */
  message: TMessage;
  /** Existing or newly generated transcript message id. */
  messageId: string;
};

/** Transcript update fields supplied by callers; the target is resolved here. */
export type TranscriptUpdatePayload = Partial<SessionTranscriptUpdate>;

export type LatestTranscriptAssistantText = {
  id?: string;
  text: string;
  timestamp?: number;
};

export type LatestTranscriptAssistantMessage = {
  id?: string;
  message: unknown;
};

export type LatestTranscriptMessage = {
  id?: string;
  message: unknown;
};

export type SessionTranscriptWriteLockAccessorContext = {
  appendMessage: <TMessage>(
    options: TranscriptMessageAppendOptions<TMessage>,
  ) => Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
  readEvents: () => Promise<TranscriptEvent[]>;
  replaceEvents: (events: readonly TranscriptEvent[]) => Promise<void>;
};

export type SessionTranscriptTurnUpdateMode = "inline" | "file-only" | "none";

export type SessionTranscriptTurnMessageAppend = TranscriptMessageAppendOptions<unknown> & {
  /**
   * Runs inside the file-backed write lock before this message is appended.
   * SQLite evaluates duplicate/skip decisions inside the same queued write as
   * the transcript row append because predicates may perform async reads.
   */
  shouldAppend?: (context: SessionTranscriptTurnWriteContext) => Promise<boolean> | boolean;
};

export type SessionTranscriptTurnWriteContext = {
  agentId?: string;
  sessionFile: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
};

export type SessionTranscriptTurnPersistOptions = {
  /** Runtime config used for lock settings, redaction, and header metadata. */
  config?: OpenClawConfig;
  /** Working directory recorded in a newly created transcript header. */
  cwd?: string;
  /**
   * Rejects the turn when the persisted session key no longer points at this
   * runtime session id. SQLite evaluates this guard inside the same queued
   * write as the transcript append and metadata touch.
   */
  expectedSessionId?: string;
  /** Message rows to append under one transcript write lock. */
  messages: readonly SessionTranscriptTurnMessageAppend[];
  /** Controls whether the update event includes the last appended message. */
  updateMode?: SessionTranscriptTurnUpdateMode;
  /** Emit file-only updates even when every candidate message was skipped. */
  publishWhen?: "always" | "when-appended";
  /**
   * Touch updatedAt/sessionFile metadata after appending.
   * SQLite implementation note: transcript row append(s) plus this session
   * metadata touch should be one SQLite write transaction; publish happens
   * after that transaction commits.
   */
  touchSessionEntry?: boolean;
};

export type SessionTranscriptTurnPersistResult = {
  appendedCount: number;
  messages: TranscriptMessageAppendResult<unknown>[];
  rejectedReason?: "session-rebound";
  sessionEntry: SessionEntry | undefined;
  sessionFile: string;
};

export type SessionTranscriptRuntimeTarget = {
  agentId: string;
  sessionFile: string;
  sessionId: string;
  sessionKey: string;
};

export type SessionTranscriptManualTrimResult =
  | {
      compacted: false;
      reason: "no transcript";
    }
  | {
      compacted: false;
      kept: number;
    }
  | {
      archived: string;
      compacted: true;
      kept: number;
    };

export type SessionTranscriptManualTrimPreflightResult =
  | Extract<SessionTranscriptManualTrimResult, { compacted: false }>
  | {
      compacted: true;
    };

export type SessionEntryUpdateOptions = {
  /** Skip prune/cap/rotation maintenance for specialized internal updates. */
  skipMaintenance?: boolean;
  /** Let the writer cache retain the updated object without cloning. */
  takeCacheOwnership?: boolean;
  /** Throw when best-effort store recovery cannot confirm the requested write. */
  requireWriteSuccess?: boolean;
};

export type SessionAbortTargetCutoff = {
  messageSid?: string;
  timestamp?: number;
};

export type SessionAbortTargetContext = {
  entry: SessionEntry;
  sessionKey: string;
};

export type SessionAbortTargetIdentity = SessionAbortTargetContext & {
  sessionId?: string;
};

export type SessionAbortTargetResult = SessionAbortTargetIdentity & {
  persisted: boolean;
  persistenceError?: string;
};

export type SessionLifecycleTranscriptInfo = {
  sessionFile?: string;
  transcriptArchived?: boolean;
};

export type SessionLifecycleRolloverResult = {
  previousSessionTranscript: SessionLifecycleTranscriptInfo;
  sessionEntry: SessionEntry;
};

export type ReplySessionInitializationSnapshot = {
  currentEntry?: SessionEntry;
  readEntry: (sessionKey: string) => SessionEntry | undefined;
  revision: string;
};

export type ReplySessionInitializationCommitContext = {
  currentEntry?: SessionEntry;
  readEntry: (sessionKey: string) => SessionEntry | undefined;
  sessionEntry: SessionEntry;
};

export type ReplySessionInitializationCommitResult =
  | {
      ok: true;
      previousSessionTranscript: SessionLifecycleTranscriptInfo;
      sessionEntry: SessionEntry;
      sessionStoreView: Record<string, SessionEntry>;
    }
  | {
      ok: false;
      currentEntry?: SessionEntry;
      reason: "stale-snapshot";
      revision: string;
    };

type SessionEntryRetirement = {
  entry: SessionEntry;
  key: string;
};

let sessionArchiveRuntimePromise: Promise<
  typeof import("../../gateway/session-archive.runtime.js")
> | null = null;

function loadSessionArchiveRuntime() {
  sessionArchiveRuntimePromise ??= import("../../gateway/session-archive.runtime.js");
  return sessionArchiveRuntimePromise;
}

export type SessionEntryPatchOptions = {
  /** Entry to synthesize when a patch operation is allowed to create. */
  fallbackEntry?: SessionEntry;
  /** Fully resolved maintenance settings when the caller already has config loaded. */
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  /** Keep the previous updatedAt value when the patch should not count as activity. */
  preserveActivity?: boolean;
  /** Throw when best-effort store recovery cannot confirm the requested write. */
  requireWriteSuccess?: boolean;
  /** Replace the whole entry instead of merging the returned patch. */
  replaceEntry?: boolean;
  /** Skip prune/cap/rotation maintenance for specialized internal updates. */
  skipMaintenance?: boolean;
  /** Let the writer cache retain the updated object without cloning. */
  takeCacheOwnership?: boolean;
};

export type SessionEntryPatchContext = {
  /** Present when the patched entry already existed before fallback synthesis. */
  existingEntry?: SessionEntry;
};

export type SessionEntryPatchResult = {
  /** Exact persisted key for the patched entry after alias normalization. */
  sessionKey: string;
  /** Persisted entry returned by the backing store. */
  entry: SessionEntry;
};

export type SessionEntryTargetPatchScope = {
  storePath: string;
  /** Canonical key plus aliases that identify the logical entry. */
  target: SessionLifecycleStoreTarget;
};

export type RestartRecoveryLifecycleEntry = {
  /** Exact persisted key for the restart recovery candidate row. */
  sessionKey: string;
  /** Detached entry snapshot; mutating it does not persist unless returned as a replacement. */
  entry: SessionEntry;
};

export type RestartRecoveryLifecycleReplacement = {
  /** Exact persisted key to replace. Missing keys are ignored. */
  sessionKey: string;
  /** Full replacement row to persist for this restart recovery lifecycle step. */
  entry: SessionEntry;
};

export type RestartRecoveryLifecycleUpdate<T> = {
  /** Caller-owned result returned after replacements are persisted. */
  result: T;
  /** Exact rows to replace inside the storage transaction. */
  replacements?: Iterable<RestartRecoveryLifecycleReplacement>;
};

/** File-backed checkpoint transcript fork produced by the checkpoint storage boundary. */
export type SessionCompactionCheckpointForkedTranscript = {
  sessionFile: string;
  sessionId: string;
  totalTokens?: number;
};

/** Result of resolving and copying checkpoint transcript content for branch/restore. */
export type SessionCompactionCheckpointTranscriptForkResult =
  | { status: "created"; transcript: SessionCompactionCheckpointForkedTranscript }
  | { status: "missing-boundary" }
  | { status: "failed" };

/** Decision made before inheriting parent context into a child session. */
export type SessionParentForkDecision =
  | {
      status: "fork";
      maxTokens: number;
      parentTokens?: number;
    }
  | {
      status: "skip";
      reason: "parent-too-large";
      maxTokens: number;
      parentTokens: number;
      message: string;
    };

/** SQLite transcript identity created for a child fork. */
export type ParentForkedSessionTranscript = {
  sessionFile: string;
  sessionId: string;
};

export type ForkSessionFromParentTranscriptResult =
  | {
      status: "created";
      transcript: ParentForkedSessionTranscript;
    }
  | { status: "missing-parent" }
  | { status: "failed" };

export type ForkSessionFromParentTranscriptParams = {
  agentId?: string;
  parentEntry: SessionEntry;
  parentSessionKey: string;
  sessionKey: string;
  storePath: string;
};

export type ForkSessionEntryFromParentTargetResult =
  | {
      status: "forked";
      fork: ParentForkedSessionTranscript;
      parentEntry: SessionEntry;
      sessionEntry: SessionEntry;
      decision: Extract<SessionParentForkDecision, { status: "fork" }>;
    }
  | {
      status: "skipped";
      reason: "existing-entry" | "decision-skip";
      parentEntry?: SessionEntry;
      sessionEntry: SessionEntry;
      decision?: SessionParentForkDecision;
    }
  | { status: "missing-entry" }
  | { status: "missing-parent" }
  | { status: "failed" };

export type ForkSessionEntryFromParentTargetParams = {
  agentId?: string;
  decisionSkipPatch?: (params: {
    decision: Extract<SessionParentForkDecision, { status: "skip" }>;
    entry: SessionEntry;
    parentEntry: SessionEntry;
  }) => Partial<SessionEntry> | null;
  fallbackEntry?: SessionEntry;
  parentTarget: SessionLifecycleStoreTarget;
  patch?: (params: {
    entry: SessionEntry;
    parentEntry: SessionEntry;
    fork: ParentForkedSessionTranscript;
    decision: Extract<SessionParentForkDecision, { status: "fork" }>;
  }) => Partial<SessionEntry>;
  sessionTarget: SessionLifecycleStoreTarget;
  skipForkWhen?: (entry: SessionEntry) => boolean;
  skipPatch?: (entry: SessionEntry) => Partial<SessionEntry> | null;
  storePath: string;
};

/** Result of applying a checkpoint branch or restore mutation to session storage. */
export type SessionCompactionCheckpointMutationResult =
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

export type SessionCompactionCheckpointEntryBuildContext = {
  /** Checkpoint row selected from the current persisted session entry. */
  checkpoint: SessionCompactionCheckpoint;
  /** Persisted entry that owns the selected checkpoint. */
  currentEntry: SessionEntry;
  /** Forked transcript identity created from the stored checkpoint boundary. */
  forkedTranscript: SessionCompactionCheckpointForkedTranscript;
};

export type SessionCompactionCheckpointTranscriptForker = (
  checkpoint: SessionCompactionCheckpoint,
) => Promise<SessionCompactionCheckpointTranscriptForkResult>;

export type SessionCompactionCheckpointEntryBuilder = (
  context: SessionCompactionCheckpointEntryBuildContext,
) => Promise<SessionEntry> | SessionEntry;

export type BranchSessionFromCompactionCheckpointParams = {
  /** Checkpoint id stored on the source session entry. */
  checkpointId: string;
  /** Builds the branched session entry from the forked transcript. */
  buildEntry: SessionCompactionCheckpointEntryBuilder;
  /** Copies transcript content through the stored checkpoint boundary. */
  forkTranscriptFromCheckpoint: SessionCompactionCheckpointTranscriptForker;
  /** Persisted key for the new checkpoint branch. */
  nextKey: string;
  /** Canonical key used as the branch parent. */
  sourceKey: string;
  /** Actual persisted key to read when a legacy alias still owns the row. */
  sourceStoreKey?: string;
  /** Explicit store target for file-backed stores and SQLite migration adapters. */
  storePath: string;
};

export type RestoreSessionFromCompactionCheckpointParams = {
  /** Checkpoint id stored on the current session entry. */
  checkpointId: string;
  /** Builds the restored session entry from the forked transcript. */
  buildEntry: SessionCompactionCheckpointEntryBuilder;
  /** Copies transcript content through the stored checkpoint boundary. */
  forkTranscriptFromCheckpoint: SessionCompactionCheckpointTranscriptForker;
  /** Canonical key to replace with the restored checkpoint state. */
  sessionKey: string;
  /** Actual persisted key to read when a legacy alias still owns the row. */
  sessionStoreKey?: string;
  /** Explicit store target for file-backed stores and SQLite migration adapters. */
  storePath: string;
};

export type TemporarySessionMappingPreservationResult<T> = {
  /** Result returned by the operation while the temporary mapping may exist. */
  result: T;
  /** Snapshot failure; callers may continue when temporary cleanup is best-effort. */
  snapshotFailure?: string;
  /** Restore/delete failure for the original temporary mapping state. */
  restoreFailure?: string;
};

type TemporarySessionMappingSnapshot =
  | {
      canRestore: false;
      sessionKey: string;
      snapshotFailure: string;
      storePath: string;
    }
  | {
      canRestore: true;
      hadEntry: false;
      sessionKey: string;
      storePath: string;
    }
  | {
      canRestore: true;
      entry: SessionEntry;
      hadEntry: true;
      sessionKey: string;
      storePath: string;
    };

type TemporarySessionMappingOperationResult<T> =
  | {
      ok: true;
      result: T;
    }
  | {
      error: unknown;
      ok: false;
    };

export type SessionEntryCreateWithTranscriptContext = {
  /** Current entry under the requested key before creation, if any. */
  existingEntry?: SessionEntry;
  /** Current entries snapshot for validation rules such as label uniqueness. */
  sessionEntries: Record<string, SessionEntry>;
};

export type SessionEntryCreateWithTranscriptResult<TError = string> =
  | { ok: true; entry: SessionEntry; sessionFile: string }
  | { ok: false; error: TError; phase: "entry" }
  | { ok: false; error: string; phase: "transcript" };

export type SessionEntryCreateWithTranscriptPrepareResult<TError = string> =
  | { ok: true; entry: SessionEntry }
  | { ok: false; error: TError };

export type SessionPatchProjectionContext = SessionEntryPatchProjectionContext;
export type SessionPatchProjectionFailure = SessionEntryPatchProjectionFailure;
export type SessionPatchProjectionResult<TFailure extends SessionPatchProjectionFailure> =
  SessionEntryPatchProjectionResult<TFailure>;
export type SessionPatchProjectionSnapshot = SessionEntryPatchProjectionSnapshot;
export type SessionPatchProjectionTarget = SessionEntryPatchProjectionTarget;

export type {
  DeleteSessionEntryLifecycleResult,
  ResetSessionEntryLifecycleResult,
  SessionLifecycleArchivedTranscript,
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
  SessionLifecycleStoreTarget,
};

export type {
  DeletedAgentSessionEntryPurgeParams,
  SessionArchivedTranscriptCleanupRule,
  SessionEntryLifecycleMutationResult,
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
};

export type ResetSessionEntryLifecycleParams = {
  /** Runs after the persisted entry rotates and before transcript artifacts move. */
  afterEntryMutation?: (mutation: ResetSessionEntryLifecycleMutation) => Promise<void> | void;
  /** Agent owner used to resolve backend transcript artifacts. */
  agentId?: string;
  /** Builds the persisted replacement entry from the current backend row. */
  buildNextEntry: (context: {
    currentEntry?: SessionEntry;
    primaryKey: string;
  }) => Promise<SessionEntry> | SessionEntry;
  /** Explicit store target for file-backed stores and SQLite migration adapters. */
  storePath: string;
  /** Canonical key plus aliases that identify the logical entry. */
  target: SessionLifecycleStoreTarget;
};

export type DeleteSessionEntryLifecycleParams = {
  /** Agent owner used to resolve backend transcript artifacts. */
  agentId?: string;
  /** Whether transcript artifacts should be archived/deleted with the entry. */
  archiveTranscript: boolean;
  /** Explicit store target for file-backed stores and SQLite migration adapters. */
  storePath: string;
  /** Canonical key plus aliases that identify the logical entry. */
  target: SessionLifecycleStoreTarget;
};

export type CanonicalizeSessionEntryAliasesResult = {
  canonicalKey: string;
  entry?: SessionEntry;
};

export { clearPluginOwnedSessionState };

function isStorePathTemplate(store?: string): boolean {
  return typeof store === "string" && store.includes("{agentId}");
}

function resolveLogicalSessionStoreCandidates(params: {
  agentId: string;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): SessionStoreTarget[] {
  const storeConfig = params.cfg.session?.store;
  const defaultTarget = {
    agentId: params.agentId,
    storePath: resolveStorePath(storeConfig, { agentId: params.agentId, env: params.env }),
  };
  if (!isStorePathTemplate(storeConfig)) {
    return [defaultTarget];
  }
  const targets = new Map<string, SessionStoreTarget>();
  targets.set(defaultTarget.storePath, defaultTarget);
  for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env })) {
    if (target.agentId === params.agentId) {
      targets.set(target.storePath, target);
    }
  }
  return [...targets.values()];
}

function buildLogicalSessionEntryCandidateKeys(params: {
  agentId: string;
  canonicalKey: string;
  cfg: OpenClawConfig;
  requestedKey: string;
}): string[] {
  const targets = new Set<string>();
  if (params.canonicalKey) {
    targets.add(params.canonicalKey);
  }
  if (params.requestedKey && params.requestedKey !== params.canonicalKey) {
    targets.add(params.requestedKey);
  }
  if (params.canonicalKey === "global" || params.canonicalKey === "unknown") {
    return [...targets];
  }
  const agentMainKey = resolveAgentMainSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (params.canonicalKey === agentMainKey) {
    targets.add(`agent:${params.agentId}:main`);
  }
  return [...targets];
}

function findFreshestSessionEntryMatch(
  entries: SessionEntrySummary[],
  candidateKeys: readonly string[],
): SessionEntrySummary | undefined {
  let freshest: SessionEntrySummary | undefined;
  for (const candidate of candidateKeys) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    const match = entries.find((entry) => entry.sessionKey === trimmed);
    if (match && (!freshest || (match.entry.updatedAt ?? 0) >= (freshest.entry.updatedAt ?? 0))) {
      freshest = match;
    }
  }
  return freshest;
}

/**
 * Resolves a logical session key to the freshest matching entry across the
 * configured store and discovered same-agent stores.
 */
export function resolveSessionEntryAccessTarget(
  scope: LogicalSessionAccessScope,
): ResolvedSessionEntryAccessTarget {
  const target = resolveSessionEntryStoreTarget(scope);
  return {
    agentId: target.agentId,
    canonicalKey: target.canonicalKey,
    entry: target.entry,
    requestedKey: target.requestedKey,
    storeKey: target.storeKey,
  };
}

/** Resolves ordered candidate keys inside one agent-owned session store. */
export function resolveSessionEntryCandidateTarget(
  scope: SessionEntryCandidateAccessScope,
): ResolvedSessionEntryCandidateTarget | null {
  const storePath = resolveStorePath(scope.cfg.session?.store, {
    agentId: scope.agentId,
    env: scope.env,
  });
  const store = Object.fromEntries(
    listSessionEntries({ agentId: scope.agentId, storePath }).map(({ sessionKey, entry }) => [
      sessionKey,
      entry,
    ]),
  );
  for (const candidateKey of uniqueStrings(scope.candidateKeys.map((key) => key.trim()))) {
    if (!candidateKey) {
      continue;
    }
    const resolved = resolveSessionStoreEntry({ store, sessionKey: candidateKey });
    if (!resolved.existing) {
      continue;
    }
    return {
      agentId: scope.agentId,
      candidateKey,
      entry: structuredClone(resolved.existing),
      persisted: true,
      sessionKey: resolved.normalizedKey,
    };
  }
  const fallbackKey = scope.fallback?.sessionKey.trim();
  if (!fallbackKey || !scope.fallback) {
    return null;
  }
  return {
    agentId: scope.agentId,
    candidateKey: fallbackKey,
    entry: structuredClone(scope.fallback.entry),
    persisted: false,
    sessionKey: fallbackKey,
  };
}

function resolveSessionEntryStoreTarget(
  scope: LogicalSessionAccessScope,
): ResolvedSessionEntryStoreTarget {
  const requestedKey = scope.sessionKey.trim();
  const canonicalKey = resolveSessionStoreKey({ cfg: scope.cfg, sessionKey: requestedKey });
  const agentId = resolveSessionStoreAgentId(scope.cfg, canonicalKey);
  const scanTargets = buildLogicalSessionEntryCandidateKeys({
    agentId,
    canonicalKey,
    cfg: scope.cfg,
    requestedKey,
  });
  const candidates = resolveLogicalSessionStoreCandidates({
    agentId,
    cfg: scope.cfg,
    env: scope.env,
  });
  const fallback = candidates[0] ?? {
    agentId,
    storePath: resolveStorePath(scope.cfg.session?.store, { agentId, env: scope.env }),
  };
  let selectedStorePath = fallback.storePath;
  let selectedMatch = findFreshestSessionEntryMatch(
    listSessionEntries({ agentId, storePath: fallback.storePath }),
    scanTargets,
  );
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    const match = findFreshestSessionEntryMatch(
      listSessionEntries({ agentId, storePath: candidate.storePath }),
      scanTargets,
    );
    if (
      match &&
      (!selectedMatch || (match.entry.updatedAt ?? 0) >= (selectedMatch.entry.updatedAt ?? 0))
    ) {
      selectedStorePath = candidate.storePath;
      selectedMatch = match;
    }
  }
  return {
    agentId,
    canonicalKey,
    entry: selectedMatch?.entry,
    requestedKey,
    storeKey: selectedMatch?.sessionKey ?? canonicalKey,
    storePath: selectedStorePath,
  };
}

/**
 * Mutates the freshest matching logical session entry without exposing the
 * backing store map to callers.
 */
export async function updateResolvedSessionEntry<T>(
  scope: LogicalSessionAccessScope,
  update: (entry: SessionEntry, context: ResolvedSessionEntryUpdateContext) => Promise<T> | T,
): Promise<ResolvedSessionEntryUpdateResult<T>> {
  const target = resolveSessionEntryStoreTarget(scope);
  if (!target.entry) {
    return { canonicalKey: target.canonicalKey, found: false };
  }
  let updateResult: T | undefined;
  const updated = await patchSessionEntry(
    { sessionKey: target.storeKey, storePath: target.storePath },
    async (entry) => {
      const context: ResolvedSessionEntryUpdateContext = {
        agentId: target.agentId,
        canonicalKey: target.canonicalKey,
        entry,
        requestedKey: target.requestedKey,
        storeKey: target.storeKey,
      };
      updateResult = await update(entry, context);
      return entry;
    },
    {
      replaceEntry: true,
      skipMaintenance: true,
    },
  );
  if (!updated) {
    return { canonicalKey: target.canonicalKey, found: false };
  }
  return {
    canonicalKey: target.canonicalKey,
    entry: structuredClone(updated),
    found: true,
    result: updateResult as T,
    storeKey: target.storeKey,
  };
}

/** Returns the entry for a canonical or alias session key, if one exists. */
export function loadSessionEntry(scope: SessionAccessScope): SessionEntry | undefined {
  return loadSqliteSessionEntry(scope);
}

/**
 * Returns only the row persisted under the exact key provided.
 * Use this for authorization-sensitive routing where alias canonicalization
 * could cross an account or agent boundary.
 */
export function loadExactSessionEntry(scope: SessionAccessScope): ExactSessionEntry | undefined {
  return loadExactSqliteSessionEntry(scope);
}

/** Lists entries from the resolved store, preserving the persisted key for each row. */
export function listSessionEntries(scope: SessionEntryListScope = {}): SessionEntrySummary[] {
  return listSqliteSessionEntries(scope);
}

/** Reads the last activity timestamp for one session entry, or undefined when absent. */
export function readSessionUpdatedAt(scope: SessionAccessScope): number | undefined {
  return readSqliteSessionUpdatedAt(scope);
}

/** Creates or updates one entry from a partial patch and returns the persisted entry. */
export async function upsertSessionEntry(
  scope: SessionAccessScope,
  patch: Partial<SessionEntry>,
): Promise<SessionEntry | null> {
  return await upsertSqliteSessionEntry(scope, patch);
}

/** Replaces one entry with the supplied value and returns the persisted entry. */
export async function replaceSessionEntry(
  scope: SessionAccessScope,
  entry: SessionEntry,
): Promise<SessionEntry | null> {
  return await replaceSqliteSessionEntry(scope, entry);
}

/** Replaces one entry synchronously for sync session runtimes. */
export function replaceSessionEntrySync(scope: SessionAccessScope, entry: SessionEntry): void {
  replaceSqliteSessionEntrySync(scope, entry);
}

/**
 * Applies an atomic patch to one entry.
 * The updater sees the current entry plus whether it was synthesized from a
 * fallback; returning null skips persistence.
 */
export async function patchSessionEntry(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  return await patchSqliteSessionEntry(scope, update, options);
}

/**
 * Applies an atomic patch to the freshest entry selected from a canonical key
 * plus its known aliases, then persists the result under the canonical key.
 */
export async function patchSessionEntryTarget(
  scope: SessionEntryTargetPatchScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SessionEntryPatchOptions = {},
): Promise<SessionEntry | null> {
  return await patchSqliteSessionEntryTarget(scope, update, options);
}

/**
 * Applies an atomic patch and returns the persisted key selected by the backing
 * store. Use when a caller must keep sidecar state keyed to the final row.
 */
export async function patchSessionEntryWithKey(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
    context: SessionEntryPatchContext,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SessionEntryPatchOptions = {},
): Promise<SessionEntryPatchResult | null> {
  const entry = await patchSqliteSessionEntry(scope, update, options);
  return entry ? { sessionKey: normalizeStoreSessionKey(scope.sessionKey), entry } : null;
}

/**
 * Copies one parent transcript into a new child transcript target.
 * This is for guarded callers that already own the eventual entry commit.
 */
export async function forkSessionFromParentTranscript(
  params: ForkSessionFromParentTranscriptParams,
): Promise<ForkSessionFromParentTranscriptResult> {
  return await forkSqliteSessionTranscriptFromParent(params);
}

/**
 * Forks parent transcript content and persists the child entry/alias cleanup in
 * one storage-owned operation.
 */
export async function forkSessionEntryFromParentTarget(
  params: ForkSessionEntryFromParentTargetParams,
): Promise<ForkSessionEntryFromParentTargetResult> {
  return await forkSqliteSessionEntryFromParentTarget(params);
}

/** Resolves whether a parent session is small enough to fork through the active store. */
export async function resolveSessionParentForkDecision(params: {
  parentEntry: SessionEntry;
  storePath: string;
}): Promise<SessionParentForkDecision> {
  return await resolveSqliteSessionParentForkDecision(params);
}

/**
 * Promotes the freshest alias row to the canonical key, prunes legacy aliases,
 * and optionally patches the canonical entry under one accessor operation.
 */
export async function canonicalizeSessionEntryAliases(params: {
  agentId?: string;
  storePath: string;
  target: SessionLifecycleStoreTarget;
  update?: (
    entry: SessionEntry | undefined,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
}): Promise<CanonicalizeSessionEntryAliasesResult> {
  const store = Object.fromEntries(
    listSessionEntries({ agentId: params.agentId, storePath: params.storePath }).map(
      ({ sessionKey, entry }) => [sessionKey, entry],
    ),
  );
  const targetKeys = normalizeTargetStoreKeys(params.target);
  const freshest = resolveFreshestTargetEntry(store, targetKeys);
  const patch = params.update ? await params.update(cloneOptionalEntry(freshest?.entry)) : null;
  const entry = patch
    ? ({
        ...freshest?.entry,
        ...patch,
      } as SessionEntry)
    : cloneOptionalEntry(freshest?.entry);
  await applySessionEntryLifecycleMutation({
    agentId: params.agentId,
    storePath: params.storePath,
    removals: targetKeys
      .filter((key) => key !== params.target.canonicalKey)
      .map((sessionKey) => ({ sessionKey })),
    upserts: entry ? [{ sessionKey: params.target.canonicalKey, entry }] : undefined,
    skipMaintenance: true,
  });
  return {
    canonicalKey: params.target.canonicalKey,
    ...(entry ? { entry: cloneOptionalEntry(entry) } : {}),
  };
}

// Normalizes caller-supplied alias sets while always preserving the canonical key.
function normalizeTargetStoreKeys(target: SessionLifecycleStoreTarget): string[] {
  const keys = new Set<string>();
  const remember = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      keys.add(trimmed);
    }
  };
  remember(target.canonicalKey);
  for (const key of target.storeKeys) {
    remember(key);
  }
  return [...keys];
}

// Selects the row that current JSON-store alias migration would promote.
function resolveFreshestTargetEntry(
  store: Record<string, SessionEntry>,
  targetKeys: readonly string[],
): { key: string; entry: SessionEntry } | undefined {
  let freshest: { key: string; entry: SessionEntry } | undefined;
  for (const key of targetKeys) {
    const entry = store[key];
    if (!entry) {
      continue;
    }
    if (!freshest || (entry.updatedAt ?? 0) > (freshest.entry.updatedAt ?? 0)) {
      freshest = { key, entry };
    }
  }
  return freshest;
}

function cloneOptionalEntry(entry: SessionEntry | undefined): SessionEntry | undefined {
  return entry ? structuredClone(entry) : undefined;
}

/**
 * Creates or updates one session entry and initializes its transcript header as
 * one storage-sized lifecycle operation. File-backed storage still writes JSON
 * plus JSONL, but callers no longer compose entry write, header creation,
 * rollback, and normalized sessionFile persistence themselves.
 */
export async function createSessionEntryWithTranscript<TError = string>(
  scope: SessionAccessScope,
  createEntry: (
    context: SessionEntryCreateWithTranscriptContext,
  ) =>
    | Promise<SessionEntryCreateWithTranscriptPrepareResult<TError>>
    | SessionEntryCreateWithTranscriptPrepareResult<TError>,
): Promise<SessionEntryCreateWithTranscriptResult<TError>> {
  const storePath = resolveAccessStorePath(scope);
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  const store = Object.fromEntries(
    listSessionEntries({ agentId, storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
  const resolved = resolveSessionStoreEntry({ store, sessionKey: scope.sessionKey });
  const created = await createEntry({
    existingEntry: resolved.existing ? { ...resolved.existing } : undefined,
    sessionEntries: cloneSessionEntries(store),
  });
  if (!created.ok) {
    return { ok: false, error: created.error, phase: "entry" };
  }

  const sessionFile = formatSqliteSessionFileMarker({
    agentId,
    sessionId: created.entry.sessionId,
    storePath,
  });
  try {
    await appendSqliteTranscriptEvent(
      {
        agentId,
        sessionId: created.entry.sessionId,
        sessionKey: resolved.normalizedKey,
        storePath,
      },
      createSessionTranscriptHeader({ sessionId: created.entry.sessionId }),
    );
  } catch (err) {
    return {
      ok: false,
      error: formatErrorMessage(err),
      phase: "transcript",
    };
  }

  const entry =
    created.entry.sessionFile === sessionFile
      ? created.entry
      : {
          ...created.entry,
          sessionFile,
        };
  await applySessionEntryLifecycleMutation({
    agentId,
    storePath,
    removals: resolved.legacyKeys.map((sessionKey) => ({ sessionKey })),
    upserts: [{ sessionKey: resolved.normalizedKey, entry }],
    skipMaintenance: true,
  });
  return { ok: true, entry, sessionFile };
}

function cloneSessionEntries(store: Record<string, SessionEntry>): Record<string, SessionEntry> {
  return Object.fromEntries(
    Object.entries(store).map(([sessionKey, entry]) => [sessionKey, { ...entry }]),
  );
}

function createReplySessionInitializationRevision(params: {
  entry: SessionEntry | undefined;
  storePath: string;
}): string {
  const { entry, storePath } = params;
  // Snapshot reads may see promptRef-only disk entries while commit reads can
  // see hydrated prompt text and runtime-only resolvedSkills cache entries.
  // Compare the canonical persisted shape so cache hydration is not a conflict.
  return JSON.stringify(
    entry ? projectSessionEntryForPersistenceRevision({ storePath, entry }) : null,
  );
}

function resolveInitializedReplySessionEntry(params: {
  agentId: string;
  currentEntry?: SessionEntry;
  sessionEntry: SessionEntry;
  storePath: string;
}): SessionEntry {
  const sessionFile = formatSqliteSessionFileMarker({
    agentId: params.agentId,
    sessionId: params.sessionEntry.sessionId,
    storePath: params.storePath,
  });
  return {
    ...params.sessionEntry,
    sessionFile,
  };
}

/** Updates an existing entry only; returns null when the session is absent. */
export async function updateSessionEntry(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SessionEntryUpdateOptions = {},
): Promise<SessionEntry | null> {
  return await updateSqliteSessionEntry(scope, update, options);
}

/** Resolves one abort target identity without exposing the mutable store. */
export function resolveSessionAbortTarget(
  scope: SessionAccessScope,
): SessionAbortTargetIdentity | null {
  const entry = loadSessionEntry(scope);
  if (!entry) {
    return null;
  }
  return {
    entry: { ...entry },
    sessionId: entry.sessionId,
    sessionKey: normalizeStoreSessionKey(scope.sessionKey),
  };
}

/**
 * Resolves, marks, touches, and canonicalizes one abort target entry as a
 * storage-sized operation. Runtime abort side effects remain with callers.
 */
export async function markSessionAbortTarget(params: {
  resolveAbortCutoff?: (context: SessionAbortTargetContext) => SessionAbortTargetCutoff | undefined;
  scope: SessionAccessScope;
  now?: () => number;
}): Promise<SessionAbortTargetResult | null> {
  let resolvedTarget: SessionAbortTargetResult | null = null;
  try {
    const sessionKey = normalizeStoreSessionKey(params.scope.sessionKey);
    const updated = await patchSessionEntry(
      params.scope,
      (currentEntry) => {
        resolvedTarget = {
          entry: { ...currentEntry },
          persisted: false,
          sessionId: currentEntry.sessionId,
          sessionKey,
        };
        const entry = {
          ...currentEntry,
          abortedLastRun: true,
          updatedAt: params.now?.() ?? Date.now(),
        };
        applySessionAbortCutoff(
          entry,
          params.resolveAbortCutoff?.({
            entry: { ...currentEntry },
            sessionKey,
          }),
        );
        return entry;
      },
      {
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
    return updated
      ? {
          entry: { ...updated },
          persisted: true,
          sessionId: updated.sessionId,
          sessionKey,
        }
      : null;
  } catch (error) {
    const fallbackTarget = resolvedTarget as unknown as SessionAbortTargetResult | null;
    if (fallbackTarget) {
      return {
        entry: fallbackTarget.entry,
        persisted: fallbackTarget.persisted,
        sessionId: fallbackTarget.sessionId,
        sessionKey: fallbackTarget.sessionKey,
        persistenceError: formatErrorMessage(error),
      };
    }
    throw error;
  }
}

function applySessionAbortCutoff(
  entry: Pick<SessionEntry, "abortCutoffMessageSid" | "abortCutoffTimestamp">,
  cutoff: SessionAbortTargetCutoff | undefined,
): void {
  entry.abortCutoffMessageSid = cutoff?.messageSid;
  entry.abortCutoffTimestamp = cutoff?.timestamp;
}

function findSessionCompactionCheckpoint(params: {
  checkpointId: string;
  entry: SessionEntry;
}): SessionCompactionCheckpoint | undefined {
  const checkpointId = params.checkpointId.trim();
  if (!checkpointId || !Array.isArray(params.entry.compactionCheckpoints)) {
    return undefined;
  }
  let newest: SessionCompactionCheckpoint | undefined;
  for (const checkpoint of params.entry.compactionCheckpoints) {
    if (checkpoint.checkpointId !== checkpointId) {
      continue;
    }
    if (!newest || checkpoint.createdAt > newest.createdAt) {
      newest = checkpoint;
    }
  }
  return newest;
}

type ApplySessionCompactionCheckpointMutationParams = {
  buildEntry: SessionCompactionCheckpointEntryBuilder;
  checkpointId: string;
  forkTranscriptFromCheckpoint: SessionCompactionCheckpointTranscriptForker;
  readKey: string;
  storePath: string;
  writeKey: string;
};

async function applySessionCompactionCheckpointMutation(
  params: ApplySessionCompactionCheckpointMutationParams,
): Promise<SessionCompactionCheckpointMutationResult> {
  const currentEntry = loadSessionEntry({
    sessionKey: params.readKey,
    storePath: params.storePath,
  });
  if (!currentEntry?.sessionId) {
    return { status: "missing-session" };
  }
  const checkpoint = findSessionCompactionCheckpoint({
    entry: currentEntry,
    checkpointId: params.checkpointId,
  });
  if (!checkpoint) {
    return { status: "missing-checkpoint" };
  }
  const forkedSession = await params.forkTranscriptFromCheckpoint(checkpoint);
  if (forkedSession.status !== "created") {
    return forkedSession;
  }

  const nextEntry = await params.buildEntry({
    checkpoint,
    currentEntry,
    forkedTranscript: forkedSession.transcript,
  });
  await replaceSessionEntry(
    { sessionKey: params.writeKey, storePath: params.storePath },
    nextEntry,
  );
  return {
    status: "created",
    key: params.writeKey,
    checkpoint,
    entry: nextEntry,
  };
}

/**
 * Forks checkpoint transcript content and persists a new branch entry in one
 * storage-sized mutation. SQLite adapters implement the transcript row copy
 * and `session_entries.entry_json` insert inside the same write transaction.
 */
export async function branchSessionFromCompactionCheckpoint(
  params: BranchSessionFromCompactionCheckpointParams,
): Promise<SessionCompactionCheckpointMutationResult> {
  return await applySessionCompactionCheckpointMutation({
    buildEntry: params.buildEntry,
    checkpointId: params.checkpointId,
    forkTranscriptFromCheckpoint: params.forkTranscriptFromCheckpoint,
    readKey: params.sourceStoreKey ?? params.sourceKey,
    storePath: params.storePath,
    writeKey: params.nextKey,
  });
}

/**
 * Forks checkpoint transcript content and replaces the current entry in one
 * storage-sized mutation. SQLite adapters implement the transcript row copy
 * and `session_entries.entry_json` update inside the same write transaction.
 */
export async function restoreSessionFromCompactionCheckpoint(
  params: RestoreSessionFromCompactionCheckpointParams,
): Promise<SessionCompactionCheckpointMutationResult> {
  return await applySessionCompactionCheckpointMutation({
    buildEntry: params.buildEntry,
    checkpointId: params.checkpointId,
    forkTranscriptFromCheckpoint: params.forkTranscriptFromCheckpoint,
    readKey: params.sessionStoreKey ?? params.sessionKey,
    storePath: params.storePath,
    writeKey: params.sessionKey,
  });
}

/**
 * Applies a session patch projection through the accessor boundary.
 * The resolver sees a read-only snapshot and names the persisted key set; the
 * projector returns one replacement entry without receiving the mutable store.
 */
export async function applySessionPatchProjection<
  TFailure extends SessionPatchProjectionFailure,
>(params: {
  agentId?: string;
  storePath: string;
  resolveTarget: (snapshot: SessionPatchProjectionSnapshot) => SessionPatchProjectionTarget;
  project: (
    context: SessionPatchProjectionContext,
  ) => Promise<SessionPatchProjectionResult<TFailure>> | SessionPatchProjectionResult<TFailure>;
}): Promise<SessionPatchProjectionResult<TFailure>> {
  const entries = listSessionEntries({ agentId: params.agentId, storePath: params.storePath }).map(
    ({ sessionKey, entry }) => ({
      entry: structuredClone(entry),
      sessionKey,
    }),
  );
  const target = params.resolveTarget({ entries });
  const existingEntry = resolveProjectionExistingEntry(entries, target);
  const projected = await params.project({
    ...target,
    entries,
    ...(existingEntry ? { existingEntry } : {}),
  });
  if (!projected.ok) {
    return projected;
  }
  const candidateKeys = uniqueStrings(
    (target.candidateKeys ?? [target.primaryKey]).map((key) => key.trim()).filter(Boolean),
  );
  await applySessionEntryLifecycleMutation({
    agentId: params.agentId,
    storePath: params.storePath,
    removals: candidateKeys
      .filter((sessionKey) => sessionKey !== target.primaryKey)
      .map((sessionKey) => ({ sessionKey })),
    upserts: [{ sessionKey: target.primaryKey, entry: projected.entry }],
    skipMaintenance: true,
  });
  return { ...projected, entry: structuredClone(projected.entry) };
}

function resolveProjectionExistingEntry(
  entries: readonly { sessionKey: string; entry: SessionEntry }[],
  target: SessionPatchProjectionTarget,
): SessionEntry | undefined {
  const candidateKeys = target.candidateKeys ?? [target.primaryKey];
  let freshest: SessionEntry | undefined;
  for (const candidateKey of candidateKeys) {
    const entry = entries.find((candidate) => candidate.sessionKey === candidateKey)?.entry;
    if (!entry) {
      continue;
    }
    if (!freshest || (entry.updatedAt ?? 0) > (freshest.updatedAt ?? 0)) {
      freshest = entry;
    }
  }
  return freshest ? structuredClone(freshest) : undefined;
}

/**
 * Applies restart-recovery lifecycle replacements without exposing the backing
 * store shape. The file backend runs selection and replacement under one writer
 * lock; the SQLite backend can map the same callback to a transaction.
 */
export async function applyRestartRecoveryLifecycle<T>(params: {
  storePath: string;
  update: (
    entries: RestartRecoveryLifecycleEntry[],
  ) => Promise<RestartRecoveryLifecycleUpdate<T>> | RestartRecoveryLifecycleUpdate<T>;
  requireWriteSuccess?: boolean;
  skipMaintenance?: boolean;
}): Promise<T> {
  const entries = listSessionEntries({ storePath: params.storePath }).map(
    ({ sessionKey, entry }) => ({
      sessionKey,
      entry: structuredClone(entry),
    }),
  );
  const operation = await params.update(entries);
  const replacements = [...(operation.replacements ?? [])];
  let changed = false;
  for (const replacement of replacements) {
    if (!entries.some((entry) => entry.sessionKey === replacement.sessionKey)) {
      continue;
    }
    await patchSessionEntry(
      { sessionKey: replacement.sessionKey, storePath: params.storePath },
      () => replacement.entry,
      {
        replaceEntry: true,
        skipMaintenance: params.skipMaintenance ?? true,
      },
    );
    changed = true;
  }
  if (params.requireWriteSuccess && replacements.length > 0 && !changed) {
    throw new Error("restart recovery lifecycle did not persist any replacements");
  }
  return operation.result;
}

/**
 * Runs an operation while preserving one temporary session mapping.
 * The storage backend snapshots exactly the named key before the operation and
 * restores that entry, or deletes it when it did not previously exist, after
 * the operation finishes. SQLite backends can implement the same named
 * preservation lifecycle without exposing mutable store access to callers.
 */
export async function preserveTemporarySessionMapping<T>(
  scope: SessionAccessScope,
  operation: () => Promise<T> | T,
): Promise<TemporarySessionMappingPreservationResult<T>> {
  const snapshot = snapshotTemporarySessionMapping(scope);
  let operationResult: TemporarySessionMappingOperationResult<T>;
  try {
    operationResult = { ok: true, result: await operation() };
  } catch (err) {
    operationResult = { error: err, ok: false };
  }

  const restoreFailure = await restoreTemporarySessionMapping(snapshot);
  if (!operationResult.ok) {
    throw operationResult.error;
  }

  return {
    result: operationResult.result,
    ...(snapshot.canRestore ? {} : { snapshotFailure: snapshot.snapshotFailure }),
    ...(restoreFailure ? { restoreFailure } : {}),
  };
}

/** Removes entries and orphan transcript artifacts owned by a named session lifecycle. */
export async function cleanupSessionLifecycleArtifacts(
  params: SessionLifecycleArtifactCleanupParams,
): Promise<SessionLifecycleArtifactCleanupResult> {
  return await cleanupSqliteSessionLifecycleArtifacts(params);
}

/** Resets one persisted session entry and transitions its transcript state. */
export async function resetSessionEntryLifecycle(
  params: ResetSessionEntryLifecycleParams,
): Promise<ResetSessionEntryLifecycleResult> {
  return await resetSqliteSessionEntryLifecycle(params);
}

/** Deletes one persisted session entry and transitions its transcript state. */
export async function deleteSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams,
): Promise<DeleteSessionEntryLifecycleResult> {
  return await deleteSqliteSessionEntryLifecycle(params);
}

/** Applies exact entry lifecycle mutations and artifact cleanup at the storage boundary. */
export async function applySessionEntryLifecycleMutation(params: {
  agentId?: string;
  storePath: string;
  removals?: Iterable<SessionEntryLifecycleRemoval>;
  upserts?: Iterable<SessionEntryLifecycleUpsert>;
  activeSessionKey?: string;
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
  skipMaintenance?: boolean;
  archiveReason?: "deleted" | "reset";
  restrictArchivedTranscriptsToStoreDir?: boolean;
  cleanupArchivedTranscripts?: {
    rules: SessionArchivedTranscriptCleanupRule[];
    nowMs?: number;
  };
  pruneUnreferencedArtifacts?: {
    olderThanMs: number;
    dryRun?: boolean;
  };
  captureArtifactCleanupError?: boolean;
}): Promise<SessionEntryLifecycleMutationResult> {
  return await applySqliteSessionEntryLifecycleMutation(params);
}

/** Purges session entries owned by a deleted agent at the storage boundary. */
export async function purgeDeletedAgentSessionEntries(
  params: DeletedAgentSessionEntryPurgeParams,
): Promise<SessionEntryLifecycleMutationResult> {
  return await purgeSqliteDeletedAgentSessionEntries(params);
}

/**
 * Clears plugin host-owned state inside one resolved session store.
 * This is an internal transaction-sized boundary for the storage backend, not
 * a Plugin SDK API.
 */
export async function cleanupPluginHostSessionStore(
  params: PluginHostSessionCleanupStoreParams,
): Promise<number> {
  if (
    shouldSkipPluginHostCleanupStore(params) ||
    (params.shouldCleanup && !params.shouldCleanup())
  ) {
    return 0;
  }
  const now = Date.now();
  let cleared = 0;
  for (const { entry, sessionKey } of listSessionEntries({
    agentId: params.agentId,
    storePath: params.storePath,
  })) {
    if (
      !matchesPluginHostCleanupSession(sessionKey, entry, params.sessionKey) ||
      !hasPluginHostCleanupTarget(entry, params)
    ) {
      continue;
    }
    const updated = await patchSessionEntry(
      { agentId: params.agentId, sessionKey, storePath: params.storePath },
      (currentEntry) => {
        if (!hasPluginHostCleanupTarget(currentEntry, params)) {
          return null;
        }
        clearPluginHostCleanupTarget(currentEntry, params);
        currentEntry.updatedAt = now;
        return currentEntry;
      },
      {
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
    if (updated) {
      cleared += 1;
    }
  }
  return cleared;
}

/**
 * Persists a runner-driven reset rotation together with transcript replay and
 * optional cleanup. File storage performs these steps sequentially; database
 * backends implement this operation as one lifecycle transaction.
 */
export async function persistSessionResetLifecycle(params: {
  agentId?: string;
  cleanupPreviousTranscript?: boolean;
  nextEntry: SessionEntry;
  nextSessionFile: string;
  previousEntry: SessionEntry;
  previousSessionId?: string;
  sessionKey: string;
  storePath: string;
}): Promise<{ replayedMessages: number }> {
  let persistError: Error | undefined;
  try {
    await replaceSessionEntry(
      { sessionKey: params.sessionKey, storePath: params.storePath },
      params.nextEntry,
    );
  } catch (err) {
    persistError = err instanceof Error ? err : new Error(String(err));
  }

  const replayedMessages = await replayRecentUserAssistantMessages({
    sourceTranscript: params.previousEntry.sessionFile,
    targetTranscript: params.nextSessionFile,
    newSessionId: params.nextEntry.sessionId,
  });

  if (params.cleanupPreviousTranscript && params.previousSessionId) {
    await archivePreviousSessionTranscript({
      agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
      previousEntry:
        params.previousEntry.sessionId === params.previousSessionId
          ? params.previousEntry
          : { ...params.previousEntry, sessionId: params.previousSessionId },
      storePath: params.storePath,
    });
  }

  if (persistError) {
    throw persistError;
  }
  return { replayedMessages };
}

/**
 * Persists a reply session rollover and returns stable previous-transcript
 * data for lifecycle hooks. Non-storage runtime cleanup remains with callers.
 */
export async function persistSessionRolloverLifecycle(params: {
  activeSessionKey: string;
  agentId: string;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  onArchiveError?: (error: unknown, sourcePath: string) => void;
  onMaintenanceWarning?: (warning: SessionMaintenanceWarning) => void | Promise<void>;
  previousEntry?: SessionEntry;
  retiredEntry?: SessionEntryRetirement;
  sessionEntry: SessionEntry;
  sessionKey: string;
  storePath: string;
}): Promise<SessionLifecycleRolloverResult> {
  const upserts: SessionEntryLifecycleUpsert[] = [
    {
      sessionKey: params.sessionKey,
      buildEntry: ({ currentEntry }) => ({
        ...currentEntry,
        ...params.sessionEntry,
      }),
    },
  ];
  if (params.retiredEntry) {
    upserts.push({
      sessionKey: params.retiredEntry.key,
      entry: params.retiredEntry.entry,
    });
  }
  await applySessionEntryLifecycleMutation({
    activeSessionKey: params.activeSessionKey,
    maintenanceOverride: params.maintenanceConfig,
    storePath: params.storePath,
    upserts,
  });

  const previousSessionTranscript = await archivePreviousSessionTranscript({
    agentId: params.agentId,
    onArchiveError: params.onArchiveError,
    previousEntry: params.previousEntry,
    storePath: params.storePath,
  });

  return {
    previousSessionTranscript,
    sessionEntry: params.sessionEntry,
  };
}

/** Loads the reply-session initialization rows without exposing a mutable store. */
export function loadReplySessionInitializationSnapshot(params: {
  storePath: string;
  sessionKey: string;
}): ReplySessionInitializationSnapshot {
  const store = Object.fromEntries(
    listSessionEntries({ storePath: params.storePath }).map(({ sessionKey, entry }) => [
      sessionKey,
      entry,
    ]),
  );
  const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
  const currentEntry = resolved.existing ? { ...resolved.existing } : undefined;
  const entries = cloneSessionEntries(store);
  return {
    ...(currentEntry ? { currentEntry } : {}),
    readEntry: (sessionKey) => {
      const entry = resolveSessionStoreEntry({ store: entries, sessionKey }).existing;
      return entry ? { ...entry } : undefined;
    },
    revision: createReplySessionInitializationRevision({
      entry: currentEntry,
      storePath: params.storePath,
    }),
  };
}

/**
 * Persists one reply-session initialization result and archives the previous
 * transcript after metadata commits. SQLite adapters map the guarded write to a
 * transaction and keep archive failure warning-only, matching file storage.
 */
export async function commitReplySessionInitialization(params: {
  activeSessionKey: string;
  agentId: string;
  expectedRevision: string;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  onArchiveError?: (error: unknown, sourcePath: string) => void;
  onMaintenanceWarning?: (warning: SessionMaintenanceWarning) => void | Promise<void>;
  prepareSessionEntry?: (
    context: ReplySessionInitializationCommitContext,
  ) => Promise<SessionEntry> | SessionEntry;
  previousEntry?: SessionEntry;
  retiredEntry?: SessionEntryRetirement;
  sessionEntry: SessionEntry;
  sessionKey: string;
  storePath: string;
}): Promise<ReplySessionInitializationCommitResult> {
  const store = Object.fromEntries(
    listSessionEntries({ storePath: params.storePath }).map(({ sessionKey, entry }) => [
      sessionKey,
      entry,
    ]),
  );
  const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
  const currentEntry = resolved.existing ? { ...resolved.existing } : undefined;
  const revision = createReplySessionInitializationRevision({
    entry: currentEntry,
    storePath: params.storePath,
  });
  if (revision !== params.expectedRevision) {
    return {
      ok: false,
      ...(currentEntry ? { currentEntry } : {}),
      reason: "stale-snapshot",
      revision,
    };
  }

  const readEntry = (sessionKey: string) => {
    const entry = resolveSessionStoreEntry({ store, sessionKey }).existing;
    return entry ? { ...entry } : undefined;
  };
  const preparedSessionEntry = params.prepareSessionEntry
    ? await params.prepareSessionEntry({
        ...(currentEntry ? { currentEntry } : {}),
        readEntry,
        sessionEntry: params.sessionEntry,
      })
    : params.sessionEntry;
  const sessionEntry = resolveInitializedReplySessionEntry({
    agentId: params.agentId,
    ...(currentEntry ? { currentEntry } : {}),
    sessionEntry: preparedSessionEntry,
    storePath: params.storePath,
  });
  let staleCommit:
    | {
        currentEntry?: SessionEntry;
        revision: string;
      }
    | undefined;
  const upserts: SessionEntryLifecycleUpsert[] = [
    {
      sessionKey: resolved.normalizedKey,
      buildEntry: ({ store: currentStore }) => {
        const commitResolved = resolveSessionStoreEntry({
          store: currentStore,
          sessionKey: params.sessionKey,
        });
        const commitEntry = commitResolved.existing;
        const commitRevision = createReplySessionInitializationRevision(commitEntry);
        if (commitRevision !== params.expectedRevision) {
          staleCommit = {
            ...(commitEntry ? { currentEntry: { ...commitEntry } } : {}),
            revision: commitRevision,
          };
          return null;
        }
        return sessionEntry;
      },
    },
  ];
  if (params.retiredEntry) {
    const retiredEntry = params.retiredEntry;
    upserts.push({
      sessionKey: retiredEntry.key,
      buildEntry: () => (staleCommit ? null : retiredEntry.entry),
    });
  }
  await applySessionEntryLifecycleMutation({
    activeSessionKey: params.activeSessionKey,
    maintenanceOverride: params.maintenanceConfig,
    storePath: params.storePath,
    upserts,
  });
  if (staleCommit) {
    return {
      ok: false,
      ...(staleCommit.currentEntry ? { currentEntry: staleCommit.currentEntry } : {}),
      reason: "stale-snapshot",
      revision: staleCommit.revision,
    };
  }
  store[resolved.normalizedKey] = sessionEntry;
  if (params.retiredEntry) {
    store[params.retiredEntry.key] = params.retiredEntry.entry;
  }
  const committed: ReplySessionInitializationCommitResult = {
    ok: true,
    previousSessionTranscript: {},
    sessionEntry: { ...sessionEntry },
    sessionStoreView: cloneSessionEntries(store),
  };

  const previousSessionTranscript = await archivePreviousSessionTranscript({
    agentId: params.agentId,
    onArchiveError: params.onArchiveError,
    previousEntry: params.previousEntry,
    storePath: params.storePath,
  });
  return {
    ...committed,
    previousSessionTranscript,
  };
}

/**
 * Appends a non-message transcript record such as session or metadata events.
 * Message records must use appendTranscriptMessage so parent links, idempotency,
 * and redaction are preserved.
 */
export async function appendTranscriptEvent(
  scope: SessionTranscriptAccessScope,
  event: TranscriptEvent,
): Promise<void> {
  await appendSqliteTranscriptEvent(scope, event);
}

/** Appends a non-message transcript record synchronously for sync session runtimes. */
export function appendTranscriptEventSync(
  scope: SessionTranscriptAccessScope,
  event: TranscriptEvent,
): void {
  appendSqliteTranscriptEventSync(scope, event);
}

/** Reads parsed transcript records from an explicit or derived transcript target. */
export async function loadTranscriptEvents(
  scope: SessionTranscriptReadScope,
): Promise<TranscriptEvent[]> {
  return await loadSqliteTranscriptEvents(scope);
}

/** Replaces all transcript records for one SQLite-backed transcript. */
export async function replaceTranscriptEvents(
  scope: SessionTranscriptAccessScope,
  events: TranscriptEvent[],
): Promise<void> {
  await replaceSqliteTranscriptEvents(scope, events);
}

/** Replaces all transcript records synchronously for sync session runtimes. */
export function replaceTranscriptEventsSync(
  scope: SessionTranscriptAccessScope,
  events: TranscriptEvent[],
): boolean {
  return replaceSqliteTranscriptEventsSync(scope, events);
}

/** Reads parsed transcript records synchronously from the SQLite transcript store. */
export function loadTranscriptEventsSync(scope: SessionTranscriptReadScope): TranscriptEvent[] {
  return loadSqliteTranscriptEventsSync(scope);
}

/** Reads the latest visible assistant text without materializing the whole transcript. */
export function readLatestTranscriptAssistantText(
  scope: SessionTranscriptReadScope,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptAssistantText | undefined {
  return loadLatestSqliteAssistantText(scope, options);
}

/** Reads the latest assistant message payload without materializing the whole transcript. */
export function readLatestTranscriptAssistantMessage(
  scope: SessionTranscriptReadScope,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptAssistantMessage | undefined {
  return loadLatestSqliteAssistantMessage(scope, options);
}

/** Reads the latest transcript message payload without materializing the whole transcript. */
export function readLatestTranscriptMessage(
  scope: SessionTranscriptReadScope,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptMessage | undefined {
  return loadLatestSqliteMessage(scope, options);
}

/**
 * Appends one transcript message with message-id generation and optional
 * idempotency lookup. The returned message is the redacted persisted value.
 */
export async function appendTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage> & {
    prepareMessageAfterIdempotencyCheck: (message: TMessage) => TMessage | undefined;
  },
): Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
export async function appendTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage>>;
export async function appendTranscriptMessage<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage> | undefined> {
  return await appendSqliteTranscriptMessage(scope, options);
}

/** Appends one transcript message synchronously for sync session runtimes. */
export function appendTranscriptMessageSync<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): TranscriptMessageAppendResult<TMessage> | undefined {
  return appendSqliteTranscriptMessageSync(scope, options);
}

/** Resolves the persisted key for a SQLite transcript session id. */
export function resolveTranscriptSessionKeyBySessionId(
  scope: Pick<SessionTranscriptReadScope, "agentId" | "env" | "sessionId" | "storePath">,
): string | undefined {
  return resolveSqliteSessionKeyBySessionId(scope);
}

/** Emits a transcript update after resolving the current transcript target. */
export async function publishTranscriptUpdate(
  scope: SessionTranscriptWriteScope,
  update: TranscriptUpdatePayload = {},
): Promise<void> {
  await publishSqliteTranscriptUpdate(scope, update);
}

/** Runs transcript read/append work under the backing store writer lock. */
export async function withTranscriptWriteLock<T>(
  scope: SessionTranscriptWriteScope,
  run: (context: SessionTranscriptWriteLockAccessorContext) => Promise<T> | T,
): Promise<T> {
  return await withSqliteTranscriptWriteLock(scope, run);
}

/**
 * Trims a transcript for manual sessions.compact and clears stale token metadata.
 * This is one storage-sized mutation: future stores can trim transcript rows and
 * update entry metadata inside the same backend transaction.
 */
export async function preflightSessionTranscriptForManualCompact(
  scope: SessionTranscriptRuntimeScope,
  params: { maxLines: number; sessionFile?: string },
): Promise<SessionTranscriptManualTrimPreflightResult> {
  const events = await loadTranscriptEvents(scope).catch(() => []);
  if (events.length === 0) {
    return { compacted: false, reason: "no transcript" };
  }

  const maxLines = Math.max(1, Math.floor(params.maxLines));
  return events.length > maxLines ? { compacted: true } : { compacted: false, kept: events.length };
}

export async function trimSessionTranscriptForManualCompact(
  scope: SessionTranscriptRuntimeScope,
  params: { maxLines: number; nowMs?: number; sessionFile?: string },
): Promise<SessionTranscriptManualTrimResult> {
  const events = await loadTranscriptEvents(scope).catch(() => []);
  if (events.length === 0) {
    return { compacted: false, reason: "no transcript" };
  }

  const maxLines = Math.max(1, Math.floor(params.maxLines));
  const headerLine = JSON.stringify(events[0]);
  const tailLines = events.slice(1).map((event) => JSON.stringify(event));
  const maxTailLines = Math.max(0, maxLines - 1);
  if (events.length <= maxLines) {
    return { compacted: false, kept: events.length };
  }

  const lines = normalizeManualCompactTranscriptLines(
    headerLine,
    maxTailLines > 0 ? tailLines.slice(-maxTailLines) : [],
  );
  if (!lines) {
    return { compacted: false, kept: 0 };
  }
  const retainedEvents = lines.map((line) => JSON.parse(line) as TranscriptEvent);
  await replaceSqliteTranscriptEvents(scope, retainedEvents);
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve manual compact transcript scope: ${scope.sessionKey}`);
  }
  const archived = `${formatSqliteSessionFileMarker({
    agentId,
    sessionId: scope.sessionId,
    storePath: scope.storePath ?? "",
  })}.bak.${formatSessionArchiveTimestamp()}`;
  await patchSessionEntry(
    {
      ...scope,
      sessionKey: scope.sessionKey,
      storePath: scope.storePath,
    },
    (entry) => {
      delete entry.contextBudgetStatus;
      delete entry.inputTokens;
      delete entry.outputTokens;
      delete entry.totalTokens;
      delete entry.totalTokensFresh;
      entry.updatedAt = params.nowMs ?? Date.now();
      return entry;
    },
    { replaceEntry: true },
  );

  return { archived, compacted: true, kept: lines.length };
}

function parseManualCompactTranscriptRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeManualCompactTranscriptLines(
  headerLine: string | undefined,
  tailLines: readonly string[],
): string[] | null {
  if (!headerLine) {
    return null;
  }
  const header = parseManualCompactTranscriptRecord(headerLine);
  if (header?.type !== "session" || typeof header.id !== "string") {
    return null;
  }

  const records = tailLines
    .map(parseManualCompactTranscriptRecord)
    .filter((record): record is Record<string, unknown> => record !== null);
  const retainedIds = new Set<string>();
  const transparentParents = new Map<string, string | null>();
  const normalizedRecords: Record<string, unknown>[] = [];
  for (const record of records) {
    let parentId = record.parentId;
    const seenTransparentParents = new Set<string>();
    while (
      typeof parentId === "string" &&
      transparentParents.has(parentId) &&
      !seenTransparentParents.has(parentId)
    ) {
      seenTransparentParents.add(parentId);
      parentId = transparentParents.get(parentId) ?? null;
    }
    let next =
      typeof parentId === "string" && !retainedIds.has(parentId)
        ? { ...record, parentId: null }
        : parentId !== record.parentId
          ? { ...record, parentId }
          : record;
    if (next.type === "leaf") {
      const targetId = next.targetId;
      const validTargetId =
        targetId === null || (typeof targetId === "string" && targetId.trim().length > 0);
      if (!validTargetId && typeof next.id === "string") {
        transparentParents.set(
          next.id,
          next.parentId === null || typeof next.parentId === "string" ? next.parentId : null,
        );
      }
      if (typeof targetId === "string" && targetId.trim() && !retainedIds.has(targetId)) {
        // The selected branch fell outside the retained window. Select an
        // empty root instead of accidentally activating abandoned or side rows.
        next = { ...next, targetId: null, appendParentId: null };
      } else if (
        validTargetId &&
        typeof next.appendParentId === "string" &&
        !retainedIds.has(next.appendParentId)
      ) {
        next = { ...next, appendParentId: targetId };
      }
    }
    if (next.type === "compaction" && typeof next.id === "string") {
      const firstKeptEntryId = next.firstKeptEntryId;
      if (typeof firstKeptEntryId === "string" && firstKeptEntryId !== next.id) {
        const tree = scanSessionTranscriptTree([...normalizedRecords, next]);
        const branchPath = selectSessionTranscriptTreePathNodes(tree, next.id);
        if (!branchPath.some((node) => node.id === firstKeptEntryId)) {
          // Replay starts at the earliest retained entry on this compaction's
          // normalized branch, never at an abandoned row earlier in file order.
          next = { ...next, firstKeptEntryId: branchPath[0]?.id ?? next.id };
        }
      }
    }
    normalizedRecords.push(next);
    if (typeof next.id === "string" && next.id.trim()) {
      retainedIds.add(next.id);
    }
  }
  return [JSON.stringify(header), ...normalizedRecords.map((record) => JSON.stringify(record))];
}

/**
 * Persists one logical transcript turn through the SQLite-backed session target.
 * Transcript row append(s), the synthetic sessionFile marker, and the requested
 * updatedAt touch happen before transcript update delivery is published.
 */
export async function persistSessionTranscriptTurn(
  scope: SessionTranscriptWriteScope & {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
  },
  options: SessionTranscriptTurnPersistOptions,
): Promise<SessionTranscriptTurnPersistResult> {
  const expectedSessionId = options.expectedSessionId;
  if (expectedSessionId) {
    return await persistExpectedSessionTranscriptTurn(scope, { ...options, expectedSessionId });
  }
  const target = await resolveTranscriptTurnTarget(scope);
  const appendedMessages = await runWithOwnedSessionTranscriptWriteLock(
    {
      sessionFile: target.sessionFile,
      sessionKey: target.sessionKey,
    },
    () => appendTranscriptTurnMessages(target, options),
  );
  const appendedCount = countAppendedTranscriptMessages(appendedMessages);
  const sessionEntry = await touchTranscriptTurnSessionEntry({
    scope,
    target,
    shouldTouch: options.touchSessionEntry === true && appendedCount > 0,
  });
  await publishTranscriptTurnUpdate({
    target,
    updateMode: options.updateMode ?? "inline",
    publishWhen: options.publishWhen ?? "when-appended",
    appendedMessages,
  });

  return {
    appendedCount,
    messages: appendedMessages,
    sessionEntry,
    sessionFile: target.sessionFile,
  };
}

async function appendTranscriptTurnMessages(
  target: SessionTranscriptTurnWriteContext,
  options: SessionTranscriptTurnPersistOptions,
): Promise<TranscriptMessageAppendResult<unknown>[]> {
  const selectedMessages = await selectAppendableTranscriptTurnMessages(target, options);
  const appendedMessages: TranscriptMessageAppendResult<unknown>[] = [];
  for (const append of selectedMessages) {
    const { shouldAppend: _shouldAppend, ...appendOptions } = append;
    const result = await appendTranscriptMessage(
      {
        ...(target.agentId ? { agentId: target.agentId } : {}),
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
        ...(target.storePath ? { storePath: target.storePath } : {}),
      },
      {
        ...appendOptions,
        ...((append.cwd ?? options.cwd) ? { cwd: append.cwd ?? options.cwd } : {}),
        ...((append.config ?? options.config) ? { config: append.config ?? options.config } : {}),
      },
    );
    if (result) {
      appendedMessages.push(result);
    }
  }
  return appendedMessages;
}

async function selectAppendableTranscriptTurnMessages(
  target: SessionTranscriptTurnWriteContext,
  options: SessionTranscriptTurnPersistOptions,
): Promise<SessionTranscriptTurnMessageAppend[]> {
  const selectedMessages: SessionTranscriptTurnMessageAppend[] = [];
  for (const append of options.messages) {
    const shouldAppend = append.shouldAppend
      ? await append.shouldAppend({
          ...(target.agentId ? { agentId: target.agentId } : {}),
          sessionFile: target.sessionFile,
          ...(target.sessionId ? { sessionId: target.sessionId } : {}),
          ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
          ...(target.storePath ? { storePath: target.storePath } : {}),
        })
      : true;
    if (!shouldAppend) {
      continue;
    }
    selectedMessages.push(append);
  }
  return selectedMessages;
}

function countAppendedTranscriptMessages(
  messages: readonly TranscriptMessageAppendResult<unknown>[],
): number {
  return messages.filter((message) => message.appended).length;
}

async function persistExpectedSessionTranscriptTurn(
  scope: SessionTranscriptWriteScope & {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
  },
  options: SessionTranscriptTurnPersistOptions & { expectedSessionId: string },
): Promise<SessionTranscriptTurnPersistResult> {
  const sessionKey = scope.sessionKey?.trim();
  if (!scope.storePath || !sessionKey) {
    throw new Error("Cannot guard a transcript turn without a session store and key");
  }
  const storePath = scope.storePath;
  const expectedSessionId = options.expectedSessionId;
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript turn without an agent id: ${sessionKey}`);
  }
  const store =
    scope.sessionStore ??
    Object.fromEntries(
      listSessionEntries({ storePath }).map(({ sessionKey: entryKey, entry }) => [entryKey, entry]),
    );
  const resolved = resolveSessionStoreEntry({ store, sessionKey });
  const sessionFile = formatSqliteSessionFileMarker({
    agentId,
    sessionId: expectedSessionId,
    storePath,
  });
  const target: SessionTranscriptTurnWriteContext = {
    agentId,
    sessionFile,
    sessionId: expectedSessionId,
    sessionKey: resolved.normalizedKey,
    storePath,
  };
  const turn = await runWithOwnedSessionTranscriptWriteLock(
    {
      sessionFile: target.sessionFile,
      sessionKey: target.sessionKey,
    },
    () =>
      appendSqliteExpectedSessionTranscriptTurn(
        {
          sessionKey: resolved.normalizedKey,
          sessionId: expectedSessionId,
          storePath,
        },
        {
          config: options.config,
          cwd: options.cwd,
          expectedSessionId,
          messages: options.messages,
          sessionFile: target.sessionFile,
          touchSessionEntry: options.touchSessionEntry,
        },
      ),
  );

  if (turn.rejectedReason === "session-rebound") {
    return {
      appendedCount: 0,
      messages: [],
      rejectedReason: "session-rebound",
      sessionEntry: turn.sessionEntry,
      sessionFile: turn.sessionFile,
    };
  }

  await publishTranscriptTurnUpdate({
    target,
    updateMode: options.updateMode ?? "inline",
    publishWhen: options.publishWhen ?? "when-appended",
    appendedMessages: turn.appendedMessages,
  });

  if (turn.sessionEntry && scope.sessionStore) {
    scope.sessionStore[resolved.normalizedKey] = turn.sessionEntry;
  }
  return {
    appendedCount: countAppendedTranscriptMessages(turn.appendedMessages),
    messages: turn.appendedMessages,
    sessionEntry: turn.sessionEntry ?? scope.sessionEntry,
    sessionFile: turn.sessionFile,
  };
}

/**
 * Resolves the current storage-neutral runtime transcript target. SQLite-backed
 * rows return their marker so transcript readers/writers stay on the accessor
 * path instead of reopening legacy JSONL artifacts.
 */
export async function resolveSessionTranscriptRuntimeTarget(
  scope: SessionTranscriptRuntimeScope,
): Promise<SessionTranscriptRuntimeTarget> {
  const { agentId, sessionEntry, sessionKey, sessionStore } =
    resolveSessionTranscriptRuntimeContext(scope);
  if (shouldUseExplicitTranscriptFile(scope)) {
    return {
      agentId,
      sessionFile: scope.sessionFile.trim(),
      sessionId: scope.sessionId,
      sessionKey,
    };
  }
  void sessionStore;
  return {
    agentId,
    sessionFile: resolveRuntimeSessionFile(scope, agentId, sessionEntry),
    sessionId: scope.sessionId,
    sessionKey,
  };
}

/**
 * Resolves the runtime transcript target for read/delete probes without
 * persisting missing sessionFile metadata into the session store.
 */
export async function resolveSessionTranscriptRuntimeReadTarget(
  scope: SessionTranscriptRuntimeScope,
): Promise<SessionTranscriptRuntimeTarget> {
  const { agentId, sessionEntry, sessionKey } = resolveSessionTranscriptRuntimeContext(scope);
  if (shouldUseExplicitTranscriptFile(scope)) {
    return {
      agentId,
      sessionFile: scope.sessionFile.trim(),
      sessionId: scope.sessionId,
      sessionKey,
    };
  }
  return {
    agentId,
    sessionFile: resolveRuntimeSessionFile(scope, agentId, sessionEntry),
    sessionId: scope.sessionId,
    sessionKey,
  };
}

function resolveRuntimeSessionFile(
  scope: SessionTranscriptRuntimeScope,
  agentId: string,
  sessionEntry: SessionEntry | undefined,
): string {
  const matchingSessionEntry =
    sessionEntry?.sessionId === undefined || sessionEntry.sessionId === scope.sessionId
      ? sessionEntry
      : undefined;
  if (
    sqliteSessionFileMarkerMatchesSession(matchingSessionEntry?.sessionFile, scope.sessionId) &&
    matchingSessionEntry?.sessionFile
  ) {
    return matchingSessionEntry.sessionFile;
  }
  if (scope.storePath) {
    return formatSqliteSessionFileMarker({
      agentId,
      sessionId: scope.sessionId,
      storePath: scope.storePath,
    });
  }
  return resolveSessionFilePath(
    scope.sessionId,
    matchingSessionEntry,
    resolveSessionFilePathOptions({
      agentId,
      storePath: scope.storePath,
    }),
  );
}

type SessionTranscriptRuntimeContext = {
  agentId: string;
  sessionEntry: SessionEntry | undefined;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry> | undefined;
};

function resolveSessionTranscriptRuntimeContext(
  scope: SessionTranscriptRuntimeScope,
): SessionTranscriptRuntimeContext {
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript scope without an agent id: ${scope.sessionKey}`);
  }
  const sessionStore = scope.storePath
    ? Object.fromEntries(
        listSessionEntries({ agentId, storePath: scope.storePath }).map(({ sessionKey, entry }) => [
          sessionKey,
          entry,
        ]),
      )
    : undefined;
  const resolvedStoreEntry = sessionStore
    ? resolveSessionStoreEntry({ store: sessionStore, sessionKey: scope.sessionKey })
    : undefined;
  const sessionEntry = resolvedStoreEntry?.existing ?? loadSessionEntry(scope);
  const sessionKey = resolvedStoreEntry?.normalizedKey ?? scope.sessionKey;
  return {
    agentId,
    sessionKey,
    sessionStore,
    sessionEntry,
  };
}

/**
 * Resolves the current storage-neutral target for read-only transcript callers.
 * Unlike writer/runtime resolution, this does not persist missing sessionFile
 * metadata; reader projections must not mutate session metadata.
 */
export function resolveSessionTranscriptReadTarget(
  scope: SessionTranscriptReadScope,
): SessionTranscriptReadTarget {
  const explicitSessionFile = scope.sessionFile?.trim();
  if (explicitSessionFile) {
    return {
      sessionFile: explicitSessionFile,
      sessionId: scope.sessionId,
      ...(scope.agentId ? { agentId: scope.agentId } : {}),
      ...(scope.sessionKey ? { sessionKey: scope.sessionKey } : {}),
    };
  }
  const entrySessionFile = scope.sessionEntry?.sessionFile?.trim();
  const entryMarker = parseSqliteSessionFileMarker(entrySessionFile);
  if (entrySessionFile && entryMarker && entryMarker.sessionId === scope.sessionId) {
    return {
      agentId: scope.agentId ?? entryMarker.agentId,
      sessionFile: entrySessionFile,
      sessionId: scope.sessionId,
      ...(scope.sessionKey ? { sessionKey: scope.sessionKey } : {}),
    };
  }
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript scope without an agent id: ${scope.sessionKey}`);
  }
  const storePath = resolveConcreteReadStorePath(scope.storePath);
  if (!storePath) {
    const resolvedStorePath = resolveStorePath(getRuntimeConfig().session?.store, {
      agentId,
      env: scope.env,
    });
    return {
      agentId,
      sessionFile: formatSqliteSessionFileMarker({
        agentId,
        sessionId: scope.sessionId,
        storePath: resolvedStorePath,
      }),
      sessionId: scope.sessionId,
      ...(scope.sessionKey ? { sessionKey: scope.sessionKey } : {}),
    };
  }
  const resolvedStoreEntry =
    scope.sessionEntry || !scope.sessionKey
      ? undefined
      : storePath
        ? resolveSessionStoreEntry({
            store: Object.fromEntries(
              listSessionEntries({ agentId, storePath }).map(({ sessionKey, entry }) => [
                sessionKey,
                entry,
              ]),
            ),
            sessionKey: scope.sessionKey,
          })
        : undefined;
  const sessionKey = resolvedStoreEntry?.normalizedKey ?? scope.sessionKey;
  const sessionFile = formatSqliteSessionFileMarker({
    agentId,
    sessionId: scope.sessionId,
    storePath: storePath ?? "",
  });
  return {
    agentId,
    sessionFile,
    sessionId: scope.sessionId,
    ...(sessionKey ? { sessionKey } : {}),
  };
}

function resolveConcreteReadStorePath(storePath: string | undefined): string | undefined {
  const trimmed = storePath?.trim();
  if (!trimmed || trimmed === "(multiple)" || trimmed.includes("{agentId}")) {
    return undefined;
  }
  return trimmed;
}

function snapshotTemporarySessionMapping(
  scope: SessionAccessScope,
): TemporarySessionMappingSnapshot {
  const storePath = resolveAccessStorePath(scope);
  try {
    const exact = loadExactSessionEntry({
      ...scope,
      storePath,
    });
    return {
      canRestore: true,
      ...(exact ? { entry: structuredClone(exact.entry), hadEntry: true } : { hadEntry: false }),
      sessionKey: scope.sessionKey,
      storePath,
    };
  } catch (err) {
    return {
      canRestore: false,
      sessionKey: scope.sessionKey,
      snapshotFailure: formatErrorMessage(err),
      storePath,
    };
  }
}

async function restoreTemporarySessionMapping(
  snapshot: TemporarySessionMappingSnapshot,
): Promise<string | undefined> {
  if (!snapshot.canRestore) {
    return undefined;
  }
  try {
    if (snapshot.hadEntry) {
      await replaceSessionEntry(
        { sessionKey: snapshot.sessionKey, storePath: snapshot.storePath },
        structuredClone(snapshot.entry),
      );
    } else {
      await applySessionEntryLifecycleMutation({
        storePath: snapshot.storePath,
        removals: [{ sessionKey: snapshot.sessionKey }],
        activeSessionKey: snapshot.sessionKey,
        skipMaintenance: true,
      });
    }
    return undefined;
  } catch (err) {
    return formatErrorMessage(err);
  }
}

async function archivePreviousSessionTranscript(params: {
  agentId: string;
  onArchiveError?: (error: unknown, sourcePath: string) => void;
  previousEntry?: SessionEntry;
  storePath: string;
}): Promise<SessionLifecycleTranscriptInfo> {
  if (!params.previousEntry?.sessionId) {
    return {};
  }
  const { archiveSessionTranscriptsDetailed, resolveStableSessionEndTranscript } =
    await loadSessionArchiveRuntime();
  const archivedTranscripts = archiveSessionTranscriptsDetailed({
    sessionId: params.previousEntry.sessionId,
    storePath: params.storePath,
    sessionFile: params.previousEntry.sessionFile,
    agentId: params.agentId,
    reason: "reset",
    onArchiveError: params.onArchiveError,
  });
  return resolveStableSessionEndTranscript({
    sessionId: params.previousEntry.sessionId,
    storePath: params.storePath,
    sessionFile: params.previousEntry.sessionFile,
    agentId: params.agentId,
    archivedTranscripts,
  });
}

function resolveAccessStorePath(scope: SessionAccessScope): string {
  if (scope.storePath) {
    return scope.storePath;
  }
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  return resolveStorePath(getRuntimeConfig().session?.store, {
    agentId,
    env: scope.env,
  });
}

async function resolveTranscriptTurnTarget(
  scope: SessionTranscriptWriteScope & {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
  },
): Promise<
  SessionTranscriptTurnWriteContext & {
    sessionEntry: SessionEntry | undefined;
  }
> {
  if (shouldUseExplicitTranscriptFile(scope)) {
    const marker = parseSqliteSessionFileMarker(scope.sessionFile);
    const agentId = scope.agentId ?? marker?.agentId;
    const sessionId = scope.sessionId ?? marker?.sessionId;
    const storePath = scope.storePath ?? marker?.storePath;
    return {
      ...(agentId ? { agentId } : {}),
      sessionFile: scope.sessionFile.trim(),
      ...(sessionId ? { sessionId } : {}),
      ...(scope.sessionKey ? { sessionKey: scope.sessionKey } : {}),
      ...(storePath ? { storePath } : {}),
      sessionEntry: scope.sessionEntry,
    };
  }
  const sessionKey = scope.sessionKey?.trim();
  if (!sessionKey || !scope.sessionId) {
    throw new Error(
      "Cannot persist a transcript turn without a session key and session id or explicit session file",
    );
  }
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript turn without an agent id: ${sessionKey}`);
  }
  const storePath =
    scope.storePath ??
    resolveStorePath(getRuntimeConfig().session?.store, {
      agentId,
      env: scope.env,
    });
  const store =
    scope.sessionStore ??
    Object.fromEntries(
      listSessionEntries({
        agentId,
        storePath,
      }).map(({ sessionKey: entryKey, entry }) => [entryKey, entry]),
    );
  const resolved = store ? resolveSessionStoreEntry({ store, sessionKey }) : undefined;
  const sessionEntry =
    resolved?.existing ??
    scope.sessionEntry ??
    loadSessionEntry({ ...scope, agentId, sessionKey, storePath });
  const sessionFile = formatSqliteSessionFileMarker({
    agentId,
    sessionId: scope.sessionId,
    storePath,
  });
  return {
    agentId,
    sessionFile,
    sessionId: scope.sessionId,
    sessionKey: resolved?.normalizedKey ?? sessionKey,
    storePath,
    sessionEntry,
  };
}

function shouldUseExplicitTranscriptFile<
  TScope extends {
    sessionFile?: string;
    sessionId?: string;
    sessionKey?: string;
    storePath?: string;
  },
>(scope: TScope): scope is TScope & { sessionFile: string } {
  const explicitSessionFile = scope.sessionFile?.trim();
  if (!explicitSessionFile) {
    return false;
  }
  const hasStoreIdentity = Boolean(
    scope.storePath?.trim() && scope.sessionKey?.trim() && scope.sessionId?.trim(),
  );
  return !hasStoreIdentity;
}

async function touchTranscriptTurnSessionEntry(params: {
  scope: SessionTranscriptWriteScope & {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
  };
  target: SessionTranscriptTurnWriteContext & {
    sessionEntry: SessionEntry | undefined;
  };
  shouldTouch: boolean;
}): Promise<SessionEntry | undefined> {
  if (
    !params.shouldTouch ||
    !params.target.storePath ||
    !params.target.sessionKey ||
    !params.target.sessionId
  ) {
    return params.target.sessionEntry;
  }
  const markerUpdatedAt = Date.now();
  const updated = await updateSessionEntry(
    {
      sessionKey: params.target.sessionKey,
      storePath: params.target.storePath,
      ...(params.target.agentId ? { agentId: params.target.agentId } : {}),
    },
    (current) =>
      current.sessionId === params.target.sessionId
        ? {
            sessionFile: params.target.sessionFile,
            updatedAt: Math.max(current.updatedAt ?? 0, markerUpdatedAt),
          }
        : null,
    { skipMaintenance: true },
  );
  if (updated && params.scope.sessionStore) {
    params.scope.sessionStore[params.target.sessionKey] = updated;
  }
  return updated ?? params.target.sessionEntry;
}

async function publishTranscriptTurnUpdate(params: {
  target: SessionTranscriptTurnWriteContext;
  updateMode: SessionTranscriptTurnUpdateMode;
  publishWhen: "always" | "when-appended";
  appendedMessages: TranscriptMessageAppendResult<unknown>[];
}): Promise<void> {
  if (params.updateMode === "none") {
    return;
  }
  const lastAppended = params.appendedMessages.findLast((message) => message.appended);
  if (params.publishWhen === "when-appended" && !lastAppended) {
    return;
  }
  const target =
    params.target.agentId && params.target.sessionId && params.target.sessionKey
      ? {
          agentId: params.target.agentId,
          sessionId: params.target.sessionId,
          sessionKey: params.target.sessionKey,
        }
      : undefined;
  emitSessionTranscriptUpdate({
    ...(params.target.sessionKey ? { sessionKey: params.target.sessionKey } : {}),
    ...(params.target.agentId ? { agentId: params.target.agentId } : {}),
    ...(target ? { target } : {}),
    ...(params.updateMode === "inline" && lastAppended
      ? {
          message: lastAppended.message,
          messageId: lastAppended.messageId,
        }
      : {}),
    sessionFile: params.target.sessionFile,
  });
}
