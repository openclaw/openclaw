import { isDeepStrictEqual } from "node:util";
import { isMainThread } from "node:worker_threads";
import { throwSqliteLifecycleErrors } from "../../infra/sqlite-lifecycle-errors.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { ensureSessionGoalOperationsSchema } from "../../state/openclaw-agent-goal-operations-schema.js";
import {
  applySessionGoalOperation,
  prepareSessionTurnGoalMessage,
} from "./goals-operation-policy.js";
import {
  readSessionGoalOperationInDatabase,
  readSessionGoalOperationReceipt,
} from "./goals-operations.js";
import type {
  SessionTranscriptWriteScope,
  SessionTranscriptTurnWriteContext,
  SessionTranscriptTurnMessageAppend,
} from "./session-accessor.sqlite-contract.js";
import { runSqliteSessionDeletionTransaction as runOpenClawAgentWriteTransaction } from "./session-accessor.sqlite-deletion.js";
import type { ResolvedSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { prepareSessionIdentityPublication } from "./session-accessor.sqlite-identity.js";
import { resolveSessionPendingInputAppend } from "./session-accessor.sqlite-pending-inputs.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { readTranscriptMessageByScopedIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";
import { readWithCanonicalSessionAdmission } from "./session-canonical-key.js";
import { captureIncognitoSessionOperation } from "./session-incognito-binding.js";
import { getSessionInputActor } from "./session-input-actor.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import type { SessionSourceAssertion } from "./session-source-authority.js";
import { completeSessionTranscriptCommit } from "./session-transcript-commit-completion.js";
import {
  assertLegacyTranscriptPreparation,
  normalizeTranscriptMessagePreparation,
} from "./session-transcript-preparation.js";
import {
  prepareSessionTurnPredicates,
  prepareSessionTurnRouting,
} from "./session-turn-predicate.js";
import { appendSessionTurnInWorker } from "./session-turn.js";
import {
  createSessionTranscriptTurnKernel,
  sqliteSessionTranscriptTurnRebound,
} from "./session-turn.kernel.js";
import type {
  SqliteExpectedSessionTranscriptTurnResult,
  SqliteSessionTurnOptions,
} from "./session-turn.types.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";

/** Appends a guarded transcript turn and touches its session row in one queued write. */
export async function appendExpectedSessionTranscriptTurn(
  scope: SessionTranscriptWriteScope,
  requestedOptions: SqliteSessionTurnOptions,
  nativeReservation?: true,
): Promise<SqliteExpectedSessionTranscriptTurnResult> {
  const options = nativeReservation
    ? requestedOptions
    : {
        ...requestedOptions,
        messages: requestedOptions.messages.map((message) => {
          assertLegacyTranscriptPreparation(scope, message);
          return normalizeTranscriptMessagePreparation(message);
        }),
      };
  if (
    options.messages.some(
      (message) => message.workerPreparation?.prepareMessageAfterIdempotencyCheckAsync,
    ) &&
    (options.messages.length !== 1 ||
      options.messages.some((message) => message.predicate || message.shouldAppendInTransaction))
  ) {
    // Compound callbacks depend on earlier transaction writes for their replay decisions.
    throw new Error(
      "Awaited transcript preparation requires one message without transaction predicates",
    );
  }
  const memory = getSessionActorStorageBinding(scope);
  const resolved = memory
    ? {
        agentId: memory.agentId,
        path: memory.path,
        sessionKey: memory.actor.target.sessionKey,
        sessionId: options.expectedSessionId,
        env: scope.env ?? process.env,
      }
    : captureLifecycleDatabaseScope(
        resolveSqliteTranscriptScope({ ...scope, sessionId: options.expectedSessionId }),
      );
  const context: SessionTranscriptTurnWriteContext = {
    agentId: resolved.agentId,
    sessionId: options.expectedSessionId,
    sessionKey: resolved.sessionKey,
    ...(scope.storePath ? { storePath: scope.storePath } : {}),
  };
  const keys = new Set<string>();
  // Dependent callbacks retain the released native callback ordering and veto contract.
  const independentPreparation =
    !options.messages.some((message) => message.workerPreparation) ||
    options.messages.every((append) => {
      const key = readMessageIdempotencyKey(append.message);
      const repeated = key !== null && keys.has(key);
      if (key) {
        keys.add(key);
      }
      return !append.workerPreparation || (!append.predicate && !repeated);
    });
  const incognito = memory
    ? undefined
    : captureIncognitoSessionOperation({ ...scope, storePath: resolved.path });
  const inputActor = !nativeReservation && (await getSessionInputActor(resolved));
  if (
    !nativeReservation &&
    independentPreparation &&
    isMainThread &&
    (inputActor ||
      incognito ||
      supportsOpenClawAgentDatabaseExecution(toDatabaseOptions(resolved))) &&
    options.messages.every((message) => {
      const guard: SessionSourceAssertion | undefined =
        message.workerPreparation?.beforeFreshMessageCommit;
      return (
        !message.shouldAppendInTransaction &&
        !message.prepareMessageAfterIdempotencyCheck &&
        !message.beforeFreshMessageCommit &&
        (inputActor || !guard?.nativeSource)
      );
    })
  ) {
    return appendSessionTurnInWorker(resolved, options, context, (messages) =>
      appendExpectedSessionTranscriptTurn(
        { ...scope, storePath: resolved.path, env: resolved.env },
        { ...options, messages },
        true,
      ),
    );
  }
  if (incognito || inputActor) {
    throw new Error("Actor transcript turns require preparation outside the transaction");
  }
  if (options.acceptedResultGuard || options.sessionTurnMutation?.routingPredicate) {
    await prepareSessionTurnPredicates();
  }
  // Released opaque callbacks, maintenance, and process-held incognito keep native execution.
  const { readEntry, resolveExpectedEntry } = createSessionTranscriptTurnKernel(resolved, options);
  const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
  const rebound = new Error("Session changed before cold transcript restoration");
  let restoreEntry: ResolvedSessionEntryRow | undefined;
  try {
    await restoreSessionColdTranscript(
      { ...scope, sessionId: options.expectedSessionId },
      options.keyFormat === "agent-qualified"
        ? () => {
            options.sessionTurnMutation?.assertCurrent?.();
            const current = withOpenClawAgentDatabaseReadOnly(
              (database) =>
                readWithCanonicalSessionAdmission(database, () => {
                  restoreEntry = readEntry(database);
                  return (
                    resolveExpectedEntry(restoreEntry) ||
                    (restoreEntry?.entry.sessionId === options.expectedSessionId &&
                      options.sessionTurnMutation &&
                      readSessionGoalOperationInDatabase(database, {
                        sessionKey: resolved.sessionKey,
                        expectedSessionId: options.expectedSessionId,
                        operation: options.sessionTurnMutation.operation,
                      }))
                  );
                }),
              toDatabaseOptions(resolved),
            );
            if (current.found ? current.value : resolveExpectedEntry(undefined)) {
              return;
            }
            throw rebound;
          }
        : undefined,
    );
  } catch (error) {
    if (error !== rebound) {
      throw error;
    }
    return sqliteSessionTranscriptTurnRebound(restoreEntry, options.sessionFile);
  }
  // Worker preparation can select the compatibility adapter while retaining its FIFO reservation.
  const withNativeAdmission: typeof runExclusiveSqliteSessionWrite = nativeReservation
    ? (_scope, run) => run()
    : runExclusiveSqliteSessionWrite;
  return await withNativeAdmission(
    resolved,
    async () => {
      const mutation = options.sessionTurnMutation;
      mutation?.assertCurrent?.();
      const preparedDatabase = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
      prepareSessionTurnRouting(mutation?.routingPredicate, resolved.env)?.(preparedDatabase);
      if (mutation) {
        ensureSessionGoalOperationsSchema(preparedDatabase.db);
      }
      // openclaw-agent-db.ts cache rule: LRU can close idle handles during shouldAppend awaits.
      const preparedEntry = readEntry(preparedDatabase);
      const preparedReplay = mutation
        ? readSessionGoalOperationReceipt(
            preparedDatabase.db,
            resolved.sessionKey,
            options.expectedSessionId,
            mutation.operation,
          )
        : undefined;
      if (preparedReplay) {
        if (preparedEntry?.entry.sessionId !== options.expectedSessionId) {
          return sqliteSessionTranscriptTurnRebound(preparedEntry, options.sessionFile);
        }
        return {
          appendedMessages: [],
          sessionEntry: preparedEntry.entry,
          sessionFile: options.sessionFile,
          sessionTurnMutationResult: { result: preparedReplay, replayed: true },
        };
      }
      const expectedEntry = resolveExpectedEntry(preparedEntry);
      if (!expectedEntry) {
        return sqliteSessionTranscriptTurnRebound(preparedEntry, options.sessionFile);
      }
      const messages = await selectAppendableSqliteTranscriptTurnMessages(
        context,
        options.messages,
      );
      const preparingAsync = messages.some(
        (append) => append.workerPreparation?.prepareMessageAfterIdempotencyCheckAsync,
      );
      const preparedGoalId =
        preparingAsync && mutation
          ? applySessionGoalOperation(expectedEntry, mutation.operation, Date.now())?.id
          : undefined;
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
      const identity = preparingAsync ? readOpenClawAgentDatabaseIdentity(database) : undefined;
      const version = preparingAsync
        ? readTranscriptContextVersionInTransaction(database, resolved.sessionId)
        : undefined;
      const preparedMessages = new Set<SessionTranscriptTurnMessageAppend>();
      const asyncMessages = new Set<SessionTranscriptTurnMessageAppend>();
      for (const append of messages) {
        const hooks = append.workerPreparation;
        const prepare = hooks?.prepareMessageAfterIdempotencyCheckAsync;
        if (!prepare) {
          continue;
        }
        asyncMessages.add(append);
        const current = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
        const key = readMessageIdempotencyKey(append.message);
        const existing =
          key && append.idempotencyLookup !== "caller-checked"
            ? readTranscriptMessageByScopedIdempotencyKey(
                current,
                resolved,
                key,
                append.idempotencyLookup,
              )
            : undefined;
        const pending = resolveSessionPendingInputAppend(current, resolved, append.message);
        if (!existing && !pending) {
          preparedMessages.add(append);
        }
        const message =
          existing || pending
            ? append.message
            : await prepare(
                prepareSessionTurnGoalMessage(append.message, mutation, preparedGoalId),
              );
        append.workerPreparation = {
          ...hooks,
          prepareMessageAfterIdempotencyCheckAsync: undefined,
          prepareMessageAfterIdempotencyCheck: () => message,
        };
      }
      let result: SqliteExpectedSessionTranscriptTurnResult = sqliteSessionTranscriptTurnRebound(
        preparedEntry,
        options.sessionFile,
      );
      const { commit } = createSessionTranscriptTurnKernel(
        resolved,
        { ...options, ...(preparedGoalId ? { preparedGoalId } : {}) },
        prepareSessionTurnRouting(mutation?.routingPredicate, resolved.env),
      );
      const failures: unknown[] = [];
      let completion: Promise<void> | undefined;
      const publish = runOpenClawAgentWriteTransaction(
        (transactionDb) => {
          const currentIdentity = identity
            ? readOpenClawAgentDatabaseIdentity(transactionDb)
            : undefined;
          const transactionVersion = identity
            ? readTranscriptContextVersionInTransaction(transactionDb, resolved.sessionId)
            : undefined;
          for (const append of messages) {
            if (!asyncMessages.has(append)) {
              continue;
            }
            const beforeFreshMessageCommit =
              append.workerPreparation?.beforeFreshMessageCommit ?? append.beforeFreshMessageCommit;
            append.workerPreparation = {
              ...append.workerPreparation,
              beforeFreshMessageCommit: () => {
                if (
                  !preparedMessages.has(append) ||
                  identity?.identity !== currentIdentity?.identity ||
                  identity?.birthtime !== currentIdentity?.birthtime ||
                  !isDeepStrictEqual(version, transactionVersion)
                ) {
                  throw new SqliteTranscriptMutationConflictError(resolved.sessionId);
                }
                beforeFreshMessageCommit?.();
              },
            };
          }
          const committed = commit(transactionDb, messages);
          result = committed.result;
          if (
            !stageSqliteTransactionState(transactionDb.db, {
              stage: () => undefined,
              commit: () => {
                try {
                  completion = completeSessionTranscriptCommit(
                    result.appendedMessages,
                    options.onMessageCommitted,
                    result,
                  );
                  void completion?.catch(() => undefined);
                } catch (error) {
                  failures.push(error);
                }
              },
              rollback: () => undefined,
            })
          ) {
            throw new Error("Transcript completion requires managed commit settlement");
          }
          if (options.onCommittedSource && !result.rejectedReason && result.sessionEntry) {
            const committedIdentity = readOpenClawAgentDatabaseIdentity(transactionDb);
            const source = {
              agentId: transactionDb.agentId,
              path: transactionDb.path,
              databaseIdentity: committedIdentity.identity,
              databaseBirthtime: committedIdentity.birthtime,
            };
            const entry = result.sessionEntry;
            if (
              !stageSqliteTransactionState(transactionDb.db, {
                stage: () => undefined,
                commit: () => {
                  try {
                    options.onCommittedSource?.(source, entry);
                  } catch (error) {
                    failures.push(error);
                  }
                },
                rollback: () => undefined,
              })
            ) {
              throw new Error("Transcript source publication requires managed commit settlement");
            }
          }
          return committed.identity
            ? prepareSessionIdentityPublication(
                transactionDb,
                resolved.agentId,
                committed.identity.previous,
                committed.identity.current,
              )
            : undefined;
        },
        toDatabaseOptions(resolved),
        { operationLabel: "session.transcript.append-turn" },
      );
      try {
        publish?.();
      } catch (error) {
        failures.push(error);
      }
      try {
        await completion;
      } catch (error) {
        failures.push(error);
      }
      throwSqliteLifecycleErrors(failures, "Transcript committed publication failed");
      return result;
    },
    "session.transcript.turn",
  );
}

async function selectAppendableSqliteTranscriptTurnMessages(
  context: SessionTranscriptTurnWriteContext,
  messages: readonly SessionTranscriptTurnMessageAppend[],
): Promise<SessionTranscriptTurnMessageAppend[]> {
  const selected: SessionTranscriptTurnMessageAppend[] = [];
  for (const append of messages) {
    const shouldAppend = append.shouldAppend ? await append.shouldAppend(context) : true;
    if (shouldAppend) {
      selected.push({ ...append });
    }
  }
  return selected;
}
