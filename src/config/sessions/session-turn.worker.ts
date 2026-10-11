import { isDeepStrictEqual } from "node:util";
import {
  sqliteSessionIdWriteScope,
  withoutSqliteDatabaseWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import {
  getSqliteReadScopeRevision,
  runSqliteReadOperationSync,
} from "../../infra/sqlite-schema-facts.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { ensureSessionGoalOperationsSchema } from "../../state/openclaw-agent-goal-operations-schema.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { runWithCliHistoryWriter } from "./cli-history-boundary.js";
import { applySessionGoalOperation } from "./goals-operation-policy.js";
import { readSessionGoalOperationReceipt } from "./goals-operations.js";
import {
  readSessionPendingInputWorkerReceipt,
  resolveSessionPendingInputAppend,
  runWithSessionPendingInputWorkerCustody,
} from "./session-accessor.sqlite-pending-inputs.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { readCommittedTranscriptMessageSequence } from "./session-accessor.sqlite-transcript-sequences.js";
import {
  readTranscriptContextStateInTransaction,
  readTranscriptContextVersionInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import { readTranscriptMessageByScopedIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import { readSessionPendingInputAuthorityFacts } from "./session-pending-input-authority.kernel.js";
import { readSessionSourceValidation } from "./session-source-predicate.worker.js";
import { prepareSessionTurnRouting } from "./session-turn-predicate.js";
import {
  createSessionTranscriptTurnKernel,
  sqliteSessionTranscriptTurnRebound,
} from "./session-turn.kernel.js";
import type { SessionTurnCommitted, SessionTurnPlan } from "./session-turn.types.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";

let voiceKernel: typeof import("../../talk/client-voice-session-write.kernel.js") | undefined;
export async function prepareVoiceTranscriptCommit() {
  voiceKernel ??= await import("../../talk/client-voice-session-write.kernel.js");
}

function inCustody<T>(
  input: SessionTurnPlan,
  context: AgentWorkerOperationContext,
  run: () => T,
  readEntry?: () => Parameters<typeof readSessionPendingInputAuthorityFacts>[3],
): T {
  const assertCurrent = () =>
    context.admit("transaction", { kind: "session-entry-patch-validated" });
  const owned = () =>
    runWithCliHistoryWriter(
      input.cliWriter
        ? {
            ...input.cliWriter,
            target: {
              agentId: input.agentId,
              sessionKey: input.sessionKey,
              sessionId: input.options.expectedSessionId,
              storePath: context.options.path,
            },
            assertCurrent,
            assertReadable: assertCurrent,
          }
        : undefined,
      run,
    );
  return input.custody
    ? runWithSessionPendingInputWorkerCustody(
        input.custody,
        input.relocation,
        () =>
          context.admit("transaction", {
            kind: "session-turn-custody",
            authority: input.custody!.preparedAuthority
              ? readSessionPendingInputAuthorityFacts(
                  context.open(),
                  input.custody!.sessionKey,
                  input.custody!.agentId,
                  readEntry?.(),
                )
              : undefined,
          }),
        owned,
      ).value
    : owned();
}

export function prepareSessionTurn(
  input: SessionTurnPlan,
  context: AgentWorkerOperationContext,
  incarnation?: string,
) {
  const database = context.open();
  if (input.options.sessionTurnMutation) {
    ensureSessionGoalOperationsSchema(database.db);
  }
  // Custody's authority read shares the existing preparation facts and snapshot.
  const readPreparation = input.custody?.preparedAuthority
    ? runSqliteReadSnapshotSync
    : runSqliteReadOperationSync;
  return readPreparation(database.db, () => {
    const scope = {
      agentId: input.agentId,
      path: context.options.path,
      sessionKey: input.sessionKey,
      sessionId: input.options.expectedSessionId,
    };
    const kernel = createSessionTranscriptTurnKernel(scope, input.options);
    const selected = kernel.readEntry(database);
    const revision = getSqliteReadScopeRevision(database.db);
    const ownerSourceValidation = input.ownerSources?.length
      ? readSessionSourceValidation(
          database,
          input.ownerSources,
          incarnation,
          new Map([[scope.sessionKey, selected?.entry]]),
        )
      : undefined;
    if (ownerSourceValidation?.refusedSource) {
      return { refusedOwnerSource: ownerSourceValidation.refusedSource };
    }
    prepareSessionTurnRouting(
      input.options.sessionTurnMutation?.routingPredicate,
      context.options.env,
    )?.(database);
    const mutation = input.options.sessionTurnMutation;
    const replay = mutation
      ? readSessionGoalOperationReceipt(
          database.db,
          scope.sessionKey,
          scope.sessionId,
          mutation.operation,
        )
      : undefined;
    const expectedEntry = kernel.resolveExpectedEntry(selected);
    const result =
      replay && selected?.entry.sessionId === scope.sessionId
        ? {
            appendedMessages: [],
            sessionEntry: selected.entry,
            sessionFile: input.options.sessionFile,
            sessionTurnMutationResult: { result: replay, replayed: true },
          }
        : !expectedEntry
          ? sqliteSessionTranscriptTurnRebound(selected, input.options.sessionFile)
          : undefined;
    const transcriptState =
      !result && input.options.messages.length
        ? readTranscriptContextStateInTransaction(database, scope.sessionId)
        : undefined;
    if (input.prepareColdTranscript && transcriptState?.coldArchive) {
      return {
        ownerSourceValidation,
        result: undefined,
        messages: [],
        coldArchive: transcriptState.coldArchive,
        version: undefined,
        goalId: undefined,
      };
    }
    const messages = result
      ? []
      : inCustody(
          input,
          context,
          () =>
            input.options.messages.map((append) => {
              const key = readMessageIdempotencyKey(append.message);
              return {
                pending: Boolean(resolveSessionPendingInputAppend(database, scope, append.message)),
                existing:
                  key && append.idempotencyLookup !== "caller-checked"
                    ? readTranscriptMessageByScopedIdempotencyKey(
                        database,
                        scope,
                        key,
                        append.idempotencyLookup,
                      )
                    : undefined,
              };
            }),
          () =>
            selected && revision
              ? { sessionKey: scope.sessionKey, entry: selected.entry, revision }
              : undefined,
        );
    return {
      ownerSourceValidation,
      result,
      messages,
      coldArchive: undefined,
      version: transcriptState?.version,
      goalId:
        mutation && !result && expectedEntry && input.options.messages.length
          ? applySessionGoalOperation(expectedEntry, mutation.operation, Date.now())?.id
          : undefined,
    };
  });
}

export function commitSessionTurn(input: SessionTurnPlan, context: AgentWorkerOperationContext) {
  return applySessionTurn(input, context, (database, candidate) =>
    transferSessionEntryWorkerCandidate(database, context.admit, candidate),
  );
}

export function applySessionTurn<T>(
  input: SessionTurnPlan,
  context: AgentWorkerOperationContext,
  publish: (
    database: ReturnType<AgentWorkerOperationContext["open"]>,
    candidate: SessionTurnCommitted,
  ) => T,
  incarnation?: string,
) {
  const assertRouting = prepareSessionTurnRouting(
    input.options.sessionTurnMutation?.routingPredicate,
    context.options.env,
  );
  let selectedPostimage: Parameters<typeof readSessionPendingInputAuthorityFacts>[3];
  return inCustody(
    input,
    context,
    () =>
      context.writeTransaction("session.transcript.append-turn", "Session turn", (database) =>
        withSqliteDatabaseWriteScope(
          database.db,
          [
            input.sessionKey,
            sqliteSessionIdWriteScope(input.options.expectedSessionId),
            ...(input.custody ? [input.custody.sessionKey] : []),
          ],
          () => {
            const scope = {
              agentId: input.agentId,
              path: context.options.path,
              sessionKey: input.sessionKey,
              sessionId: input.options.expectedSessionId,
            };
            const transactionVersion = input.options.messages.some(
              (append) => append.preparationVersion,
            )
              ? { ...readTranscriptContextVersionInTransaction(database, scope.sessionId) }
              : undefined;
            const messages = input.options.messages.map((append, index) => ({
              ...append,
              ...(append.preparedMessage
                ? { prepareMessageAfterIdempotencyCheck: () => append.preparedMessage!.message }
                : {}),
              ...(append.freshGuard || append.preparedMessage
                ? {
                    beforeFreshMessageCommit: () => {
                      // The append kernel invokes this only after replay and custody recognition.
                      if (append.preparedMessage && !append.preparedMessage.prepared) {
                        throw new SqliteTranscriptMutationConflictError(scope.sessionId);
                      }
                      if (
                        append.preparationVersion &&
                        !isDeepStrictEqual(append.preparationVersion, transactionVersion)
                      ) {
                        throw new SqliteTranscriptMutationConflictError(scope.sessionId);
                      }
                      if (append.freshGuard) {
                        withoutSqliteDatabaseWriteScope(database.db, () =>
                          context.admit("transaction", {
                            kind: "session-turn-fresh",
                            index,
                            sourceValidation: readSessionSourceValidation(
                              database,
                              append.sources,
                              incarnation,
                            ),
                          }),
                        );
                      }
                    },
                  }
                : {}),
            }));
            const kernel = createSessionTranscriptTurnKernel(
              scope,
              {
                ...input.options,
                workerPrepared: true,
                messages,
              },
              assertRouting,
            );
            // Prepared host hooks are never replayed after a foreign writer changes their idempotency decision.
            for (const append of input.options.messages) {
              if (!append.preparedMessage?.prepared) {
                continue;
              }
              const key = readMessageIdempotencyKey(append.message);
              const current =
                key && append.idempotencyLookup !== "caller-checked"
                  ? readTranscriptMessageByScopedIdempotencyKey(
                      database,
                      scope,
                      key,
                      append.idempotencyLookup,
                    )
                  : undefined;
              if (!isDeepStrictEqual(current, append.preparedMessage.expected)) {
                throw new Error("Transcript idempotency changed while preparing the turn");
              }
            }
            let projectionNeedsReconcile = false;
            const committed = kernel.commit(
              database,
              messages,
              {
                scheduleProjectionReconcile: false,
                onProjectionReconcileNeeded: () => {
                  projectionNeedsReconcile = true;
                },
              },
              (selected) => {
                const revision = getSqliteReadScopeRevision(database.db);
                selectedPostimage =
                  selected && revision
                    ? { sessionKey: scope.sessionKey, entry: selected.entry, revision }
                    : undefined;
                if (input.ownerSources?.length) {
                  withoutSqliteDatabaseWriteScope(database.db, () =>
                    context.admit("transaction", {
                      kind: "session-turn-owner",
                      sourceValidation: readSessionSourceValidation(
                        database,
                        input.ownerSources,
                        incarnation,
                        new Map([[scope.sessionKey, selected?.entry]]),
                      ),
                    }),
                  );
                }
              },
            );
            if (input.options.voiceTranscript && committed.result.appendedMessages.length === 1) {
              if (!voiceKernel) {
                throw new Error("Voice transcript commit was not prepared");
              }
              committed.result.voiceSession = voiceKernel.mutateVoiceSessionInDatabase(database, {
                ...input.options.voiceTranscript,
                kind: "confirm",
                now: Date.now(),
              });
            }
            const revision = getSqliteReadScopeRevision(database.db);
            const publication = committed.identity
              ? prepareSessionEntryReplacementPublication(
                  {
                    ...committed.identity,
                    pendingArchiveRecovery: false,
                    membershipInvalidatedKeys: [],
                    maintenancePlans: [],
                  },
                  database,
                  { captureFullFacts: true },
                )
              : undefined;
            const custodyEntry =
              input.custody &&
              revision &&
              getSqliteReadScopeRevision(database.db) === revision &&
              publication?.current.get(input.custody.sessionKey);
            const candidate: SessionTurnCommitted = {
              kind: "session-turn",
              result: committed.result,
              projectionNeedsReconcile,
              sequences: committed.result.appendedMessages.map(
                readCommittedTranscriptMessageSequence,
              ),
              custody: readSessionPendingInputWorkerReceipt(database),
              authority:
                input.custody?.preparedAuthority &&
                input.custody.databasePath ===
                  (readOpenClawAgentDatabaseIdentity(database).canonicalPath || database.path)
                  ? readSessionPendingInputAuthorityFacts(
                      database,
                      input.custody.sessionKey,
                      input.custody.agentId,
                      custodyEntry && revision
                        ? { sessionKey: input.custody.sessionKey, entry: custodyEntry, revision }
                        : undefined,
                    )
                  : undefined,
              publication,
            };
            if (incarnation && candidate.publication?.source) {
              // The publication and its commit receipt share this locally created source.
              Object.assign(candidate.publication.source, {
                identity: incarnation,
                incarnation,
              });
            }
            return withoutSqliteDatabaseWriteScope(database.db, () => publish(database, candidate));
          },
        ),
      ),
    () => selectedPostimage,
  );
}
