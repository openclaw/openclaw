import { isDeepStrictEqual } from "node:util";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { ensureSessionGoalOperationsSchema } from "../../state/openclaw-agent-goal-operations-schema.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { runWithCliHistoryWriter } from "./cli-history-boundary.js";
import { applySessionGoalOperation, readSessionGoalOperationReceipt } from "./goals-operations.js";
import {
  readSessionPendingInputWorkerReceipt,
  resolveSessionPendingInputAppend,
  runWithSessionPendingInputWorkerCustody,
} from "./session-accessor.sqlite-pending-inputs.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { readCommittedTranscriptMessageSequence } from "./session-accessor.sqlite-transcript-sequences.js";
import { readTranscriptMessageByScopedIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import { readSessionPendingInputAuthorityFacts } from "./session-pending-input-authority.kernel.js";
import { prepareSessionTurnRouting } from "./session-turn-predicate.js";
import {
  createSessionTranscriptTurnKernel,
  sqliteSessionTranscriptTurnRebound,
} from "./session-turn.kernel.js";
import type { SessionTurnCommitted, SessionTurnPlan } from "./session-turn.types.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";

function inCustody<T>(
  input: SessionTurnPlan,
  context: AgentWorkerOperationContext,
  run: () => T,
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
                )
              : undefined,
          }),
        owned,
      ).value
    : owned();
}

export function prepareSessionTurn(input: SessionTurnPlan, context: AgentWorkerOperationContext) {
  const database = context.open();
  prepareSessionTurnRouting(
    input.options.sessionTurnMutation?.routingPredicate,
    context.options.env,
  )?.(database);
  const scope = {
    agentId: input.agentId,
    path: context.options.path,
    sessionKey: input.sessionKey,
    sessionId: input.options.expectedSessionId,
  };
  if (input.options.sessionTurnMutation) {
    ensureSessionGoalOperationsSchema(database.db);
  }
  const kernel = createSessionTranscriptTurnKernel(scope, input.options);
  const selected = kernel.readEntry(database);
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
  const messages = result
    ? []
    : inCustody(input, context, () =>
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
      );
  return {
    result,
    messages,
    goalId:
      mutation && !result && expectedEntry && input.options.messages.length
        ? applySessionGoalOperation(expectedEntry, mutation.operation, Date.now())?.id
        : undefined,
  };
}

export function commitSessionTurn(input: SessionTurnPlan, context: AgentWorkerOperationContext) {
  const assertRouting = prepareSessionTurnRouting(
    input.options.sessionTurnMutation?.routingPredicate,
    context.options.env,
  );
  return inCustody(input, context, () =>
    context.writeTransaction("session.transcript.append-turn", "Session turn", (database) => {
      const scope = {
        agentId: input.agentId,
        path: context.options.path,
        sessionKey: input.sessionKey,
        sessionId: input.options.expectedSessionId,
      };
      const messages = input.options.messages.map((append) => ({
        ...append,
        ...(append.preparation
          ? { prepareMessageAfterIdempotencyCheck: () => append.preparation!.message }
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
        if (!append.preparation) {
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
        if (!isDeepStrictEqual(current, append.preparation.expected)) {
          throw new Error("Transcript idempotency changed while preparing the turn");
        }
      }
      let projectionNeedsReconcile = false;
      const committed = kernel.commit(database, messages, {
        scheduleProjectionReconcile: false,
        onProjectionReconcileNeeded: () => {
          projectionNeedsReconcile = true;
        },
      });
      const candidate: SessionTurnCommitted = {
        kind: "session-turn",
        result: committed.result,
        projectionNeedsReconcile,
        sequences: committed.result.appendedMessages.map(readCommittedTranscriptMessageSequence),
        custody: readSessionPendingInputWorkerReceipt(database),
        authority:
          input.custody?.preparedAuthority &&
          input.custody.databasePath ===
            (readOpenClawAgentDatabaseIdentity(database).canonicalPath || database.path)
            ? readSessionPendingInputAuthorityFacts(
                database,
                input.custody.sessionKey,
                input.custody.agentId,
              )
            : undefined,
        publication: committed.identity
          ? prepareSessionEntryReplacementPublication(
              {
                ...committed.identity,
                pendingArchiveRecovery: false,
                membershipInvalidatedKeys: [],
                maintenancePlans: [],
              },
              database,
            )
          : undefined,
      };
      return transferSessionEntryWorkerCandidate(database, context.admit, candidate);
    }),
  );
}
