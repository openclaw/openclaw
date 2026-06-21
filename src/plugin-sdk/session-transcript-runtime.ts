import {
  appendTranscriptMessage,
  publishTranscriptUpdate,
  resolveSessionTranscriptRuntimeReadTarget,
  resolveSessionTranscriptRuntimeTarget,
  type TranscriptMessageAppendOptions,
  type TranscriptMessageAppendResult,
  type TranscriptUpdatePayload,
} from "../config/sessions/session-accessor.js";
import { runSessionTranscriptAppendTransaction } from "../config/sessions/transcript-append.js";
import { streamSessionTranscriptLines } from "../config/sessions/transcript-stream.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  formatSessionTranscriptMemoryHitKey,
  parseSessionTranscriptMemoryHitKey,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys,
  type ResolveSessionTranscriptMemoryHitKeyParams,
  type SessionTranscriptIdentity,
  type SessionTranscriptMemoryHitIdentity,
  type SessionTranscriptMemoryHitKey,
  type SessionTranscriptMemoryHitKeyParams,
  type SessionTranscriptReadParams,
} from "./session-transcript-memory-hit.js";

export {
  formatSessionTranscriptMemoryHitKey,
  parseSessionTranscriptMemoryHitKey,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys,
};
export type {
  ResolveSessionTranscriptMemoryHitKeyParams,
  SessionTranscriptIdentity,
  SessionTranscriptMemoryHitIdentity,
  SessionTranscriptMemoryHitKey,
  SessionTranscriptMemoryHitKeyParams,
  SessionTranscriptReadParams,
};

export type SessionTranscriptEvent = unknown;

export type SessionTranscriptTargetParams = SessionTranscriptReadParams & {
  /**
   * @deprecated Prefer `{ agentId, sessionKey, sessionId }`. Pass this only
   * when adapting code that already receives an active transcript artifact and
   * needs each helper to operate on that same artifact.
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

/**
 * Resolves the public identity for a transcript without returning its file path.
 */
export async function resolveSessionTranscriptIdentity(
  params: SessionTranscriptReadParams,
): Promise<SessionTranscriptIdentity> {
  const target = await resolveSessionTranscriptRuntimeReadTarget(params);
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
  const target = await resolveSessionTranscriptRuntimeReadTarget(params);
  return projectPublicTarget({
    ...target,
    targetKind: params.sessionFile?.trim() ? "active-session-file" : "runtime-session",
  });
}

/**
 * Reads transcript events by public session identity instead of file path.
 */
export async function readSessionTranscriptEvents(
  params: SessionTranscriptTargetParams,
): Promise<SessionTranscriptEvent[]> {
  const target = await resolveSessionTranscriptRuntimeReadTarget(params);
  const events: SessionTranscriptEvent[] = [];
  for await (const line of streamSessionTranscriptLines(target.sessionFile)) {
    try {
      events.push(JSON.parse(line) as SessionTranscriptEvent);
    } catch {
      continue;
    }
  }
  return events;
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
  const target = await resolveSessionTranscriptRuntimeTarget(params);
  await publishTranscriptUpdate(
    {
      ...params,
      sessionFile: target.sessionFile,
    },
    {
      ...params.update,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
    },
  );
}

/**
 * Runs transcript work under the write lock for the resolved scoped target.
 */
export async function withSessionTranscriptWriteLock<T>(
  params: SessionTranscriptWriteLockParams,
  run: (context: SessionTranscriptWriteLockContext) => Promise<T> | T,
): Promise<T> {
  const storageTarget = await resolveSessionTranscriptRuntimeTarget(params);
  const target = projectPublicTarget({
    ...storageTarget,
    targetKind: params.sessionFile?.trim() ? "active-session-file" : "runtime-session",
  });
  const boundScope = {
    ...params,
    sessionFile: storageTarget.sessionFile,
  };
  // Treat publishUpdate as a post-commit callback: future transactional stores
  // must not expose updates when the scoped write callback fails.
  const queuedUpdates: Array<TranscriptUpdatePayload | undefined> = [];
  const result = await runSessionTranscriptAppendTransaction(
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
        publishUpdate: async (update) => {
          queuedUpdates.push(update ? { ...update } : undefined);
        },
      }),
  );
  for (const update of queuedUpdates) {
    await publishSessionTranscriptUpdateByIdentity({
      ...boundScope,
      update,
    });
  }
  return result;
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
