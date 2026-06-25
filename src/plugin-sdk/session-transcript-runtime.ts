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
import {
  appendAssistantMessageToSessionTranscript,
  readLatestAssistantTextFromSessionTranscript,
  type LatestAssistantTranscriptText,
  type SessionTranscriptAppendResult,
  type SessionTranscriptDeliveryMirror,
  type SessionTranscriptUpdateMode,
} from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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

export type SessionTranscriptLegacyFileTarget = SessionTranscriptTarget & {
  /**
   * Deprecated transitional file target for callers that still pass active
   * transcript files to plugin command handlers.
   */
  sessionFile: string;
};

export type SessionTranscriptAppendMessageParams<TMessage> = SessionTranscriptTargetParams &
  TranscriptMessageAppendOptions<TMessage>;

export type SessionTranscriptAssistantMirrorAppendParams = SessionTranscriptReadParams & {
  config?: OpenClawConfig;
  deliveryMirror?: SessionTranscriptDeliveryMirror;
  idempotencyKey?: string;
  mediaUrls?: string[];
  text?: string;
  updateMode?: SessionTranscriptUpdateMode;
};

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
 * Resolves and persists the current file-backed target for legacy plugin
 * command calls that still require `sessionFile`.
 */
export async function resolveSessionTranscriptLegacyFileTarget(
  params: SessionTranscriptTargetParams,
): Promise<SessionTranscriptLegacyFileTarget> {
  const target = await resolveSessionTranscriptRuntimeTarget(params);
  return {
    ...projectPublicTarget({
      ...target,
      targetKind: params.sessionFile?.trim() ? "active-session-file" : "runtime-session",
    }),
    sessionFile: target.sessionFile,
  };
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
 * Reads the latest visible assistant text by scoped identity using the
 * bounded reverse transcript reader.
 */
export async function readLatestAssistantTextByIdentity(
  params: SessionTranscriptTargetParams,
): Promise<LatestAssistantTranscriptText | undefined> {
  const target = await resolveSessionTranscriptRuntimeReadTarget(params);
  return await readLatestAssistantTextFromSessionTranscript(target.sessionFile);
}

/**
 * Appends a delivery-mirror assistant message through the guarded session
 * append facade.
 */
export async function appendAssistantMirrorMessageByIdentity(
  params: SessionTranscriptAssistantMirrorAppendParams,
): Promise<SessionTranscriptAppendResult> {
  return await appendAssistantMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    expectedSessionId: params.sessionId,
    ...(params.text !== undefined ? { text: params.text } : {}),
    ...(params.mediaUrls !== undefined ? { mediaUrls: params.mediaUrls } : {}),
    ...(params.idempotencyKey !== undefined ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(params.deliveryMirror !== undefined ? { deliveryMirror: params.deliveryMirror } : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
    ...(params.updateMode !== undefined ? { updateMode: params.updateMode } : {}),
    ...(params.config !== undefined ? { config: params.config } : {}),
  });
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
