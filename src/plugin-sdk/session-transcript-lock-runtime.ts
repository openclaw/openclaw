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
import {
  assertOwnedTranscriptWriteCommit,
  withSessionTranscriptWriteAssertion,
} from "../config/sessions/transcript-write-context.js";
import { warnSessionTranscriptPreparationDeprecation } from "../plugins/compat/session-transcript-preparation-deprecation.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { projectSessionTranscriptAppendOptions } from "./session-transcript-append-options.js";
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
   * Guards every commit. Only the omitted agent is inferred; the original locator is retained.
   * It is prepared before the
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
  legacyMethod:
    | "withSessionTranscriptWriteLock"
    | "withCodexSessionTranscriptMirrorWriteLock" = "withSessionTranscriptWriteLock",
): Promise<T> {
  const { assertCurrent, ...scope } = params;
  if (mode === "lock") {
    assertLegacyTranscriptPreparation(params);
    warnSessionTranscriptPreparationDeprecation(
      legacyMethod,
      legacyMethod === "withCodexSessionTranscriptMirrorWriteLock"
        ? "withCodexSessionTranscriptMirrorWrite"
        : "withSessionTranscriptWrite",
    );
  }
  const storageTarget = await resolveSessionTranscriptRuntimeTarget(scope, scope.config);
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
    appendMessage: (options) =>
      whileOpen(() => locked.appendMessage(projectSessionTranscriptAppendOptions(options))),
    appendMessageWithMessageSequence: (options) =>
      whileOpen(() =>
        locked.appendMessageWithMessageSequence(projectSessionTranscriptAppendOptions(options)),
      ),
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
      ? withSessionTranscriptWriteAssertion({ ...scope, agentId }, assertCurrent, () => {
          assertOwnedTranscriptWriteCommit(writeScope);
          return writeMode(writeScope, writeRun);
        })
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
                ...projectSessionTranscriptAppendOptions(options),
                ...(scope.config !== undefined ? { config: scope.config } : {}),
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
