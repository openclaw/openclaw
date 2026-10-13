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
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { assertLegacyTranscriptPreparation } from "../config/sessions/session-transcript-preparation.js";
import { withSessionTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
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
  /**
   * Guards every commit. It is installed on the resolved target and prepared before the
   * writer is reserved: its session-row reads cannot run while the write holds the store.
   */
  assertCurrent?: SessionSourceAssertion;
};

export type InternalSessionTranscriptWriteLockContext = {
  appendMessage: <TMessage>(
    options: Omit<LockedTranscriptMessageAppendOptions<TMessage>, "config">,
  ) => Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
  publishUpdate: (update?: TranscriptUpdatePayload) => Promise<void>;
  readEvents: () => Promise<unknown[]>;
  readMessageFacts: SessionTranscriptWriteLockAccessorContext["readMessageFacts"];
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
  const { assertCurrent, ...scope } = params;
  const boundScope = {
    ...scope,
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
  const writeMode = mode === "sequence" ? withTranscriptWriteSequence : withTranscriptWriteLock;
  const write: typeof writeMode = (writeScope, writeRun) =>
    assertCurrent
      ? withSessionTranscriptWriteAssertion(writeScope, assertCurrent, () =>
          writeMode(writeScope, writeRun),
        )
      : writeMode(writeScope, writeRun);
  return await write(boundScope, async (locked) => {
    const result = await runOpen(
      projectContext(
        {
          target,
          readEvents: () => whileOpen(locked.readEvents),
          readMessageFacts: (query) => whileOpen(() => locked.readMessageFacts(query)),
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
