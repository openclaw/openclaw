import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { SessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { getRuntimeConfig } from "../io.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  resolveSessionTranscriptPath,
  resolveSessionTranscriptPathInDir,
  resolveStorePath,
} from "./paths.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import {
  getSessionEntry,
  cleanupSessionLifecycleArtifacts as cleanupFileSessionLifecycleArtifacts,
  listSessionEntries as listFileSessionEntries,
  loadSessionStore,
  patchSessionEntry as patchFileSessionEntry,
  readSessionUpdatedAt as readFileSessionUpdatedAt,
  resolveSessionStoreEntry,
  updateSessionStoreEntry as updateFileSessionStoreEntry,
  type SessionLifecycleArtifactCleanupParams,
  type SessionLifecycleArtifactCleanupResult,
} from "./store.js";
import { parseSessionThreadInfo } from "./thread-info.js";
import {
  appendSessionTranscriptEvent,
  appendSessionTranscriptMessage,
} from "./transcript-append.js";
import { streamSessionTranscriptLines } from "./transcript-stream.js";
import { resolveSessionTranscriptFile } from "./transcript.js";
import type { SessionEntry } from "./types.js";

export type SessionAccessScope = {
  agentId?: string;
  clone?: boolean;
  env?: NodeJS.ProcessEnv;
  hydrateSkillPromptRefs?: boolean;
  sessionKey: string;
  storePath?: string;
};

export type SessionTranscriptReadScope = Omit<SessionAccessScope, "sessionKey"> & {
  sessionFile?: string;
  sessionId: string;
  sessionKey?: string;
  threadId?: string | number;
};

export type SessionTranscriptAccessScope = SessionTranscriptReadScope & {
  sessionKey: string;
};

export type SessionTranscriptWriteScope = Omit<SessionTranscriptAccessScope, "sessionId"> & {
  sessionId?: string;
};

export type SessionEntrySummary = {
  sessionKey: string;
  entry: SessionEntry;
};

/** Session entry read by the exact persisted session key, without alias resolution. */
export type ExactSessionEntry = {
  sessionKey: string;
  entry: SessionEntry;
};

export type TranscriptEvent = unknown;

export type TranscriptMessageAppendOptions<TMessage> = {
  config?: OpenClawConfig;
  cwd?: string;
  idempotencyLookup?: "scan" | "caller-checked";
  message: TMessage;
  now?: number;
  prepareMessageAfterIdempotencyCheck?: (message: TMessage) => TMessage | undefined;
  useRawWhenLinear?: boolean;
};

export type TranscriptMessageAppendResult<TMessage> = {
  appended: boolean;
  message: TMessage;
  messageId: string;
};

export type TranscriptUpdatePayload = Omit<SessionTranscriptUpdate, "sessionFile">;

/** Active transcript target resolved from storage-neutral runtime identity. */
export type SessionTranscriptRuntimeTarget = {
  agentId: string;
  sessionFile: string;
  sessionId: string;
  sessionKey: string;
  storageKind: "file";
  targetKind: "active-session-file" | "runtime-session";
};

export type SessionEntryUpdateOptions = {
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
};

export type SessionEntryPatchOptions = {
  fallbackEntry?: SessionEntry;
  preserveActivity?: boolean;
  replaceEntry?: boolean;
};

export type SessionEntryPatchContext = {
  existingEntry?: SessionEntry;
};

export type { SessionLifecycleArtifactCleanupParams, SessionLifecycleArtifactCleanupResult };

/** Loads one session entry through the storage-neutral accessor seam. */
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
 * Loads one entry only when the persisted key exactly matches the requested key.
 * Approval routing uses this to avoid canonical alias lookup crossing accounts.
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

/** Lists session entries through the storage-neutral accessor seam. */
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

/** Reads a session activity timestamp through the storage-neutral accessor seam. */
export function readSessionUpdatedAt(scope: SessionAccessScope): number | undefined {
  if (scope.storePath) {
    return readFileSessionUpdatedAt({
      storePath: scope.storePath,
      sessionKey: scope.sessionKey,
    });
  }
  return loadSessionEntry(scope)?.updatedAt;
}

/** Applies a partial entry update through the storage-neutral accessor seam. */
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

/** Replaces one entry through the storage-neutral accessor seam. */
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

/** Patches one entry atomically through the storage-neutral accessor seam. */
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
    preserveActivity: options.preserveActivity,
    replaceEntry: options.replaceEntry,
    update,
  });
}

/** Updates an existing session entry through the storage-neutral accessor seam. */
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

/** Cleans scoped session lifecycle entries and transcript artifacts through the accessor seam. */
export async function cleanupSessionLifecycleArtifacts(
  params: SessionLifecycleArtifactCleanupParams,
): Promise<SessionLifecycleArtifactCleanupResult> {
  return await cleanupFileSessionLifecycleArtifacts(params);
}

/** Loads raw transcript events through the storage-neutral accessor seam. */
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

/** Appends one raw transcript event through the storage-neutral accessor seam. */
export async function appendTranscriptEvent(
  scope: SessionTranscriptAccessScope,
  event: TranscriptEvent,
): Promise<void> {
  const transcript = await resolveTranscriptAccess(scope);
  await appendSessionTranscriptEvent({
    event,
    transcriptPath: transcript.sessionFile,
  });
}

/** Appends one transcript message through the storage-neutral writer seam. */
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

/** Publishes a transcript update after resolving the current storage target. */
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

/** Resolves the current file-backed transcript artifact for a runtime session scope. */
export async function resolveSessionTranscriptRuntimeTarget(
  scope: SessionTranscriptAccessScope,
): Promise<SessionTranscriptRuntimeTarget> {
  const transcript = await resolveTranscriptAccess(scope);
  return {
    agentId: scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey) ?? "",
    sessionFile: transcript.sessionFile,
    sessionId: scope.sessionId,
    sessionKey: scope.sessionKey,
    storageKind: "file",
    targetKind: "runtime-session",
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
  if (!scope.sessionId) {
    throw new Error(`Cannot resolve transcript scope without a session id: ${scope.sessionKey}`);
  }
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
  if (sessionStore && scope.storePath) {
    const sessionsDir = path.dirname(path.resolve(scope.storePath));
    const threadId = scope.threadId ?? parseSessionThreadInfo(scope.sessionKey).threadId;
    const fallbackSessionFile =
      !sessionEntry?.sessionFile && threadId !== undefined
        ? resolveSessionTranscriptPathInDir(scope.sessionId, sessionsDir, threadId)
        : undefined;
    return await resolveAndPersistSessionFile({
      agentId,
      fallbackSessionFile,
      sessionEntry,
      sessionId: scope.sessionId,
      sessionKey,
      sessionStore,
      sessionsDir,
      storePath: scope.storePath,
    });
  }
  return await resolveSessionTranscriptFile({
    agentId,
    sessionEntry,
    sessionId: scope.sessionId,
    sessionKey: scope.sessionKey,
    ...(sessionStore ? { sessionStore } : {}),
    ...(scope.storePath ? { storePath: scope.storePath } : {}),
    ...(scope.threadId !== undefined ? { threadId: scope.threadId } : {}),
  });
}
