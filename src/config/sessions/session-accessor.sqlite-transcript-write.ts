import { isMainThread } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ok, type Result } from "@openclaw/normalization-core/result";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import type {
  SessionTranscriptAccessScope,
  SessionTranscriptContextVersion,
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
  TranscriptEvent,
  TranscriptEventAppendResult,
  TranscriptMessageWriteSnapshot,
  TranscriptWriteSnapshot,
  TranscriptEventAppendOptions,
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
} from "./session-accessor.sqlite-contract.js";
import {
  readSessionEntryRow,
  readSessionIdentitySnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { publishTranscriptUpdate } from "./session-accessor.sqlite-events.js";
import { prepareSessionIdentityPublication } from "./session-accessor.sqlite-identity.js";
import {
  assertSqliteTranscriptSnapshotUnchanged,
  isSqliteTranscriptSnapshotUnchanged,
  readTranscriptEventRows,
  readTranscriptSnapshot,
  type SqliteTranscriptSnapshotState,
} from "./session-accessor.sqlite-read.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  appendTranscriptMessageInTransaction,
  type PreparedTranscriptMessageAppend,
} from "./session-accessor.sqlite-transcript-message-append.js";
import { readTranscriptMirrorFacts } from "./session-accessor.sqlite-transcript-mirror.js";
import {
  readTranscriptVisibleTailEntryIdInTransaction,
  resolveTranscriptEventAppendParent,
} from "./session-accessor.sqlite-transcript-parent.js";
import {
  readCommittedTranscriptMessageSequence,
  rememberCommittedTranscriptMessageSequencesInTransaction,
} from "./session-accessor.sqlite-transcript-sequences.js";
import {
  readTranscriptGenerationInTransaction,
  readTranscriptContextVersionInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventInTransaction,
  replaceSqliteTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import {
  assertNonMessageTranscriptEvent,
  assertLockedTranscriptWriteAllowed,
} from "./session-accessor.sqlite-transcript-write-guard.js";
import {
  prepareNativeLockedAppend,
  runTranscriptWriteSnapshotSync,
  type TranscriptWriteViewGuard,
} from "./session-accessor.sqlite-transcript-write-snapshot.js";
import type {
  SessionTranscriptRuntimeTarget,
  SessionTranscriptWriteLockAccessorContext,
} from "./session-accessor.types.js";
import { captureIncognitoSessionOperation } from "./session-incognito-binding.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import {
  readTranscriptAppendPostimage,
  retainTranscriptAppendPostimage,
} from "./session-transcript-append-postimage.js";
import { withTranscriptLockSettlement } from "./session-transcript-lock-settlement.js";
import { assertLegacyTranscriptPreparation } from "./session-transcript-preparation.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";
import { captureSessionTranscriptTargetBinding } from "./transcript-target-binding.js";
import {
  assertOwnedTranscriptWriteCommit,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

export { withTranscriptWriteTransaction } from "./session-accessor.sqlite-transcript-write-snapshot.js";

/** Replaces the active session identity and its prepared branch in one commit. */
export async function replaceSessionWithBranchedTranscript(
  scope: SessionTranscriptRuntimeTarget,
  branch: { sessionId: string; events: TranscriptEvent[] },
  onCommitted: (
    target: SessionTranscriptRuntimeTarget,
    version: SessionTranscriptContextVersion,
  ) => void,
  assertActive?: () => void,
): Promise<void> {
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
  await restoreSessionColdTranscript({ ...fencedScope, sessionId: resolved.sessionId });
  const databaseOptions = toDatabaseOptions(resolved);
  const expectedLifecycleRevision = readSessionEntryRow(
    openOpenClawAgentDatabase(databaseOptions),
    resolved.sessionKey,
  )?.entry.lifecycleRevision;
  const nextScope = { ...fencedScope, sessionId: branch.sessionId };
  await runExclusiveSqliteSessionWrite(
    resolved,
    async () => {
      assertActive?.();
      const committed = runOpenClawAgentWriteTransaction(
        (database) => {
          assertActive?.();
          const result = replaceSessionWithBranchedTranscriptInTransaction(
            database,
            fencedScope,
            branch,
            expectedLifecycleRevision,
            assertActive,
          );
          return {
            version: result.version,
            publish: prepareSessionIdentityPublication(
              database,
              resolved.agentId,
              result.identity.previous,
              result.identity.current,
            ),
          };
        },
        databaseOptions,
        { operationLabel: "session.transcript.branch" },
      );
      try {
        onCommitted(nextScope, committed.version);
      } finally {
        committed.publish();
      }
    },
    "session.transcript.branch",
  );
}

/** One transaction kernel for the retained adapter and the canonical worker. */
export function replaceSessionWithBranchedTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  scope: SessionTranscriptWriteScope,
  branch: { sessionId: string; events: TranscriptEvent[] },
  expectedLifecycleRevision: SessionTranscriptWriteScope["expectedLifecycleRevision"],
  assertActive?: () => void,
  projection?: { scheduleProjectionReconcile?: boolean; onProjectionReconcileNeeded?: () => void },
) {
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  const nextScope = { ...fencedScope, sessionId: branch.sessionId };
  const nextResolved = { ...resolved, sessionId: branch.sessionId };
  const fresh = readSessionEntryRow(database, resolved.sessionKey)?.entry;
  if (
    fresh?.sessionId !== resolved.sessionId ||
    fresh.lifecycleRevision !== expectedLifecycleRevision
  ) {
    const cause = {
      ...(fresh
        ? { actualSessionId: fresh.sessionId, code: "session-rebound" as const }
        : { code: "session-entry-missing" as const }),
      expectedSessionId: resolved.sessionId,
      sessionKey: scope.sessionKey,
    };
    throw new Error(`Branched session was not persisted: ${cause.code}`, { cause });
  }
  assertLockedTranscriptWriteAllowed(database, resolved, fencedScope);
  const identityKeys = collectSessionEntryLookupKeys(resolved.sessionKey);
  const previous = readSessionIdentitySnapshot(database, identityKeys);
  writeSessionEntry(database, resolved.sessionKey, {
    ...projectCanonicalSessionEntryShape({ ...fresh }),
    sessionId: branch.sessionId,
    updatedAt: Date.now(),
  });
  assertLockedTranscriptWriteAllowed(database, nextResolved, nextScope);
  replaceSqliteTranscriptEventsInTransaction(database, nextResolved, branch.events, projection);
  assertActive?.();
  return {
    identity: { previous, current: readSessionIdentitySnapshot(database, identityKeys) },
    version: readTranscriptContextVersionInTransaction(database, nextResolved.sessionId),
  };
}

