import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { publishTranscriptUpdate } from "./session-accessor.sqlite-events.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readCommittedTranscriptMessageSequence } from "./session-accessor.sqlite-transcript-sequences.js";
import { appendExpectedSessionTranscriptTurn } from "./session-accessor.sqlite-transcript-turn.js";
import type {
  SessionTranscriptWriteScope,
  SessionTranscriptWriteLockAccessorContext,
  LockedTranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
} from "./session-accessor.types.js";
import {
  withIncognitoSessionBinding,
  type captureIncognitoSessionOperation,
} from "./session-incognito-binding.js";
import type { IncognitoTranscriptLockOperations } from "./session-incognito-transcript-lock-contract.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import {
  acceptSessionSourceValidation,
  prepareSessionSourceAuthority,
  releaseSessionSourceAuthorities,
  type PreparedSessionSourceAuthority,
} from "./session-source-authority.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import { withTranscriptLockSettlement } from "./session-transcript-lock-settlement.js";
import type { RefusedTranscriptOwnerSource } from "./session-transcript-mutation.types.js";
import { assertLegacyTranscriptPreparation } from "./session-transcript-preparation.js";
import {
  captureOwnedTranscriptWriteAssertion,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

/** Each operation owns a FIFO turn; detached callbacks never hold a worker transaction. */
export function withIncognitoTranscriptWriteSequence<T>(
  scope: SessionTranscriptWriteScope,
  binding: NonNullable<ReturnType<typeof captureIncognitoSessionOperation>>,
  run: (context: SessionTranscriptWriteLockAccessorContext) => Promise<T> | T,
): Promise<T> {
  binding.authority.assertCurrent();
  const fenced = withOwnedSessionTranscriptWriterFence(scope);
  const assertOwned = captureOwnedTranscriptWriteAssertion(fenced);
  const resolved = resolveSqliteTranscriptScope(fenced);
  const { actor } = binding;
  const target: IncognitoTranscriptLockOperations["session.lock.events"]["input"] = {
    sessionKey: resolved.sessionKey,
    sessionId: resolved.sessionId,
    fence: {
      expectedLifecycleRevision: fenced.expectedLifecycleRevision,
      expectedWriterRunId: fenced.expectedWriterRunId,
      expectedOwner: fenced.expectedOwner,
    },
  };
  let ownerSource: PreparedSessionSourceAuthority;
  const authority = {
    assertCurrent: () => {
      binding.authority.assertCurrent();
      (ownerSource.assertPreparedCurrent ?? ownerSource.assertCurrent)();
    },
  };
  function refuseOwner(refusal: RefusedTranscriptOwnerSource["refusedOwnerSource"]): never {
    ownerSource.checks[refusal.index]?.refuse(refusal.facts);
    throw new Error("Transcript owner source refusal omitted its prepared assertion");
  }
  let expected: SessionTranscriptContextVersion | undefined;
  let stale = false;
  const observe = (version: SessionTranscriptContextVersion) => {
    if (stale || (expected && !isDeepStrictEqual(expected, version))) {
      throw new SqliteTranscriptMutationConflictError(resolved.sessionId);
    }
    expected = version;
  };
  const append = <M>(requested: LockedTranscriptMessageAppendOptions<M>) =>
    withIncognitoSessionBinding(binding, async () => {
      assertLegacyTranscriptPreparation(fenced, requested);
      if (
        stale ||
        (expected &&
          requested.expectedTranscript &&
          !isDeepStrictEqual(expected, requested.expectedTranscript))
      ) {
        throw new SqliteTranscriptMutationConflictError(resolved.sessionId);
      }
      const {
        preparation,
        prepareMessageAfterIdempotencyCheckAsync,
        prepareMessageAfterIdempotencyCheck: _legacyPrepare,
        beforeFreshMessageCommit: _legacyGuard,
        ...options
      } = requested;
      const prepare = preparation?.prepareMessage ?? prepareMessageAfterIdempotencyCheckAsync;
      const result = await appendExpectedSessionTranscriptTurn(fenced, {
        expectedSessionId: resolved.sessionId,
        keyFormat: "agent-qualified",
        sessionFile: resolved.sessionKey,
        expectedLifecycleRevision: fenced.expectedLifecycleRevision,
        expectedWriterRunId: fenced.expectedWriterRunId,
        expectedOwner: fenced.expectedOwner,
        assertCurrent: authority.assertCurrent,
        ownerSource,
        messages: [
          {
            ...options,
            expectedTranscript: expected ?? requested.expectedTranscript,
            preparation: {
              // SAFETY: This preparer receives the message supplied by this typed invocation.
              ...(prepare ? { prepareMessage: (message: unknown) => prepare(message as M) } : {}),
              source: preparation?.source,
            },
          },
        ],
      });
      if (result.rejectedReason) {
        throw new Error("Transcript session changed before append");
      }
      // SAFETY: The turn commits or replays this invocation's message under its append contract.
      const message = result.appendedMessages[0] as TranscriptMessageAppendResult<M> | undefined;
      if (!result.transcriptVersion) {
        throw new Error("Incognito transcript commit omitted its version receipt");
      }
      if (message?.appended || !expected) {
        expected = result.transcriptVersion;
      } else {
        stale = !isDeepStrictEqual(expected, result.transcriptVersion);
      }
      return {
        result: message,
        lifecycleRevision: result.sessionEntry?.lifecycleRevision,
        ...(message && { messageSeq: readCommittedTranscriptMessageSequence(message) }),
      };
    });
  return actor.sessions.withSharedState(async () => {
    ownerSource = await prepareSessionSourceAuthority(assertOwned);
    const failures: unknown[] = [];
    try {
      if (
        ownerSource.nativeSource ||
        ownerSource.hasOpaqueCheck ||
        ownerSource.checks.some(
          ({ predicate }) =>
            predicate.source.path !== actor.path ||
            predicate.source.agentId !== actor.agentId ||
            predicate.source.databaseIdentity !== actor.identity.incarnation,
        )
      ) {
        throw new Error(
          "Actor transcript writes require owner authority prepared for the same actor",
        );
      }
      target.ownerSources = ownerSource.checks.map(({ predicate }) => predicate);
      authority.assertCurrent();
      return await withTranscriptLockSettlement((enqueue) => {
        const queue = AsyncLocalStorage.bind(enqueue);
        return run({
          publishUpdate: (update) =>
            queue(async () => {
              let publication: Promise<void> | undefined;
              await actor.sessions.transcript(
                authority,
                { type: "session.lock.facts", input: { ...target, idempotencyKeys: [] } },
                undefined,
                undefined,
                undefined,
                (read) => {
                  if ("refusedOwnerSource" in read) {
                    refuseOwner(read.refusedOwnerSource);
                  }
                  acceptSessionSourceValidation(ownerSource, read.sourceValidation);
                  authority.assertCurrent();
                  publication = publishTranscriptUpdate(fenced, update);
                },
              );
              if (!publication) {
                throw new Error("Actor transcript publication omitted its source validation");
              }
              await publication;
            }),
          readEvents: () =>
            queue(async () => {
              const read = await actor.sessions.transcript(
                authority,
                { type: "session.lock.events", input: target },
                binding.admissionSignal,
              );
              if ("refusedOwnerSource" in read) {
                return refuseOwner(read.refusedOwnerSource);
              }
              acceptSessionSourceValidation(ownerSource, read.sourceValidation);
              authority.assertCurrent();
              observe(read.version);
              return read.events;
            }),
          readMessageFacts: (query) =>
            queue(async () => {
              const read = await actor.sessions.transcript(
                authority,
                {
                  type: "session.lock.facts",
                  input: { ...target, idempotencyKeys: query.idempotencyKeys },
                },
                binding.admissionSignal,
              );
              if ("refusedOwnerSource" in read) {
                return refuseOwner(read.refusedOwnerSource);
              }
              acceptSessionSourceValidation(ownerSource, read.sourceValidation);
              authority.assertCurrent();
              observe(read.version);
              return read.facts;
            }),
          replaceEvents: (events) =>
            queue(async () => {
              binding.admissionSignal?.throwIfAborted();
              if (stale) {
                throw new SqliteTranscriptMutationConflictError(resolved.sessionId);
              }
              if (!expected) {
                const read = await actor.sessions.transcript(
                  authority,
                  { type: "session.lock.events", input: target },
                  binding.admissionSignal,
                );
                if ("refusedOwnerSource" in read) {
                  refuseOwner(read.refusedOwnerSource);
                }
                acceptSessionSourceValidation(ownerSource, read.sourceValidation);
                authority.assertCurrent();
                observe(read.version);
              }
              binding.admissionSignal?.throwIfAborted();
              const replaced = await actor.sessions.transcript(
                authority,
                {
                  type: "session.lock.replace",
                  input: { ...target, events, expected: expected! },
                },
                undefined,
                undefined,
                undefined,
                undefined,
                (_refused, validation) => {
                  acceptSessionSourceValidation(ownerSource, validation);
                  authority.assertCurrent();
                },
              );
              if ("refusedOwnerSource" in replaced) {
                refuseOwner(replaced.refusedOwnerSource);
              }
              expected = replaced;
            }),
          appendMessage: (options) => queue(async () => (await append(options)).result),
          appendMessageWithMessageSequence: (options) => queue(() => append(options)),
        });
      });
    } catch (error) {
      failures.push(error);
      throw error;
    } finally {
      await releaseSessionSourceAuthorities([ownerSource], failures);
    }
  });
}
