import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireSessionWriteLock,
  resolveSessionWriteLockOptions,
} from "../../agents/session-write-lock.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveRequiredHomeDir } from "../../infra/home-dir.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { SessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { getRuntimeConfig } from "../io.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { formatSessionArchiveTimestamp } from "./artifacts.js";
import { extractGeneratedTranscriptSessionId } from "./generated-transcript-session-id.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
  resolveSessionTranscriptPathInDir,
  resolveStorePath,
} from "./paths.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import {
  getSessionEntry,
  cleanupSessionLifecycleArtifacts as cleanupFileSessionLifecycleArtifacts,
  deleteSessionEntryLifecycle as deleteFileSessionEntryLifecycle,
  applySessionEntryLifecycleMutation as applyFileSessionEntryLifecycleMutation,
  listSessionEntries as listFileSessionEntries,
  loadSessionStore,
  applySessionEntryPatchProjection as applyFileSessionEntryPatchProjection,
  patchSessionEntry as patchFileSessionEntry,
  purgeDeletedAgentSessionEntries as purgeFileDeletedAgentSessionEntries,
  readSessionUpdatedAt as readFileSessionUpdatedAt,
  resolveSessionStoreEntry,
  resetSessionEntryLifecycle as resetFileSessionEntryLifecycle,
  updateSessionStore,
  updateSessionStoreEntry as updateFileSessionStoreEntry,
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
import { parseSessionThreadInfo } from "./thread-info.js";
import {
  type AppendSessionTranscriptMessageParams,
  type AppendSessionTranscriptMessageResult,
  appendSessionTranscriptEvent,
  appendSessionTranscriptMessage,
  appendSessionTranscriptMessageWithOwnedWriteLock,
  withSessionTranscriptAppendQueue,
} from "./transcript-append.js";
import { resolveSessionTranscriptFile } from "./transcript-file-resolve.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import { writeJsonlLines } from "./transcript-jsonl.js";
import { streamSessionTranscriptLines } from "./transcript-stream.js";
import {
  type OwnedSessionTranscriptPublishedEntry,
  resolveOwnedSessionTranscriptWriteLockRunner,
  withOwnedSessionTranscriptWrites,
} from "./transcript-write-context.js";
import type { SessionEntry } from "./types.js";

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
  /** Canonical or alias session key for the entry being read or written. */
  sessionKey: string;
  /** Explicit store path for callers that already resolved the owning store. */
  storePath?: string;
};

export type SessionTranscriptReadScope = Omit<SessionAccessScope, "sessionKey"> & {
  /** Explicit transcript file path; bypasses store lookup when already known. */
  sessionFile?: string;
  /** Runtime session id used to derive a transcript file when no explicit file is provided. */
  sessionId: string;
  /** Optional key for read callers that can resolve via the session entry. */
  sessionKey?: string;
  /** Channel thread suffix used when deriving topic transcript paths. */
  threadId?: string | number;
};

export type SessionTranscriptAccessScope = SessionTranscriptReadScope & {
  /**
   * Identifies the owning entry when the transcript target must be resolved
   * (and possibly persisted) through the session store. May be omitted only
   * when an explicit sessionFile binds the operation to a concrete artifact;
   * such writes never read or update entry metadata.
   */
  sessionKey?: string;
};

export type SessionTranscriptRuntimeScope = SessionAccessScope & {
  /** Resolved file-backed artifact for the current runtime target. */
  sessionFile?: string;
  sessionId: string;
  threadId?: string | number;
};

