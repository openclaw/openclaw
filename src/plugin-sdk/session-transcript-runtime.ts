import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { uniqueStrings } from "../../packages/normalization-core/src/string-normalization.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  publishTranscriptUpdate,
  resolveSessionTranscriptRuntimeTarget,
  resolveSessionTranscriptTarget as resolveSessionTranscriptStorageTarget,
  type TranscriptMessageAppendOptions,
  type TranscriptMessageAppendResult,
  type TranscriptUpdatePayload,
} from "../config/sessions/session-accessor.js";
import { runSessionTranscriptAppendTransaction } from "../config/sessions/transcript-append.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../routing/session-key.js";

const SESSION_TRANSCRIPT_MEMORY_HIT_PREFIX = "transcript";

export type SessionTranscriptEvent = unknown;

export type SessionTranscriptIdentity = {
  agentId: string;
  memoryKey: SessionTranscriptMemoryHitKey;
  sessionId: string;
  sessionKey: string;
};

export type SessionTranscriptMemoryHitIdentity = {
  agentId: string;
  key: SessionTranscriptMemoryHitKey;
  sessionId: string;
};

export type SessionTranscriptMemoryHitKey = `transcript:${string}:${string}`;

export type SessionTranscriptReadParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  hydrateSkillPromptRefs?: boolean;
  sessionId: string;
  sessionKey: string;
  storePath?: string;
  threadId?: string | number;
};

export type SessionTranscriptTargetParams = SessionTranscriptReadParams & {
  /**
   * Optional active transcript artifact target. Use this when the caller is
   * already operating on a concrete transcript file and needs all scoped
   * operations to bind to that same target.
   */
  sessionFile?: string;
};

export type SessionTranscriptTarget = SessionTranscriptIdentity & {
  targetKind: "active-session-file" | "runtime-session";
};

export type SessionTranscriptAppendMessageParams<TMessage> = SessionTranscriptTargetParams &
  TranscriptMessageAppendOptions<TMessage>;

export type SessionTranscriptWriteLockParams = SessionTranscriptTargetParams & {
  config?: TranscriptMessageAppendOptions<unknown>["config"];
};

export type SessionTranscriptWriteLockContext = {
  appendMessage: <TMessage>(
    options: Omit<TranscriptMessageAppendOptions<TMessage>, "config">,
  ) => Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
  publishUpdate: (update?: TranscriptUpdatePayload) => Promise<void>;
  readEvents: () => Promise<SessionTranscriptEvent[]>;
  target: SessionTranscriptTarget;
};

export type SessionTranscriptMemoryHitKeyParams = {
  agentId: string;
  sessionId: string;
};

export type ResolveSessionTranscriptMemoryHitKeyParams = {
  includeSyntheticFallback?: boolean;
  key: string;
  store: Record<string, SessionEntry>;
};

function requireMemoryKeySegment(value: string, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`Cannot build session transcript memory hit key without ${label}.`);
  }
  return encodeURIComponent(normalized);
}

function decodeMemoryKeySegment(value: string): string | null {
  try {
    return normalizeOptionalString(decodeURIComponent(value)) ?? null;
  } catch {
    return null;
  }
}

function syntheticSessionKey(identity: SessionTranscriptMemoryHitIdentity): string {
  return `agent:${identity.agentId}:${identity.sessionId}`;
}

/**
 * Builds the storage-neutral memory hit key for one session transcript.
 */
export function formatSessionTranscriptMemoryHitKey(
  params: SessionTranscriptMemoryHitKeyParams,
): SessionTranscriptMemoryHitKey {
  const agentId = requireMemoryKeySegment(normalizeAgentId(params.agentId), "agentId");
  const sessionId = requireMemoryKeySegment(params.sessionId, "sessionId");
  return `${SESSION_TRANSCRIPT_MEMORY_HIT_PREFIX}:${agentId}:${sessionId}`;
}

/**
 * Parses a storage-neutral session transcript memory hit key.
 */
export function parseSessionTranscriptMemoryHitKey(
  key: string,
): SessionTranscriptMemoryHitIdentity | null {
  const parts = key.split(":");
  if (parts.length !== 3 || parts[0] !== SESSION_TRANSCRIPT_MEMORY_HIT_PREFIX) {
    return null;
  }
  const agentId = decodeMemoryKeySegment(parts[1] ?? "");
  const sessionId = decodeMemoryKeySegment(parts[2] ?? "");
  if (!agentId || !sessionId) {
    return null;
  }
  return {
    agentId: normalizeAgentId(agentId),
    key: formatSessionTranscriptMemoryHitKey({ agentId, sessionId }),
    sessionId,
  };
}

