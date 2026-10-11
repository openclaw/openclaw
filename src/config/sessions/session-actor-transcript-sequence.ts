import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { publishTranscriptUpdate } from "./session-accessor.sqlite-events.js";
import { appendExpectedSessionTranscriptTurn } from "./session-accessor.sqlite-transcript-turn.js";
import type {
  LockedTranscriptMessageAppendOptions,
  SessionTranscriptWriteLockAccessorContext,
  SessionTranscriptWriteScope,
  TranscriptMessageAppendResult,
} from "./session-accessor.types.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import type { SessionTranscriptReadSnapshot } from "./session-history-read.types.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import { withTranscriptLockSettlement } from "./session-transcript-lock-settlement.js";
import { assertLegacyTranscriptPreparation } from "./session-transcript-preparation.js";
import {
  captureOwnedTranscriptWriteAssertion,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

/** Detached callbacks share the existing turn owner; only a rewrite retains a read snapshot. */
export function withActorTranscriptWriteSequence<T>(
  requestedScope: SessionTranscriptWriteScope,
  binding: SessionActorStorageBinding,
  run: (context: SessionTranscriptWriteLockAccessorContext) => Promise<T> | T,
): Promise<T> {
  const fenced = withOwnedSessionTranscriptWriterFence(requestedScope);
  const sessionId = fenced.sessionId ?? binding.actor.snapshot(binding.authority)?.entry?.sessionId;
  if (!sessionId) {
    throw new Error("Transcript write requires its selected session window");
  }
  const scope = { ...fenced, sessionId, agentId: binding.agentId, storePath: binding.path };
  const assertOwned = captureOwnedTranscriptWriteAssertion(scope);
  const authority = {
    ...binding.authority,
    assertCurrent() {
      binding.authority.assertCurrent();
      binding.actor.assertReadable();
      assertOwned();
    },
  };
  let expected: SessionTranscriptContextVersion | undefined;
  let snapshot: SessionTranscriptReadSnapshot | undefined;
  let stale = false;
  const observe = (version: SessionTranscriptContextVersion) => {
    if (stale || (expected && !isDeepStrictEqual(expected, version))) {
      throw new SqliteTranscriptMutationConflictError(sessionId);
    }
    expected = version;
  };
  const read = async () => {
    const value = await binding.actor.storage!.read(
      { type: "session.history.hydrate", input: { sessionId } },
      authority,
    );
    if (value.kind !== "full") {
      throw new Error("Transcript write requires complete owned history");
    }
    observe(value.snapshot.version);
    snapshot = value.snapshot;
    return value.snapshot.events;
  };
  const append = async <M>(requested: LockedTranscriptMessageAppendOptions<M>) => {
    assertLegacyTranscriptPreparation(scope, requested);
    if (
      stale ||
      (expected &&
        requested.expectedTranscript &&
        !isDeepStrictEqual(expected, requested.expectedTranscript))
    ) {
      throw new SqliteTranscriptMutationConflictError(sessionId);
    }
    const {
      prepareMessageAfterIdempotencyCheckAsync,
      prepareMessageAfterIdempotencyCheck: _legacy,
      beforeFreshMessageCommit: _legacyGuard,
      preparation,
      ...options
    } = requested;
    const prepare = preparation?.prepareMessage ?? prepareMessageAfterIdempotencyCheckAsync;
    const result = await appendExpectedSessionTranscriptTurn(scope, {
      expectedSessionId: sessionId,
      keyFormat: "agent-qualified",
      sessionFile: sessionId,
      expectedLifecycleRevision: scope.expectedLifecycleRevision,
      expectedWriterRunId: scope.expectedWriterRunId,
      expectedOwner: scope.expectedOwner,
      assertCurrent: () => authority.assertCurrent(),
      messages: [
        {
          ...options,
          expectedTranscript: expected ?? requested.expectedTranscript,
          preparation: {
            // SAFETY: The turn prepares the typed message supplied by this invocation.
            ...(prepare ? { prepareMessage: (message: unknown) => prepare(message as M) } : {}),
            source: preparation?.source,
          },
        },
      ],
    });
    if (result.rejectedReason || !result.transcriptVersion) {
      throw new Error("Transcript session changed before append");
    }
    // SAFETY: The canonical append contract returns this message's persisted or replayed shape.
    const message = result.appendedMessages[0] as TranscriptMessageAppendResult<M> | undefined;
    if (message?.appended || !expected) {
      expected = result.transcriptVersion;
    } else {
      stale = !isDeepStrictEqual(expected, result.transcriptVersion);
    }
    snapshot = undefined;
    return {
      result: message,
      lifecycleRevision: result.sessionEntry?.lifecycleRevision,
      ...(message?.anchor ? { messageSeq: message.anchor.activeMessagePosition + 1 } : {}),
    };
  };
  return runWithSessionActorStorage(binding, () =>
    withTranscriptLockSettlement((enqueue) => {
      const queue = AsyncLocalStorage.bind(enqueue);
      return run({
        readEvents: () => queue(read),
        readMessageFacts: (input) =>
          queue(async () => {
            const result = await binding.actor.storage!.read(
              { type: "session.transcript.messageFacts", input: { ...input, scope } },
              authority,
            );
            observe(result.version);
            return result.facts;
          }),
        replaceEvents: (events) =>
          queue(async () => {
            if (stale) {
              throw new SqliteTranscriptMutationConflictError(sessionId);
            }
            if (!snapshot) {
              await read();
            }
            const result = readSessionActorStorageResult(
              await binding.actor.storage!.mutate(
                {
                  type: "session.transcript.replaceSuffix",
                  input: {
                    scope,
                    args: [snapshot!.events, events, 0, expected?.updatedAt, false, []],
                  },
                },
                authority,
              ),
            );
            if (!result.replaced || !result.version) {
              throw new SqliteTranscriptMutationConflictError(sessionId);
            }
            expected = result.version;
            snapshot = { events: [...events], version: result.version };
          }),
        appendMessage: (options) => queue(async () => (await append(options)).result),
        appendMessageWithMessageSequence: (options) => queue(() => append(options)),
        publishUpdate: (update) =>
          queue(async () => {
            authority.assertCurrent();
            await publishTranscriptUpdate(scope, update);
          }),
      });
    }),
  );
}
