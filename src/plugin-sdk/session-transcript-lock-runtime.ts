import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import {
  resolveSessionTranscriptRuntimeTarget,
  withTranscriptWriteLock,
  withTranscriptWriteSequence,
  type SessionTranscriptWriteLockAccessorContext,
  type TranscriptMessageAppendOptions,
  type TranscriptMessageAppendResult,
  type TranscriptUpdatePayload,
} from "../config/sessions/session-accessor.js";
import type { LockedTranscriptMessageAppendOptions } from "../config/sessions/session-accessor.types.js";
import { assertLegacyTranscriptPreparation } from "../config/sessions/session-transcript-preparation.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  formatSessionTranscriptMemoryHitKey,
  type SessionTranscriptMemoryHitKey,
  type SessionTranscriptReadParams,
} from "./session-transcript-memory-hit.js";

export type InternalSessionTranscriptTarget = {
  agentId: string;
  memoryKey: SessionTranscriptMemoryHitKey;
  sessionId: string;
  sessionKey: string;
  targetKind: "runtime-session";
};

export type InternalSessionTranscriptWriteLockParams = SessionTranscriptReadParams & {
  config?: TranscriptMessageAppendOptions<unknown>["config"];
};

export type InternalSessionTranscriptWriteLockContext = {
  appendMessage: <TMessage>(
    options: Omit<LockedTranscriptMessageAppendOptions<TMessage>, "config">,
  ) => Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
  publishUpdate: (update?: TranscriptUpdatePayload) => Promise<void>;
  readEvents: () => Promise<unknown[]>;
  target: InternalSessionTranscriptTarget;
};

/** Resolves, locks, and publishes one projected transcript write context. */
export async function withProjectedSessionTranscriptWriteLock<
  T,
  TContext extends InternalSessionTranscriptWriteLockContext,
>(
  params: InternalSessionTranscriptWriteLockParams,
  run: (context: TContext) => Promise<T> | T,
  projectContext: (
    context: InternalSessionTranscriptWriteLockContext,
    locked: SessionTranscriptWriteLockAccessorContext,
  ) => TContext,
  mode: "lock" | "sequence" = "lock",
): Promise<T> {
  if (mode === "lock") {
    assertLegacyTranscriptPreparation(params);
  }
  const storageTarget = await resolveSessionTranscriptRuntimeTarget(params, params.config);
  const agentId = normalizeAgentId(storageTarget.agentId);
  const target: InternalSessionTranscriptTarget = {
    agentId,
    memoryKey: formatSessionTranscriptMemoryHitKey({
      agentId,
      sessionId: storageTarget.sessionId,
    }),
    sessionId: storageTarget.sessionId,
    sessionKey: storageTarget.sessionKey,
    targetKind: "runtime-session",
  };
  const boundScope = {
    ...params,
    ...storageTarget,
  };
  // Keep the selected store and owner through awaits and publication. Individual appends
  // commit independently, but a failed callback must not publish its queued updates.
  const queuedUpdates: Array<TranscriptUpdatePayload | undefined> = [];
  let callbackClosed = false;
  const whileOpen = <R>(operation: () => Promise<R>): Promise<R> => {
    if (callbackClosed) {
      return Promise.reject(new Error("Transcript write context is closed"));
    }
    return operation();
  };
  const guardProjectedContext = (
    locked: SessionTranscriptWriteLockAccessorContext,
  ): SessionTranscriptWriteLockAccessorContext => ({
    publishUpdate: (update) => whileOpen(() => locked.publishUpdate(update)),
    readEvents: () => whileOpen(locked.readEvents),
    readMessageFacts: (query) => whileOpen(() => locked.readMessageFacts(query)),
    replaceEvents: (events) => whileOpen(() => locked.replaceEvents(events)),
    appendMessage: (options) => whileOpen(() => locked.appendMessage(options)),
    appendMessageWithMessageSequence: (options) =>
      whileOpen(() => locked.appendMessageWithMessageSequence(options)),
  });
  const runOpen = async (context: TContext) => {
    try {
      const result = run(context);
      if (!isPromiseLike(result)) {
        callbackClosed = true;
      }
      return await result;
    } finally {
      callbackClosed = true;
    }
  };
  const write = mode === "sequence" ? withTranscriptWriteSequence : withTranscriptWriteLock;
  return await write(boundScope, async (locked) => {
    const result = await runOpen(
      projectContext(
        {
          target,
          readEvents: () => whileOpen(locked.readEvents),
          appendMessage: (options) =>
            whileOpen(() =>
              locked.appendMessage({
                ...options,
                ...(params.config !== undefined ? { config: params.config } : {}),
              }),
            ),
          publishUpdate: (update) =>
            whileOpen(async () => {
              queuedUpdates.push(update ? { ...update } : undefined);
            }),
        },
        guardProjectedContext(locked),
      ),
    );
    for (const update of queuedUpdates) {
      await locked.publishUpdate(update);
    }
    return result;
  });
}
