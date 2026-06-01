import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { SessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { getRuntimeConfig } from "../io.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveSessionTranscriptPathInDir, resolveStorePath } from "./paths.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import {
  getSessionEntry,
  listSessionEntries as listFileSessionEntries,
  loadSessionStore,
  patchSessionEntry as patchFileSessionEntry,
  readSessionUpdatedAt as readFileSessionUpdatedAt,
  resolveSessionStoreEntry,
  updateSessionStoreEntry as updateFileSessionStoreEntry,
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

export type SessionTranscriptAccessScope = SessionAccessScope & {
  sessionFile?: string;
  sessionId: string;
  threadId?: string | number;
};

export type SessionTranscriptWriteScope = Omit<SessionTranscriptAccessScope, "sessionId"> & {
  sessionId?: string;
};

export type SessionEntrySummary = {
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

export type SessionEntryUpdateOptions = {
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
};

export type SessionEntryPatchOptions = {
  fallbackEntry?: SessionEntry;
  replaceEntry?: boolean;
};

export type SessionEntryPatchContext = {
  existingEntry?: SessionEntry;
};

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

/** Loads raw transcript events through the storage-neutral accessor seam. */
export async function loadTranscriptEvents(
  scope: SessionTranscriptAccessScope,
): Promise<TranscriptEvent[]> {
  const transcript = await resolveTranscriptAccess(scope);
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
