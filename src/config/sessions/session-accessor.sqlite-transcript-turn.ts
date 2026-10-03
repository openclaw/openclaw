import { isMainThread } from "node:worker_threads";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { ensureSessionGoalOperationsSchema } from "../../state/openclaw-agent-goal-operations-schema.js";
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
import {
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readWithCanonicalSessionAdmission } from "./session-canonical-key.js";
import { completeSessionTranscriptCommit } from "./session-transcript-commit-completion.js";
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
import {
  captureTranscriptEntryProvenance,
  rememberTranscriptMessageProvenance,
  type TranscriptEntryProvenance,
} from "./transcript-entry-provenance.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";

/** Appends a guarded transcript turn and touches its session row in one queued write. */
export async function appendExpectedSessionTranscriptTurn(
  scope: SessionTranscriptWriteScope,
  options: SqliteSessionTurnOptions,
): Promise<SqliteExpectedSessionTranscriptTurnResult> {
  const resolved = resolveSqliteTranscriptScope({
    ...scope,
    sessionId: options.expectedSessionId,
  });
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
  if (
    independentPreparation &&
    isMainThread &&
    supportsOpenClawAgentDatabaseExecution(toDatabaseOptions(resolved)) &&
    options.messages.every(
      (message) =>
        !message.shouldAppendInTransaction &&
        !message.prepareMessageAfterIdempotencyCheck &&
        !message.beforeFreshMessageCommit,
    )
  ) {
    return appendSessionTurnInWorker(resolved, options, context);
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
  return await runExclusiveSqliteSessionWrite(
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
      if (!resolveExpectedEntry(preparedEntry)) {
        return sqliteSessionTranscriptTurnRebound(preparedEntry, options.sessionFile);
      }
      const messages = await selectAppendableSqliteTranscriptTurnMessages(
        context,
        options.messages,
      );
      let result: SqliteExpectedSessionTranscriptTurnResult = sqliteSessionTranscriptTurnRebound(
        preparedEntry,
        options.sessionFile,
      );
      const { commit } = createSessionTranscriptTurnKernel(
        resolved,
        options,
        prepareSessionTurnRouting(mutation?.routingPredicate, resolved.env),
      );
      let committedProvenance: TranscriptEntryProvenance | undefined;
      const publish = runOpenClawAgentWriteTransaction(
        (transactionDb) => {
          const committed = commit(transactionDb, messages);
          result = committed.result;
          committedProvenance = captureTranscriptEntryProvenance(
            transactionDb,
            committed.identity?.current.get(resolved.sessionKey) ?? result.sessionEntry,
          );
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
      if (committedProvenance) {
        rememberTranscriptMessageProvenance(result.appendedMessages, committedProvenance, resolved);
      }
      publish?.();
      const completion = completeSessionTranscriptCommit(
        result.appendedMessages,
        options.onMessageCommitted,
      );
      if (completion) {
        await completion;
      }
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
      selected.push(append);
    }
  }
  return selected;
}
