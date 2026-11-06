import { isMainThread } from "node:worker_threads";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import type {
  SessionTranscriptAccessScope,
  SessionTranscriptWriteScope,
  TranscriptEvent,
  TranscriptEventAppendOptions,
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
} from "./session-accessor.sqlite-contract.js";
import { publishTranscriptUpdate } from "./session-accessor.sqlite-events.js";
import {
  assertSqliteTranscriptSnapshotUnchanged,
  isSqliteTranscriptSnapshotUnchanged,
  readTranscriptEventRows,
  readTranscriptSnapshot,
  type SqliteTranscriptSnapshotRow,
  type SqliteTranscriptSnapshotState,
} from "./session-accessor.sqlite-read.js";
import {
  captureLifecycleDatabaseScope,
  assertSqliteTranscriptWriteIdentity,
  withPreparedSqliteScope,
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import { readTranscriptMirrorFacts } from "./session-accessor.sqlite-transcript-mirror.js";
import { resolveTranscriptEventAppendParent } from "./session-accessor.sqlite-transcript-parent.js";
import {
  readCommittedTranscriptMessageSequence,
  rememberCommittedTranscriptMessageSequencesInTransaction,
} from "./session-accessor.sqlite-transcript-sequences.js";
import { readTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventInTransaction,
  replaceSqliteTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import {
  assertNonMessageTranscriptEvent,
  assertLockedTranscriptWriteAllowed,
} from "./session-accessor.sqlite-transcript-write-guard.js";
import { prepareNativeLockedAppend } from "./session-accessor.sqlite-transcript-write-snapshot.js";
import type { SessionTranscriptWriteLockAccessorContext } from "./session-accessor.types.js";
import { withSessionActorStorage } from "./session-actor-storage-acquisition.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import { readTranscriptAppendPostimage } from "./session-transcript-append-postimage.js";
import { withTranscriptLockSettlement } from "./session-transcript-lock-settlement.js";
import { assertLegacyTranscriptPreparation } from "./session-transcript-preparation.js";
import {
  assertOwnedTranscriptWriteCommit,
  captureOwnedTranscriptWriteAssertion,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

/** Rewrites exact transcript rows after atomically validating their generation and bytes. */
export async function rewriteTranscriptEventRowsExact(
  scope: SessionTranscriptAccessScope,
  params: {
    expectedGeneration: string | null;
    rows: readonly { event: TranscriptEvent; expectedEventJson: string; seq: number }[];
  },
): Promise<{ generation: string } | null> {
  if (params.rows.length === 0) {
    return null;
  }
  assertSqliteTranscriptWriteIdentity(scope);
  return withPreparedSqliteScope(scope, async (prepared) => {
    const resolved = { ...prepared, sessionId: scope.sessionId };
    const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
    await restoreSessionColdTranscript({ ...scope, sessionId: resolved.sessionId });
    return await runExclusiveSqliteSessionWrite(
      resolved,
      async () =>
        runOpenClawAgentWriteTransaction(
          (database) => {
            const currentGeneration =
              readTranscriptGenerationInTransaction(database, resolved.sessionId) ?? null;
            if (currentGeneration !== params.expectedGeneration) {
              return null;
            }
            rewriteSqliteTranscriptEventRowsInTransaction(database, resolved, params.rows);
            const generation = readTranscriptGenerationInTransaction(database, resolved.sessionId);
            return generation ? { generation } : null;
          },
          toDatabaseOptions(resolved),
          { operationLabel: "session.transcript.rewrite-exact" },
        ),
      "session.transcript.rewrite-exact",
    );
  });
}

export { replaceTranscriptSuffixEventsSync } from "./session-accessor.sqlite-transcript-suffix-write.js";

/** Appends one raw transcript event to the additive SQLite transcript store. */
export async function appendTranscriptEvent(
  scope: SessionTranscriptAccessScope,
  event: TranscriptEvent,
  options: TranscriptEventAppendOptions = {},
): Promise<boolean> {
  assertNonMessageTranscriptEvent(event);
  assertSqliteTranscriptWriteIdentity(scope);
  return withPreparedSqliteScope(scope, async (prepared) => {
    const resolved = { ...prepared, sessionId: scope.sessionId };
    if (isMainThread && supportsOpenClawAgentDatabaseExecution(toDatabaseOptions(resolved))) {
      if (options.beforeCommitInTransaction) {
        throw new Error(
          "Transcript transaction callbacks require worker-local execution; use a prepared transcript event",
        );
      }
      const { appendTranscriptEventInWorker } = await import("./session-transcript-event.js");
      return appendTranscriptEventInWorker({
        scope: captureLifecycleDatabaseScope(resolved),
        event,
        appendIntent: options.appendIntent,
      });
    }
    const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
    await restoreSessionColdTranscript({ ...scope, sessionId: resolved.sessionId });
    return runExclusiveSqliteSessionWrite(
      resolved,
      async () => {
        return runOpenClawAgentWriteTransaction(
          (database) => {
            options.beforeCommitInTransaction?.();
            return (
              appendTranscriptEventInTransaction(
                database,
                resolved,
                resolveTranscriptEventAppendParent(database, resolved.sessionId, event, options),
              ) !== false
            );
          },
          toDatabaseOptions(resolved),
          { operationLabel: "session.transcript.event-append" },
        );
      },
      "session.transcript.event-append",
    );
  });
}

/** Appends one transcript message to the additive SQLite transcript store. */
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
  assertLegacyTranscriptPreparation(scope, options);
  return await withTranscriptWriteSequence(scope, (transcript) =>
    transcript.appendMessage(options),
  );
}

/** Runs read/append transcript work under one SQLite writer-queue critical section. */
export async function withTranscriptWriteLock<T>(
  scope: SessionTranscriptWriteScope,
  run: (context: SessionTranscriptWriteLockAccessorContext) => Promise<T> | T,
): Promise<T> {
  assertLegacyTranscriptPreparation(scope);
  return withHostTranscriptWriteLock(scope, run);
}

/** Memory sequences retain their actor; durable sequences use the existing worker route. */
export async function withTranscriptWriteSequence<T>(
  scope: SessionTranscriptWriteScope,
  run: (context: SessionTranscriptWriteLockAccessorContext) => Promise<T> | T,
): Promise<T> {
  const assertCurrent = captureOwnedTranscriptWriteAssertion(scope);
  const authority = { assertCurrent, authorize: assertCurrent };
  if (!captureSessionActorStorageOwner(scope, authority)) {
    return withHostTranscriptWriteLock(scope, run);
  }
  const { withActorTranscriptWriteSequence } =
    await import("./session-actor-transcript-sequence.js");
  const result = await withSessionActorStorage(
    scope,
    { authority, lifetime: { assertCurrent, assertReadable: assertCurrent } },
    async (memory) => ({ value: await withActorTranscriptWriteSequence(scope, memory, run) }),
  );
  if (!result) {
    throw new Error("Session transcript window is unavailable");
  }
  return result.value;
}

async function withHostTranscriptWriteLock<T>(
  scope: SessionTranscriptWriteScope,
  run: (context: SessionTranscriptWriteLockAccessorContext) => Promise<T> | T,
): Promise<T> {
  const fenced = withOwnedSessionTranscriptWriterFence(scope);
  assertSqliteTranscriptWriteIdentity(fenced);
  return withPreparedSqliteScope(fenced, async (prepared) => {
    const resolved = { ...prepared, sessionId: fenced.sessionId };
    if (!isMainThread || !supportsOpenClawAgentDatabaseExecution(toDatabaseOptions(resolved))) {
      return runNativeTranscriptWriteLock(fenced, run);
    }
    const captured = captureLifecycleDatabaseScope(resolved);
    const { withWorkerTranscriptWriteLock } = await import("./session-transcript-locked-write.js");
    // Physical admission uses captured.path; writer authority retains the captured selector.
    return withWorkerTranscriptWriteLock(
      { ...fenced, ...captured, storePath: captured.path },
      { ...fenced, ...captured, storePath: captured.ownerStorePath ?? captured.path },
      run,
      runNativeTranscriptWriteLock,
    );
  });
}

async function runNativeTranscriptWriteLock<T>(
  scope: SessionTranscriptWriteScope,
  run: (context: SessionTranscriptWriteLockAccessorContext) => Promise<T> | T,
  alreadyLocked = false,
  initialSnapshot?: SqliteTranscriptSnapshotState,
  onSnapshot?: (snapshot: SqliteTranscriptSnapshotState | undefined) => void,
  ownerScope: SessionTranscriptWriteScope = scope,
): Promise<T> {
  const fencedScope = withOwnedSessionTranscriptWriterFence(ownerScope);
  const resolved = resolveSqliteTranscriptScope(scope);
  // Nested compatibility appends share the worker callback's initial cold restoration.
  if (!alreadyLocked) {
    const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
    await restoreSessionColdTranscript({ ...scope, sessionId: resolved.sessionId });
  }
  const databaseOptions = toDatabaseOptions(resolved);
  const acquire: typeof runExclusiveSqliteSessionWrite = alreadyLocked
    ? async (_scope, operation) => operation()
    : runExclusiveSqliteSessionWrite;
  return await acquire(
    resolved,
    async () => {
      let transcriptSnapshot = initialSnapshot;
      const context: SessionTranscriptWriteLockAccessorContext = {
        publishUpdate: async (update) => {
          assertOwnedTranscriptWriteCommit(fencedScope);
          await publishTranscriptUpdate(scope, update);
        },
        readEvents: async () => {
          // openclaw-agent-db.ts cache rule: LRU eviction closes idle handles across caller awaits.
          const database = openOpenClawAgentDatabase(databaseOptions);
          const snapshot = readTranscriptSnapshot(database, resolved.sessionId);
          transcriptSnapshot = { kind: "current", rows: snapshot.rows };
          return snapshot.events;
        },
        // openclaw-agent-db.ts cache rule: never retain a handle across caller awaits; LRU may close it.
        readMessageFacts: async (params) =>
          readTranscriptMirrorFacts(openOpenClawAgentDatabase(databaseOptions), resolved, params),
        replaceEvents: async (events) => {
          if (transcriptSnapshot?.kind === "stale") {
            throw new SqliteTranscriptMutationConflictError(resolved.sessionId);
          }
          const expectedSnapshot = transcriptSnapshot?.rows;
          const nextSnapshot = runOpenClawAgentWriteTransaction(
            (writeDatabase) => {
              assertLockedTranscriptWriteAllowed(writeDatabase, resolved, fencedScope);
              if (expectedSnapshot !== undefined) {
                // The writer queue is process-local. Revalidate after BEGIN IMMEDIATE
                // so a committed cross-process append cannot be deleted by the rewrite.
                assertSqliteTranscriptSnapshotUnchanged(
                  writeDatabase,
                  resolved.sessionId,
                  expectedSnapshot,
                );
              }
              const nextRows: SqliteTranscriptSnapshotRow[] = [];
              replaceSqliteTranscriptEventsInTransaction(writeDatabase, resolved, events, {
                writtenRows: nextRows,
              });
              assertLockedTranscriptWriteAllowed(writeDatabase, resolved, fencedScope);
              return nextRows;
            },
            databaseOptions,
            { operationLabel: "session.transcript.locked-replace" },
          );
          transcriptSnapshot = { kind: "current", rows: nextSnapshot };
        },
        appendMessage: async (requested) => {
          assertLegacyTranscriptPreparation(fencedScope, requested);
          const prepare =
            requested.prepareMessageAfterIdempotencyCheckAsync || requested.preparation
              ? await prepareNativeLockedAppend(scope, requested)
              : undefined;
          let result: TranscriptMessageAppendResult<unknown> | undefined;
          const snapshotState = transcriptSnapshot;
          let nextSnapshotState = snapshotState;
          runOpenClawAgentWriteTransaction(
            (writeDatabase) => {
              assertLockedTranscriptWriteAllowed(writeDatabase, resolved, fencedScope);
              const options = prepare?.(writeDatabase) ?? requested;
              const snapshotStillCurrent =
                snapshotState?.kind === "current"
                  ? isSqliteTranscriptSnapshotUnchanged(
                      writeDatabase,
                      resolved.sessionId,
                      snapshotState.rows,
                    )
                  : false;
              result = appendTranscriptMessageInTransaction(
                writeDatabase,
                resolved,
                options,
              )?.result;
              if (snapshotState?.kind === "current") {
                nextSnapshotState = snapshotStillCurrent
                  ? {
                      kind: "current",
                      rows: readTranscriptEventRows(writeDatabase, resolved.sessionId),
                    }
                  : { kind: "stale" };
              }
              assertLockedTranscriptWriteAllowed(writeDatabase, resolved, fencedScope);
            },
            databaseOptions,
            { operationLabel: "session.transcript.locked-append" },
          );
          transcriptSnapshot = nextSnapshotState;
          onSnapshot?.(transcriptSnapshot);
          return result as TranscriptMessageAppendResult<typeof requested.message> | undefined;
        },
        appendMessageWithMessageSequence: async (requested) => {
          assertLegacyTranscriptPreparation(fencedScope, requested);
          const prepare =
            requested.prepareMessageAfterIdempotencyCheckAsync || requested.preparation
              ? await prepareNativeLockedAppend(scope, requested)
              : undefined;
          let result: TranscriptMessageAppendResult<unknown> | undefined;
          let lifecycleRevision: string | undefined;
          let messageSeq: number | undefined;
          runOpenClawAgentWriteTransaction(
            (writeDatabase) => {
              lifecycleRevision = assertLockedTranscriptWriteAllowed(
                writeDatabase,
                resolved,
                fencedScope,
              )?.lifecycleRevision;
              const options = prepare?.(writeDatabase) ?? requested;
              const appended = appendTranscriptMessageInTransaction(
                writeDatabase,
                resolved,
                options,
              );
              result = appended?.result;
              if (result) {
                rememberCommittedTranscriptMessageSequencesInTransaction(
                  writeDatabase,
                  resolved.sessionId,
                  [result],
                  readTranscriptAppendPostimage(appended),
                );
                messageSeq = readCommittedTranscriptMessageSequence(result);
              }
              assertLockedTranscriptWriteAllowed(writeDatabase, resolved, fencedScope);
            },
            databaseOptions,
            { operationLabel: "session.transcript.locked-sequenced-append" },
          );
          return {
            lifecycleRevision,
            ...(messageSeq !== undefined ? { messageSeq } : {}),
            result: result as TranscriptMessageAppendResult<typeof requested.message> | undefined,
          };
        },
      };
      return await withTranscriptLockSettlement((queue) =>
        run({
          publishUpdate: (update) => queue(() => context.publishUpdate(update)),
          readEvents: () => queue(context.readEvents),
          readMessageFacts: (params) => queue(() => context.readMessageFacts(params)),
          replaceEvents: (events) => queue(() => context.replaceEvents(events)),
          appendMessage: (options) => queue(() => context.appendMessage(options)),
          appendMessageWithMessageSequence: (options) =>
            queue(() => context.appendMessageWithMessageSequence(options)),
        }),
      );
    },
    "session.transcript.locked-write",
  );
}