/**
 * Resolves the public identity for a transcript without returning its file path.
 */
export async function resolveSessionTranscriptIdentity(
  params: SessionTranscriptReadParams,
): Promise<SessionTranscriptIdentity> {
  const target = await resolveSessionTranscriptRuntimeTarget(params);
  const agentId = normalizeAgentId(target.agentId);
  return {
    agentId,
    memoryKey: formatSessionTranscriptMemoryHitKey({ agentId, sessionId: target.sessionId }),
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
  };
}

/**
 * Resolves the public target for transcript operations without exposing the
 * current storage path as identity.
 */
export async function resolveSessionTranscriptTarget(
  params: SessionTranscriptTargetParams,
): Promise<SessionTranscriptTarget> {
  const target = await resolveSessionTranscriptStorageTarget(params);
  return projectPublicTarget(target);
}

/**
 * Reads transcript events by public session identity instead of file path.
 */
export async function readSessionTranscriptEvents(
  params: SessionTranscriptTargetParams,
): Promise<SessionTranscriptEvent[]> {
  return await loadTranscriptEvents(params);
}

/**
 * Appends a transcript message by scoped transcript target.
 */
export async function appendSessionTranscriptMessageByIdentity<TMessage>(
  params: SessionTranscriptAppendMessageParams<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage> | undefined> {
  return await appendTranscriptMessage(params, params);
}

/**
 * Publishes a transcript update by scoped transcript target.
 */
export async function publishSessionTranscriptUpdateByIdentity(
  params: SessionTranscriptTargetParams & { update?: TranscriptUpdatePayload },
): Promise<void> {
  await publishTranscriptUpdate(params, params.update);
}

/**
 * Runs transcript work under the write lock for the resolved scoped target.
 */
export async function withSessionTranscriptWriteLock<T>(
  params: SessionTranscriptWriteLockParams,
  run: (context: SessionTranscriptWriteLockContext) => Promise<T> | T,
): Promise<T> {
  const storageTarget = await resolveSessionTranscriptStorageTarget(params);
  const target = projectPublicTarget(storageTarget);
  const boundScope = {
    ...params,
    sessionFile: storageTarget.sessionFile,
  };
  return await runSessionTranscriptAppendTransaction(
    {
      config: params.config,
      transcriptPath: storageTarget.sessionFile,
    },
    (transaction) =>
      run({
        target,
        readEvents: () => readSessionTranscriptEvents(boundScope),
        appendMessage: (options) =>
          transaction.appendMessage({
            ...options,
            sessionId: params.sessionId,
          }),
        publishUpdate: (update) =>
          publishSessionTranscriptUpdateByIdentity({
            ...boundScope,
            update,
          }),
      }),
  );
}

/**
 * Maps a storage-neutral memory hit key back to visible session store keys.
 */
export function resolveSessionTranscriptMemoryHitKeyToSessionKeys(
  params: ResolveSessionTranscriptMemoryHitKeyParams,
): string[] {
  const identity = parseSessionTranscriptMemoryHitKey(params.key);
  if (!identity) {
    return [];
  }
  const matches = Object.entries(params.store)
    .filter(([sessionKey, entry]) => {
      return (
        entry.sessionId === identity.sessionId &&
        normalizeAgentId(resolveAgentIdFromSessionKey(sessionKey)) === identity.agentId
      );
    })
    .map(([sessionKey]) => sessionKey);
  const deduped = uniqueStrings(matches);
  if (deduped.length > 0) {
    return deduped;
  }
  return params.includeSyntheticFallback === false ? [] : [syntheticSessionKey(identity)];
}

function projectPublicTarget(target: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  targetKind: SessionTranscriptTarget["targetKind"];
}): SessionTranscriptTarget {
  const agentId = normalizeAgentId(target.agentId);
  return {
    agentId,
    memoryKey: formatSessionTranscriptMemoryHitKey({ agentId, sessionId: target.sessionId }),
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    targetKind: target.targetKind,
  };
}