export type SessionTranscriptWriteScope = Omit<SessionTranscriptAccessScope, "sessionId"> & {
  /** Optional for appenders that can operate on an existing explicit transcript target. */
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

/** Transcript update fields supplied by callers; sessionFile is resolved here. */
export type TranscriptUpdatePayload = Omit<SessionTranscriptUpdate, "sessionFile">;

export type SessionTranscriptTurnUpdateMode = "inline" | "file-only" | "none";

export type SessionTranscriptTurnMessageAppend = TranscriptMessageAppendOptions<unknown> & {
  /**
   * Runs inside the file-backed write lock before this message is appended.
   * SQLite implementation note: duplicate/skip decisions should be evaluated
   * inside the same write transaction as the transcript row append.
   */
  shouldAppend?: (context: SessionTranscriptTurnWriteContext) => Promise<boolean> | boolean;
};

export type SessionTranscriptTurnWriteContext = {
  agentId?: string;
  sessionFile: string;
  sessionId?: string;
  sessionKey?: string;
};

export type SessionTranscriptTurnPersistOptions = {
  /** Runtime config used for lock settings, redaction, and header metadata. */
  config?: OpenClawConfig;
  /** Working directory recorded in a newly created transcript header. */
  cwd?: string;
  /**
   * Rejects the turn when the persisted session key no longer points at this
   * runtime session id. SQLite implementations must evaluate this guard inside
   * the same write transaction as the transcript append and metadata touch.
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

type SessionTranscriptTurnAppendRunner = <TMessage>(
  params: AppendSessionTranscriptMessageParams<TMessage>,
) => Promise<AppendSessionTranscriptMessageResult<TMessage> | undefined>;

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

export type SessionEntryUpdateOptions = {
  /** Skip prune/cap/rotation maintenance for specialized internal updates. */
  skipMaintenance?: boolean;
  /** Let the writer cache retain the updated object without cloning. */
  takeCacheOwnership?: boolean;
};

export type SessionEntryPatchOptions = {
  /** Entry to synthesize when a patch operation is allowed to create. */
  fallbackEntry?: SessionEntry;
  /** Fully resolved maintenance settings when the caller already has config loaded. */
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  /** Keep the previous updatedAt value when the patch should not count as activity. */
  preserveActivity?: boolean;
  /** Replace the whole entry instead of merging the returned patch. */
  replaceEntry?: boolean;
};

export type SessionEntryPatchContext = {
  /** Present when the patched entry already existed before fallback synthesis. */
  existingEntry?: SessionEntry;
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

type CreatedSessionTranscriptResult =
  | { ok: true; sessionFile: string }
  | { ok: false; error: string; phase: "transcript" };

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

/** Returns the entry for a canonical or alias session key, if one exists. */
export function loadSessionEntry(scope: SessionAccessScope): SessionEntry | undefined {
  if (scope.clone === false) {
    const store = loadSessionStore(resolveAccessStorePath(scope), {
      clone: false,
      ...(scope.hydrateSkillPromptRefs === false ? { hydrateSkillPromptRefs: false } : {}),
    });
    return resolveSessionStoreEntry({ store, sessionKey: scope.sessionKey }).existing;
  }
  return getSessionEntry(scope);
}

/**
 * Returns only the row persisted under the exact key provided.
 * Use this for authorization-sensitive routing where alias canonicalization
 * could cross an account or agent boundary.
 */
export function loadExactSessionEntry(scope: SessionAccessScope): ExactSessionEntry | undefined {
  const sessionKey = scope.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const store = loadSessionStore(resolveAccessStorePath(scope), {
    ...(scope.clone === false ? { clone: false } : {}),
    ...(scope.hydrateSkillPromptRefs === false ? { hydrateSkillPromptRefs: false } : {}),
  });
  const entry = Object.hasOwn(store, sessionKey) ? store[sessionKey] : undefined;
  return entry ? { sessionKey, entry } : undefined;
}

/** Lists entries from the resolved store, preserving the persisted key for each row. */
export function listSessionEntries(
  scope: Partial<Omit<SessionAccessScope, "sessionKey">> = {},
): SessionEntrySummary[] {
  if (scope.clone === false) {
    return Object.entries(
      loadSessionStore(resolveAccessStorePath({ ...scope, sessionKey: "" }), {
        clone: false,
        ...(scope.hydrateSkillPromptRefs === false ? { hydrateSkillPromptRefs: false } : {}),
      }),
    ).map(([sessionKey, entry]) => ({ sessionKey, entry }));
  }
  return listFileSessionEntries(scope);
}

/** Reads the last activity timestamp for one session entry, or undefined when absent. */
export function readSessionUpdatedAt(scope: SessionAccessScope): number | undefined {
  if (scope.storePath) {
    return readFileSessionUpdatedAt({
      storePath: scope.storePath,
      sessionKey: scope.sessionKey,
    });
  }
  return loadSessionEntry(scope)?.updatedAt;
}

/** Creates or updates one entry from a partial patch and returns the persisted entry. */
export async function upsertSessionEntry(
  scope: SessionAccessScope,
  patch: Partial<SessionEntry>,
): Promise<SessionEntry | null> {
  return await patchFileSessionEntry({
    ...scope,
    fallbackEntry: createFallbackSessionEntry(patch),
    update: () => patch,
  });
}

/** Replaces one entry with the supplied value and returns the persisted entry. */
export async function replaceSessionEntry(
  scope: SessionAccessScope,
  entry: SessionEntry,
): Promise<SessionEntry | null> {
  return await patchFileSessionEntry({
    ...scope,
    fallbackEntry: entry,
    replaceEntry: true,
    update: () => entry,
  });
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
  return await patchFileSessionEntry({
    ...scope,
    fallbackEntry: options.fallbackEntry,
    maintenanceConfig: options.maintenanceConfig,
    preserveActivity: options.preserveActivity,
    replaceEntry: options.replaceEntry,
    update,
  });
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
  return await updateSessionStore(storePath, async (store) => {
    const resolved = resolveSessionStoreEntry({ store, sessionKey: scope.sessionKey });
    const created = await createEntry({
      existingEntry: resolved.existing ? { ...resolved.existing } : undefined,
      sessionEntries: cloneSessionEntries(store),
    });
    if (!created.ok) {
      return { ok: false, error: created.error, phase: "entry" };
    }

    const ensured = ensureCreatedSessionTranscript({
      agentId: scope.agentId,
      entry: created.entry,
      storePath,
    });
    if (!ensured.ok) {
      delete store[resolved.normalizedKey];
      return ensured;
    }

    const entry =
      created.entry.sessionFile === ensured.sessionFile
        ? created.entry
        : {
            ...created.entry,
            sessionFile: ensured.sessionFile,
          };
    store[resolved.normalizedKey] = entry;
    for (const legacyKey of resolved.legacyKeys) {
      delete store[legacyKey];
    }
    return { ok: true, entry, sessionFile: ensured.sessionFile };
  });
}

function cloneSessionEntries(store: Record<string, SessionEntry>): Record<string, SessionEntry> {
  return Object.fromEntries(
    Object.entries(store).map(([sessionKey, entry]) => [sessionKey, { ...entry }]),
  );
}

// File-backed creation resolves the concrete transcript artifact and writes the
// header before the store mutation is saved; SQLite adapters implement this as
// the same lifecycle operation without exposing rollback details to callers.
function ensureCreatedSessionTranscript(params: {
  agentId?: string;
  entry: SessionEntry;
  storePath: string;
}): CreatedSessionTranscriptResult {
  try {
    const sessionFile = resolveSessionFilePath(
      params.entry.sessionId,
      params.entry.sessionFile ? { sessionFile: params.entry.sessionFile } : undefined,
      {
        agentId: params.agentId,
        sessionsDir: path.dirname(path.resolve(params.storePath)),
      },
    );
    if (!fs.existsSync(sessionFile)) {
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(
        sessionFile,
        `${JSON.stringify(createSessionTranscriptHeader({ sessionId: params.entry.sessionId }))}\n`,
        {
          encoding: "utf-8",
          mode: 0o600,
        },
      );
    }
    return { ok: true, sessionFile };
  } catch (err) {
    return {
      ok: false,
      error: formatErrorMessage(err),
      phase: "transcript",
    };
  }
}

/** Updates an existing entry only; returns null when the session is absent. */
export async function updateSessionEntry(
  scope: SessionAccessScope,
  update: (
    entry: SessionEntry,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
  options: SessionEntryUpdateOptions = {},
): Promise<SessionEntry | null> {
  return await updateFileSessionStoreEntry({
    storePath: resolveAccessStorePath(scope),
    sessionKey: scope.sessionKey,
    skipMaintenance: options.skipMaintenance,
    takeCacheOwnership: options.takeCacheOwnership,
    update,
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
  storePath: string;
  resolveTarget: (snapshot: SessionPatchProjectionSnapshot) => SessionPatchProjectionTarget;
  project: (
    context: SessionPatchProjectionContext,
  ) => Promise<SessionPatchProjectionResult<TFailure>> | SessionPatchProjectionResult<TFailure>;
}): Promise<SessionPatchProjectionResult<TFailure>> {
  return await applyFileSessionEntryPatchProjection(params);
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
  const writerResult = await updateSessionStore(
    params.storePath,
    async (store) => {
      const entries = Object.entries(store).map(([sessionKey, entry]) => ({
        sessionKey,
        entry: structuredClone(entry),
      }));
      const operation = await params.update(entries);
      let changed = false;
      for (const replacement of operation.replacements ?? []) {
        if (!Object.hasOwn(store, replacement.sessionKey)) {
          continue;
        }
        store[replacement.sessionKey] = structuredClone(replacement.entry);
        changed = true;
      }
      return { changed, result: operation.result };
    },
    {
      requireWriteSuccess: params.requireWriteSuccess,
      skipMaintenance: params.skipMaintenance ?? true,
      skipSaveWhenResult: (result) => !result.changed,
    },
  );
  return writerResult.result;
}

/** Removes entries and orphan transcript artifacts owned by a named session lifecycle. */
export async function cleanupSessionLifecycleArtifacts(
  params: SessionLifecycleArtifactCleanupParams,
): Promise<SessionLifecycleArtifactCleanupResult> {
  return await cleanupFileSessionLifecycleArtifacts(params);
}

/** Resets one persisted session entry and transitions its transcript state. */
export async function resetSessionEntryLifecycle(
  params: ResetSessionEntryLifecycleParams,
): Promise<ResetSessionEntryLifecycleResult> {
  return await resetFileSessionEntryLifecycle(params);
}

/** Deletes one persisted session entry and transitions its transcript state. */
export async function deleteSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams,
): Promise<DeleteSessionEntryLifecycleResult> {
  return await deleteFileSessionEntryLifecycle(params);
}

/** Applies exact entry lifecycle mutations and artifact cleanup at the storage boundary. */
export async function applySessionEntryLifecycleMutation(params: {
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
  return await applyFileSessionEntryLifecycleMutation(params);
}

/** Purges session entries owned by a deleted agent at the storage boundary. */
export async function purgeDeletedAgentSessionEntries(
  params: DeletedAgentSessionEntryPurgeParams,
): Promise<SessionEntryLifecycleMutationResult> {
  return await purgeFileDeletedAgentSessionEntries(params);
}

/** Reads parsed transcript records from an explicit or derived transcript target. */
export async function loadTranscriptEvents(
  scope: SessionTranscriptReadScope,
): Promise<TranscriptEvent[]> {
  const transcript = await resolveTranscriptReadAccess(scope);
  const events: TranscriptEvent[] = [];
  for await (const line of streamSessionTranscriptLines(transcript.sessionFile)) {
    events.push(JSON.parse(line) as TranscriptEvent);
  }
  return events;
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
  assertNonMessageTranscriptEvent(event);
  const transcript = await resolveTranscriptAccess(scope);
  await appendSessionTranscriptEvent({
    event,
    transcriptPath: transcript.sessionFile,
  });
}

function assertNonMessageTranscriptEvent(event: TranscriptEvent): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return;
  }
  // Message records require parent-link, idempotency, and redaction handling
  // from appendTranscriptMessage; raw event writes would bypass those invariants.
  if ((event as { type?: unknown }).type === "message") {
    throw new Error(
      "appendTranscriptEvent cannot write message transcript records; use appendTranscriptMessage instead.",
    );
  }
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
  const transcript = await resolveTranscriptAccess(scope);
  return await appendSessionTranscriptMessage({
    transcriptPath: transcript.sessionFile,
    message: options.message,
    ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.config ? { config: options.config } : {}),
    ...(options.idempotencyLookup ? { idempotencyLookup: options.idempotencyLookup } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.prepareMessageAfterIdempotencyCheck
      ? { prepareMessageAfterIdempotencyCheck: options.prepareMessageAfterIdempotencyCheck }
      : {}),
    ...(options.useRawWhenLinear !== undefined
      ? { useRawWhenLinear: options.useRawWhenLinear }
      : {}),
  });
}

/** Emits a transcript update after resolving the current transcript target. */
export async function publishTranscriptUpdate(
  scope: SessionTranscriptWriteScope,
  update: TranscriptUpdatePayload = {},
): Promise<void> {
  const transcript = await resolveTranscriptAccess(scope);
  emitSessionTranscriptUpdate({
    ...update,
    sessionFile: transcript.sessionFile,
  });
}

/**
 * Trims a transcript for manual sessions.compact and clears stale token metadata.
 * This is one storage-sized mutation: future stores can trim transcript rows and
 * update entry metadata inside the same backend transaction.
 */
export async function trimSessionTranscriptForManualCompact(
  scope: SessionTranscriptRuntimeScope,
  params: { maxLines: number; nowMs?: number; sessionFile?: string },
): Promise<SessionTranscriptManualTrimResult> {
  const transcript = await resolveManualCompactTranscriptTarget(scope, params.sessionFile);
  if (!transcript) {
    return { compacted: false, reason: "no transcript" };
  }

  const maxLines = Math.max(1, Math.floor(params.maxLines));
  const lines: string[] = [];
  let totalLines = 0;
  try {
    for await (const line of streamSessionTranscriptLines(transcript.sessionFile)) {
      totalLines += 1;
      lines.push(line);
      if (lines.length > maxLines) {
        lines.shift();
      }
    }
  } catch {
    return { compacted: false, kept: 0 };
  }
  if (totalLines <= maxLines) {
    return { compacted: false, kept: totalLines };
  }

  const archived = await archiveTranscriptFileForManualCompact(transcript.sessionFile);
  await writeJsonlLines(transcript.sessionFile, lines);
  await patchSessionEntry(
    {
      ...scope,
      sessionKey: transcript.sessionKey,
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

async function archiveTranscriptFileForManualCompact(filePath: string): Promise<string> {
  const archived = `${filePath}.bak.${formatSessionArchiveTimestamp()}`;
  await fs.promises.rename(filePath, archived);
  emitSessionTranscriptUpdate({ sessionFile: archived });
  return archived;
}

async function resolveManualCompactTranscriptTarget(
  scope: SessionTranscriptRuntimeScope,
  sessionFile?: string,
): Promise<SessionTranscriptRuntimeTarget | null> {
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript scope without an agent id: ${scope.sessionKey}`);
  }
  const candidates = resolveManualCompactTranscriptCandidates({
    agentId,
    sessionFile,
    sessionId: scope.sessionId,
    storePath: scope.storePath,
  });
  for (const candidate of candidates) {
    const stat = await fs.promises.stat(candidate).catch(() => null);
    if (stat?.isFile()) {
      return {
        agentId,
        sessionFile: candidate,
        sessionId: scope.sessionId,
        sessionKey: scope.sessionKey,
      };
    }
  }
  return null;
}

function resolveManualCompactTranscriptCandidates(params: {
  agentId?: string;
  sessionFile?: string;
  sessionId: string;
  storePath?: string;
}): string[] {
  const candidates: string[] = [];
  const sessionFileState = classifyGeneratedTranscriptCandidate(
    params.sessionId,
    params.sessionFile,
  );
  const pushCandidate = (resolve: () => string): void => {
    try {
      const candidate = resolve();
      if (!candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    } catch {
      // Keep scanning the remaining file-backed candidates.
    }
  };

  if (params.storePath) {
    const sessionsDir = path.dirname(params.storePath);
    if (params.sessionFile && sessionFileState !== "stale") {
      pushCandidate(() =>
        resolveSessionFilePath(
          params.sessionId,
          { sessionFile: params.sessionFile },
          { sessionsDir, agentId: params.agentId },
        ),
      );
    }
    pushCandidate(() => resolveSessionTranscriptPathInDir(params.sessionId, sessionsDir));
    if (params.sessionFile && sessionFileState === "stale") {
      pushCandidate(() =>
        resolveSessionFilePath(
          params.sessionId,
          { sessionFile: params.sessionFile },
          { sessionsDir, agentId: params.agentId },
        ),
      );
    }
  } else if (params.sessionFile) {
    if (params.agentId) {
      if (sessionFileState !== "stale") {
        pushCandidate(() =>
          resolveSessionFilePath(
            params.sessionId,
            { sessionFile: params.sessionFile },
            { agentId: params.agentId },
          ),
        );
      }
    } else {
      const trimmed = params.sessionFile.trim();
      if (trimmed) {
        candidates.push(path.resolve(trimmed));
      }
    }
  }

  if (params.agentId) {
    pushCandidate(() => resolveSessionTranscriptPath(params.sessionId, params.agentId));
    if (params.sessionFile && sessionFileState === "stale") {
      pushCandidate(() =>
        resolveSessionFilePath(
          params.sessionId,
          { sessionFile: params.sessionFile },
          { agentId: params.agentId },
        ),
      );
    }
  }

  const legacyDir = path.join(
    resolveRequiredHomeDir(process.env, os.homedir),
    ".openclaw",
    "sessions",
  );
  pushCandidate(() => resolveSessionTranscriptPathInDir(params.sessionId, legacyDir));
  return candidates;
}

function classifyGeneratedTranscriptCandidate(
  sessionId: string,
  sessionFile?: string,
): "current" | "stale" | "custom" {
  const transcriptSessionId = extractGeneratedTranscriptSessionId(sessionFile);
  if (!transcriptSessionId) {
    return "custom";
  }
  return transcriptSessionId === sessionId ? "current" : "stale";
}

/**
 * Persists one logical transcript turn through the current file-backed writer.
 * The file implementation resolves/rebinds the transcript file, holds one
 * session write lock across all message appends, optionally touches session
 * metadata, then publishes after the write has completed.
 *
 * SQLite implementation note: the transcript row append(s), sessionFile marker,
 * and requested updatedAt touch become one SQLite write transaction; transcript
 * update delivery must run only after commit.
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
  const appendedMessages = await appendTranscriptTurnMessages(target, options);
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
  const appendedMessages: TranscriptMessageAppendResult<unknown>[] = [];
  const publishedEntries: OwnedSessionTranscriptPublishedEntry[] = [];
  const appendMessages = async (appendMessage: SessionTranscriptTurnAppendRunner) => {
    for (const append of options.messages) {
      const shouldAppend = append.shouldAppend
        ? await append.shouldAppend({
            ...(target.agentId ? { agentId: target.agentId } : {}),
            sessionFile: target.sessionFile,
            ...(target.sessionId ? { sessionId: target.sessionId } : {}),
            ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
          })
        : true;
      if (!shouldAppend) {
        continue;
      }
      const result = await appendMessage({
        transcriptPath: target.sessionFile,
        message: append.message,
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        ...((append.cwd ?? options.cwd) ? { cwd: append.cwd ?? options.cwd } : {}),
        ...((append.config ?? options.config) ? { config: append.config ?? options.config } : {}),
        ...(append.idempotencyLookup ? { idempotencyLookup: append.idempotencyLookup } : {}),
        ...(append.now !== undefined ? { now: append.now } : {}),
        ...(append.prepareMessageAfterIdempotencyCheck
          ? { prepareMessageAfterIdempotencyCheck: append.prepareMessageAfterIdempotencyCheck }
          : {}),
        onHeaderCreated: (header) => {
          publishedEntries.push({ kind: "header", serialized: header });
        },
        ...(append.useRawWhenLinear !== undefined
          ? { useRawWhenLinear: append.useRawWhenLinear }
          : {}),
      });
      if (result) {
        appendedMessages.push(result);
        if (result.appended) {
          publishedEntries.push({ kind: "id", id: result.messageId });
        }
      }
    }
  };
  const activeLockRunner = resolveOwnedSessionTranscriptWriteLockRunner({
    sessionFile: target.sessionFile,
    sessionKey: target.sessionKey,
  });
  const runBatchWithOwnedLock = async () =>
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile: target.sessionFile,
        sessionKey: target.sessionKey,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => await appendMessages(appendSessionTranscriptMessageWithOwnedWriteLock),
    );
  if (activeLockRunner) {
    await activeLockRunner(
      () => withSessionTranscriptAppendQueue(target.sessionFile, runBatchWithOwnedLock),
      {
        publishOwnedWrite: true,
        resolvePublishedEntries: () => publishedEntries,
        resolvePublishedEntriesAfterFailure: () => publishedEntries,
      },
    );
  } else {
    await withSessionTranscriptAppendQueue(target.sessionFile, async () => {
      const lock = await acquireSessionWriteLock({
        sessionFile: target.sessionFile,
        ...resolveSessionWriteLockOptions(options.config),
        allowReentrant: true,
      });
      try {
        await runBatchWithOwnedLock();
      } finally {
        await lock.release();
      }
    });
  }
  return appendedMessages;
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
  const expectedSessionId = options.expectedSessionId;
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript turn without an agent id: ${sessionKey}`);
  }
  const store =
    scope.sessionStore ?? loadSessionStore(scope.storePath, { skipCache: true, clone: false });
  const resolved = resolveSessionStoreEntry({ store, sessionKey });
  let appendedMessages: TranscriptMessageAppendResult<unknown>[] = [];
  let target: SessionTranscriptTurnWriteContext = {
    agentId,
    sessionFile:
      scope.sessionFile ??
      resolveSessionTranscriptPathInDir(expectedSessionId, path.dirname(scope.storePath)),
    sessionId: expectedSessionId,
    sessionKey: resolved.normalizedKey,
  };
  let rejectedEntry: SessionEntry | undefined;
  let touchUpdatedAt: number | undefined;

  const updated = await updateSessionEntry(
    {
      sessionKey: resolved.normalizedKey,
      storePath: scope.storePath,
    },
    async (currentEntry) => {
      if (currentEntry.sessionId !== expectedSessionId) {
        rejectedEntry = currentEntry;
        return null;
      }
      const sessionFile =
        scope.sessionFile ??
        resolveSessionFilePath(
          currentEntry.sessionId,
          currentEntry,
          resolveSessionFilePathOptions({
            agentId,
            storePath: scope.storePath,
          }),
        );
      target = {
        agentId,
        sessionFile,
        sessionId: currentEntry.sessionId,
        sessionKey: resolved.normalizedKey,
      };
      appendedMessages = await appendTranscriptTurnMessages(target, options);
      const appendedCount = countAppendedTranscriptMessages(appendedMessages);
      if (options.touchSessionEntry === true && appendedCount > 0) {
        touchUpdatedAt = Date.now();
      }
      const patch = {
        ...(currentEntry.sessionFile === sessionFile ? {} : { sessionFile }),
        ...(touchUpdatedAt !== undefined
          ? { updatedAt: Math.max(currentEntry.updatedAt ?? 0, touchUpdatedAt) }
          : {}),
      };
      return Object.keys(patch).length > 0 ? patch : null;
    },
    { skipMaintenance: true },
  );

  if (rejectedEntry || updated?.sessionId !== expectedSessionId) {
    return {
      appendedCount: 0,
      messages: [],
      rejectedReason: "session-rebound",
      sessionEntry: rejectedEntry ?? updated ?? undefined,
      sessionFile: target.sessionFile,
    };
  }

  await publishTranscriptTurnUpdate({
    target,
    updateMode: options.updateMode ?? "inline",
    publishWhen: options.publishWhen ?? "when-appended",
    appendedMessages,
  });

  if (updated && scope.sessionStore) {
    scope.sessionStore[resolved.normalizedKey] = updated;
  }
  return {
    appendedCount: countAppendedTranscriptMessages(appendedMessages),
    messages: appendedMessages,
    sessionEntry: updated ?? scope.sessionEntry,
    sessionFile: target.sessionFile,
  };
}

/**
 * Resolves the current file-backed target for a storage-neutral runtime
 * transcript scope. Callers use the scope as identity; sessionFile is returned
 * only for current file-backed implementation details such as locks/events.
 */
export async function resolveSessionTranscriptRuntimeTarget(
  scope: SessionTranscriptRuntimeScope,
): Promise<SessionTranscriptRuntimeTarget> {
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript scope without an agent id: ${scope.sessionKey}`);
  }
  const sessionStore = scope.storePath
    ? loadSessionStore(scope.storePath, { skipCache: true })
    : undefined;
  const resolvedStoreEntry = sessionStore
    ? resolveSessionStoreEntry({ store: sessionStore, sessionKey: scope.sessionKey })
    : undefined;
  const sessionEntry = resolvedStoreEntry?.existing ?? loadSessionEntry(scope);
  const sessionKey = resolvedStoreEntry?.normalizedKey ?? scope.sessionKey;
  if (scope.sessionFile?.trim()) {
    return {
      agentId,
      sessionFile: path.resolve(scope.sessionFile),
      sessionId: scope.sessionId,
      sessionKey,
    };
  }
  if (sessionStore && scope.storePath) {
    const sessionsDir = path.dirname(path.resolve(scope.storePath));
    const threadId = scope.threadId ?? parseSessionThreadInfo(scope.sessionKey).threadId;
    const shouldUseDerivedSessionFile =
      !sessionEntry?.sessionFile || sessionEntry.sessionId !== scope.sessionId;
    const fallbackSessionFile =
      shouldUseDerivedSessionFile && threadId !== undefined
        ? resolveSessionTranscriptPathInDir(scope.sessionId, sessionsDir, threadId)
        : undefined;
    const resolved = await resolveAndPersistSessionFile({
      agentId,
      fallbackSessionFile,
      sessionEntry,
      sessionId: scope.sessionId,
      sessionKey,
      sessionStore,
      sessionsDir,
      storePath: scope.storePath,
    });
    return {
      agentId,
      sessionFile: resolved.sessionFile,
      sessionId: scope.sessionId,
      sessionKey,
    };
  }
  const resolved = await resolveSessionTranscriptFile({
    agentId,
    sessionEntry,
    sessionId: scope.sessionId,
    sessionKey: scope.sessionKey,
    ...(sessionStore ? { sessionStore } : {}),
    ...(scope.storePath ? { storePath: scope.storePath } : {}),
    ...(scope.threadId !== undefined ? { threadId: scope.threadId } : {}),
  });
  return {
    agentId,
    sessionFile: resolved.sessionFile,
    sessionId: scope.sessionId,
    sessionKey,
  };
}

/**
 * Resolves the file-backed runtime transcript target for read/delete probes
 * without persisting missing sessionFile metadata into the session store.
 */
export async function resolveSessionTranscriptRuntimeReadTarget(
  scope: SessionTranscriptRuntimeScope,
): Promise<SessionTranscriptRuntimeTarget> {
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  if (!agentId) {
    throw new Error(`Cannot resolve transcript scope without an agent id: ${scope.sessionKey}`);
  }
  const sessionStore = scope.storePath
    ? loadSessionStore(scope.storePath, { skipCache: true })
    : undefined;
  const resolvedStoreEntry = sessionStore
    ? resolveSessionStoreEntry({ store: sessionStore, sessionKey: scope.sessionKey })
    : undefined;
  const sessionEntry = resolvedStoreEntry?.existing ?? loadSessionEntry(scope);
  const sessionKey = resolvedStoreEntry?.normalizedKey ?? scope.sessionKey;
  if (scope.sessionFile?.trim()) {
    return {
      agentId,
      sessionFile: path.resolve(scope.sessionFile),
      sessionId: scope.sessionId,
      sessionKey,
    };
  }
  const matchingSessionEntry =
    sessionEntry?.sessionId === scope.sessionId ? sessionEntry : undefined;
  if (scope.storePath) {
    const sessionsDir = path.dirname(path.resolve(scope.storePath));
    const threadId = scope.threadId ?? parseSessionThreadInfo(sessionKey).threadId;
    const sessionFile = matchingSessionEntry?.sessionFile
      ? resolveSessionFilePath(scope.sessionId, matchingSessionEntry, { agentId, sessionsDir })
      : resolveSessionTranscriptPathInDir(scope.sessionId, sessionsDir, threadId);
    return {
      agentId,
      sessionFile,
      sessionId: scope.sessionId,
      sessionKey,
    };
  }
  const threadId = scope.threadId ?? parseSessionThreadInfo(sessionKey).threadId;
  const sessionFile = matchingSessionEntry?.sessionFile
    ? resolveSessionFilePath(scope.sessionId, matchingSessionEntry, { agentId })
    : resolveSessionTranscriptPath(scope.sessionId, agentId, threadId);
  return {
    agentId,
    sessionFile,
    sessionId: scope.sessionId,
    sessionKey,
  };
}

function createFallbackSessionEntry(patch: Partial<SessionEntry>): SessionEntry {
  const now = Date.now();
  return {
    sessionId: patch.sessionId ?? randomUUID(),
    updatedAt: patch.updatedAt ?? now,
    ...patch,
  };
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

async function resolveTranscriptReadAccess(scope: SessionTranscriptReadScope): Promise<{
  sessionFile: string;
}> {
  if (scope.sessionFile?.trim()) {
    return { sessionFile: scope.sessionFile };
  }
  if (scope.sessionKey) {
    return await resolveTranscriptAccess({ ...scope, sessionKey: scope.sessionKey });
  }
  if (scope.storePath) {
    return {
      sessionFile: resolveSessionTranscriptPathInDir(
        scope.sessionId,
        path.dirname(path.resolve(scope.storePath)),
        scope.threadId,
      ),
    };
  }
  if (scope.agentId) {
    return {
      sessionFile: resolveSessionTranscriptPath(scope.sessionId, scope.agentId, scope.threadId),
    };
  }
  throw new Error(`Cannot resolve transcript read scope without a session target`);
}

async function resolveTranscriptAccess(scope: SessionTranscriptWriteScope): Promise<{
  sessionFile: string;
}> {
  if (scope.sessionFile?.trim()) {
    return { sessionFile: scope.sessionFile };
  }
  // Past this point resolution goes through the session entry, so the owning
  // key is mandatory; explicit-artifact writes returned above never need it.
  const scopeSessionKey = scope.sessionKey?.trim();
  if (!scopeSessionKey) {
    throw new Error(
      "Cannot resolve a transcript write scope without a session key or explicit session file",
    );
  }
  if (!scope.sessionId) {
    throw new Error(`Cannot resolve transcript scope without a session id: ${scopeSessionKey}`);
  }
  return await resolveSessionTranscriptRuntimeTarget({
    ...scope,
    sessionId: scope.sessionId,
    sessionKey: scopeSessionKey,
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
  if (scope.sessionFile?.trim()) {
    return {
      ...(scope.agentId ? { agentId: scope.agentId } : {}),
      sessionFile: scope.sessionFile,
      ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
      ...(scope.sessionKey ? { sessionKey: scope.sessionKey } : {}),
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
  const store =
    scope.sessionStore ??
    (scope.storePath ? loadSessionStore(scope.storePath, { skipCache: true }) : undefined);
  const resolved = store ? resolveSessionStoreEntry({ store, sessionKey }) : undefined;
  const sessionEntry =
    resolved?.existing ?? scope.sessionEntry ?? loadSessionEntry({ ...scope, sessionKey });
  const resolvedFile = await resolveSessionTranscriptFile({
    agentId,
    sessionEntry,
    sessionId: scope.sessionId,
    sessionKey,
    ...(store ? { sessionStore: store } : {}),
    ...(scope.storePath ? { storePath: scope.storePath } : {}),
    ...(scope.threadId !== undefined ? { threadId: scope.threadId } : {}),
  });
  return {
    agentId,
    sessionFile: resolvedFile.sessionFile,
    sessionId: scope.sessionId,
    sessionKey: resolved?.normalizedKey ?? sessionKey,
    sessionEntry: resolvedFile.sessionEntry,
  };
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
    !params.scope.storePath ||
    !params.target.sessionKey ||
    !params.target.sessionId
  ) {
    return params.target.sessionEntry;
  }
  const markerUpdatedAt = Date.now();
  const updated = await updateSessionEntry(
    {
      sessionKey: params.target.sessionKey,
      storePath: params.scope.storePath,
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
  emitSessionTranscriptUpdate({
    ...(params.target.sessionKey ? { sessionKey: params.target.sessionKey } : {}),
    ...(params.target.agentId ? { agentId: params.target.agentId } : {}),
    ...(params.updateMode === "inline" && lastAppended
      ? {
          message: lastAppended.message,
          messageId: lastAppended.messageId,
        }
      : {}),
    sessionFile: params.target.sessionFile,
  });
}