/** Rewrites exact transcript rows after atomically validating their generation and bytes. */
export async function rewriteTranscriptEventRowsExact(
  scope: SessionTranscriptAccessScope,
  params: {
    allowInitialGenerationMaterialization?: boolean;
    expectedGeneration: string | null;
    rows: readonly { event: TranscriptEvent; expectedEventJson: string; seq: number }[];
  },
): Promise<{ generation: string } | null> {
  if (params.rows.length === 0) {
    return null;
  }
  const resolved = resolveSqliteTranscriptScope(scope);
  const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
  await restoreSessionColdTranscript({ ...scope, sessionId: resolved.sessionId });
  return await runExclusiveSqliteSessionWrite(
    resolved,
    async () =>
      runOpenClawAgentWriteTransaction(
        (database) => {
          const currentGeneration =
            readTranscriptGenerationInTransaction(database, resolved.sessionId) ?? null;
          const initialGenerationMaterialized =
            params.allowInitialGenerationMaterialization === true &&
            params.expectedGeneration === null;
          if (currentGeneration !== params.expectedGeneration && !initialGenerationMaterialized) {
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
}

export { replaceTranscriptSuffixEventsSync } from "./session-accessor.sqlite-transcript-suffix-write.js";

/** Appends one raw transcript event to the additive SQLite transcript store. */
export async function appendTranscriptEvent(
  scope: SessionTranscriptAccessScope,
  event: TranscriptEvent,
  options: TranscriptEventAppendOptions = {},
): Promise<boolean> {
  assertNonMessageTranscriptEvent(event);
  const resolved = resolveSqliteTranscriptScope(scope);
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
}

export function appendTranscriptEventSnapshotSync(
  scope: SessionTranscriptWriteScope,
  event: TranscriptEvent,
  options: TranscriptEventAppendOptions = {},
  projection?: {
    scheduleProjectionReconcile: false;
    onProjectionReconcileNeeded: () => void;
    eventJson?: string;
  },
  view?: TranscriptWriteViewGuard,
  transaction?: OpenClawAgentDatabase,
): Result<TranscriptWriteSnapshot<TranscriptEventAppendResult>, TranscriptAppendRefusal> {
  assertNonMessageTranscriptEvent(event);
  return runTranscriptWriteSnapshotSync<TranscriptEventAppendResult>(
    scope,
    (database, resolved) => {
      const resolvedEvent = resolveTranscriptEventAppendParent(
        database,
        resolved.sessionId,
        event,
        options,
      );
      if (
        appendTranscriptEventInTransaction(database, resolved, resolvedEvent, {
          ...projection,
          eventJson: resolvedEvent === event ? projection?.eventJson : undefined,
        }) === false
      ) {
        return { appended: false };
      }
      if (
        isRecord(resolvedEvent) &&
        "parentId" in resolvedEvent &&
        (resolvedEvent.parentId === null || typeof resolvedEvent.parentId === "string")
      ) {
        return { appended: true, effectiveParentId: resolvedEvent.parentId };
      }
      return { appended: true };
    },
    options.beforeCommitInTransaction,
    options.expectedMutationAt,
    view,
    { eventType: isRecord(event) && typeof event.type === "string" ? event.type : "unknown" },
    transaction,
  );
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

/** Appends one transcript message synchronously for sync session runtimes. */
export function appendTranscriptMessageSync<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
): Result<TranscriptMessageAppendResult<TMessage> | undefined, TranscriptAppendRefusal> {
  const snapshot = appendTranscriptMessageSnapshotSync(scope, options);
  return snapshot.ok ? ok(snapshot.value.result) : snapshot;
}

export function appendTranscriptMessageSnapshotSync<TMessage>(
  scope: SessionTranscriptWriteScope,
  options: TranscriptMessageAppendOptions<TMessage>,
  preparedMessage?: PreparedTranscriptMessageAppend<TMessage>,
  workerOptions?: {
    messageAlreadyRedacted?: true;
    scheduleProjectionReconcile?: boolean;
    onProjectionReconcileNeeded?: () => void;
  },
  view?: TranscriptWriteViewGuard,
  transaction?: OpenClawAgentDatabase,
): Result<TranscriptMessageWriteSnapshot<TMessage>, TranscriptAppendRefusal> {
  const snapshot = runTranscriptWriteSnapshotSync(
    scope,
    (database, resolved) => {
      const committed = appendTranscriptMessageInTransaction(
        database,
        resolved,
        workerOptions?.messageAlreadyRedacted
          ? { ...options, messageAlreadyRedacted: true }
          : options,
        preparedMessage,
        workerOptions,
      );
      const result = committed?.result;
      return retainTranscriptAppendPostimage(
        {
          result,
          visibleTailEntryId:
            committed?.visibleTailEntryId ??
            (result
              ? readTranscriptVisibleTailEntryIdInTransaction(
                  database,
                  resolved.sessionId,
                  result.messageId,
                )
              : null),
        },
        readTranscriptAppendPostimage(committed),
      );
    },
    undefined,
    options.expectedMutationAt,
    view,
    {
      eventType: "message",
      messageRole:
        isRecord(options.message) && typeof options.message.role === "string"
          ? options.message.role
          : "unknown",
    },
    transaction,
  );
  if (!snapshot.ok) {
    return snapshot;
  }
  return ok({
    ...snapshot.value,
    result: snapshot.value.result.result,
    visibleTail: {
      entryId: snapshot.value.result.visibleTailEntryId,
      generation: snapshot.value.after.generation,
    },
  });
}

/** Runs read/append transcript work under one SQLite writer-queue critical section. */
export async function withTranscriptWriteLock<T>(
  scope: SessionTranscriptWriteScope,
  run: (context: SessionTranscriptWriteLockAccessorContext) => Promise<T> | T,
): Promise<T> {
  assertLegacyTranscriptPreparation(scope);
  return withHostTranscriptWriteLock(scope, run);
}

/** Actor sequences retain the captured owner; unbound callers use the existing host route. */
export async function withTranscriptWriteSequence<T>(
  scope: SessionTranscriptWriteScope,
  run: (context: SessionTranscriptWriteLockAccessorContext) => Promise<T> | T,
): Promise<T> {
  const actor = captureIncognitoSessionOperation(scope);
  if (!actor) {
    return withHostTranscriptWriteLock(scope, run);
  }
  const resolved = resolveSqliteTranscriptScope({ ...scope, storePath: actor.actor.path });
  const target = captureSessionTranscriptTargetBinding({
    ...scope,
    agentId: resolved.agentId,
    sessionId: resolved.sessionId,
    sessionKey: resolved.sessionKey,
    storePath: actor.actor.path,
  });
  const { withIncognitoTranscriptWriteSequence } =
    await import("./session-incognito-transcript-sequence.js");
  return withIncognitoTranscriptWriteSequence(target, actor, run);
}

async function withHostTranscriptWriteLock<T>(
  scope: SessionTranscriptWriteScope,
  run: (context: SessionTranscriptWriteLockAccessorContext) => Promise<T> | T,
): Promise<T> {
  const fenced = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fenced);
  if (!isMainThread || !supportsOpenClawAgentDatabaseExecution(toDatabaseOptions(resolved))) {
    return runNativeTranscriptWriteLock(fenced, run);
  }
  const captured = captureLifecycleDatabaseScope(resolved);
  const identity = readDatabasePathIdentitySync(captured.path);
  const { withWorkerTranscriptWriteLock } = await import("./session-transcript-locked-write.js");
  const current = readDatabasePathIdentitySync(captured.path);
  if (current.key !== identity.key || current.birthtime !== identity.birthtime) {
    throw new Error("Transcript lock changed its physical store");
  }
  // Physical admission uses captured.path; writer authority retains the captured selector.
  return withWorkerTranscriptWriteLock(
    { ...fenced, ...captured, storePath: captured.path },
    { ...fenced, ...captured, storePath: captured.ownerStorePath ?? captured.path },
    run,
    runNativeTranscriptWriteLock,
  );
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
              replaceSqliteTranscriptEventsInTransaction(writeDatabase, resolved, events);
              const nextRows = readTranscriptEventRows(writeDatabase, resolved.sessionId);
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
