import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import { retainSqliteWorkerErrorCode } from "../../infra/sqlite-worker-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { getCliHistoryWriter } from "./cli-history-boundary.js";
import { assertSessionGoalOperationTime } from "./goals-operations.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import { captureSessionPendingInputWorkerCustody } from "./session-accessor.sqlite-pending-inputs.js";
import {
  captureLifecycleDatabaseScope,
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { installCommittedTranscriptMessageSequences } from "./session-accessor.sqlite-transcript-sequences.js";
import { redactTranscriptMessageForStorage } from "./session-accessor.sqlite-transcript-store.js";
import type {
  SessionTranscriptTurnMessageAppend,
  SessionTranscriptTurnWriteContext,
} from "./session-accessor.types.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import { completeSessionTranscriptCommit } from "./session-transcript-commit-completion.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { prepareSessionTurnGoalMessage } from "./session-turn.kernel.js";
import type {
  SessionTurnCommitted,
  SessionTurnPlan,
  SqliteSessionTurnOptions,
  SqliteExpectedSessionTranscriptTurnResult,
} from "./session-turn.types.js";
import {
  createTranscriptEntryProvenance,
  rememberTranscriptMessageProvenance,
  type TranscriptEntryProvenance,
} from "./transcript-entry-provenance.js";
import { assertTranscriptSourceCommitDatabase } from "./transcript-source-commit-restrictions.js";

export async function appendSessionTurnInWorker(
  requested: ResolvedTranscriptScope,
  options: SqliteSessionTurnOptions,
  context: SessionTranscriptTurnWriteContext,
): Promise<SqliteExpectedSessionTranscriptTurnResult> {
  const scope = captureLifecycleDatabaseScope(requested);
  const database = { ...toDatabaseOptions(scope), path: scope.path };
  const execution = captureOpenClawAgentDatabaseExecution(database);
  const custody = captureSessionPendingInputWorkerCustody();
  const cliWriter = getCliHistoryWriter({ ...scope, storePath: scope.path });
  let custodyRequired = false;
  let committedDatabase: TranscriptEntryProvenance["database"];
  const freshCommitGuards = new Set<() => void>();
  const assertCurrent = () => {
    execution.assertCurrent();
    options.assertCurrent?.();
    if (committedDatabase) {
      assertTranscriptSourceCommitDatabase(options.assertCurrent, committedDatabase.identity);
    }
    options.sessionTurnMutation?.assertCurrent?.();
    if (options.sessionTurnMutation) {
      assertSessionGoalOperationTime(options.sessionTurnMutation.operation, Date.now());
    }
    cliWriter?.assertCurrent();
    for (const guard of freshCommitGuards) {
      guard();
    }
  };
  const {
    onMessageCommitted: _onMessageCommitted,
    assertCurrent: _assertCurrent,
    sessionTurnMutation,
    messages,
    config: _config,
    ...serializable
  } = options;
  const plan: SessionTurnPlan = {
    agentId: scope.agentId,
    sessionKey: scope.sessionKey,
    options: {
      ...serializable,
      initialSessionEntry: options.initialSessionEntry
        ? structuredClone(options.initialSessionEntry)
        : undefined,
      messages: [],
      sessionTurnMutation: sessionTurnMutation
        ? {
            kind: sessionTurnMutation.kind,
            operation: sessionTurnMutation.operation,
            runId: sessionTurnMutation.runId,
            routingPredicate: sessionTurnMutation.routingPredicate,
          }
        : undefined,
    },
    cliWriter: cliWriter
      ? {
          runId: cliWriter.runId,
          authFingerprint: cliWriter.authFingerprint,
          lifecycleRevision: cliWriter.lifecycleRevision,
        }
      : undefined,
    custody: custody?.facts,
    relocation: custody?.relocation,
  };
  const outcome = await (async () => {
    const { restoreSessionColdTranscript, SessionColdTurnReboundError } =
      await import("./session-cold-storage.js");
    assertCurrent();
    try {
      await restoreSessionColdTranscript(
        { ...scope, storePath: scope.path },
        assertCurrent,
        undefined,
        options.keyFormat === "agent-qualified"
          ? {
              agentId: scope.agentId,
              sessionKey: scope.sessionKey,
              options: {
                keyFormat: options.keyFormat,
                expectedSessionId: options.expectedSessionId,
                selectedSessionId: options.selectedSessionId,
                selectedLifecycleRevision: options.selectedLifecycleRevision,
                expectedLifecycleRevision: options.expectedLifecycleRevision,
                expectedWriterRunId: options.expectedWriterRunId,
                expectedSessionState: options.expectedSessionState,
                initialSessionEntry: plan.options.initialSessionEntry,
              },
              goalOperation: options.sessionTurnMutation?.operation,
            }
          : undefined,
      );
    } catch (error) {
      if (error instanceof SessionColdTurnReboundError) {
        return { ...error.result, sessionFile: options.sessionFile };
      }
      throw error;
    }
    return await runSessionEntryWorkerOperation<
      SessionTurnCommitted,
      SqliteExpectedSessionTranscriptTurnResult
    >({
      database,
      retainedExecution: execution,
      agentId: scope.agentId,
      assertCurrent,
      candidateKind: "session-turn",
      onTransactionFacts(facts) {
        if (!isRecord(facts) || facts.kind !== "session-turn-custody") {
          return false;
        }
        if (!custody) {
          throw new Error("Session turn has no pending-input owner");
        }
        custody.assertCurrent();
        custodyRequired = true;
        return true;
      },
      assertCandidate() {
        if (custodyRequired) {
          custody?.assertCurrent();
        }
      },
      async run(worker, commit) {
        // Preparation already bound this execution to the original native file owner.
        const identity = execution.fileIdentity;
        if (!identity) {
          throw new Error("Transcript append has no admitted physical database.");
        }
        committedDatabase = {
          path: database.path,
          identity: { key: `file:${identity.physicalIdentity}`, birthtime: identity.birthtime },
        };
        assertCurrent();
        const selected = await worker.execute({ type: "session.turn.prepare", input: plan });
        assertCurrent();
        if (selected.result) {
          return selected.result;
        }
        const accepted: SessionTranscriptTurnMessageAppend[] = [];
        for (const append of messages) {
          if (!append.shouldAppend || (await append.shouldAppend(context))) {
            accepted.push(append);
          }
          assertCurrent();
        }
        plan.options.messages = accepted.map(
          ({
            config: _messageConfig,
            workerPreparation: _preparation,
            shouldAppend: _shouldAppend,
            shouldAppendInTransaction: _predicate,
            prepareMessageAfterIdempotencyCheck: _prepare,
            beforeFreshMessageCommit: _guard,
            ...append
          }) => append,
        );
        const preparation = await worker.execute({ type: "session.turn.prepare", input: plan });
        assertCurrent();
        if (preparation.result) {
          return preparation.result;
        }
        plan.options.preparedGoalId = preparation.goalId;
        plan.options.messages = plan.options.messages.map((append, index) => {
          const hooks = accepted[index]!.workerPreparation;
          const facts = preparation.messages[index]!;
          const config = accepted[index]!.config ?? options.config;
          const prepare = hooks?.prepareMessageAfterIdempotencyCheck;
          let message = prepareSessionTurnGoalMessage(
            append.message,
            sessionTurnMutation,
            preparation.goalId,
          );
          if (!facts.pending && !facts.existing && prepare) {
            message = prepare(message);
          }
          if (
            !facts.pending &&
            !facts.existing &&
            message !== undefined &&
            hooks?.beforeFreshMessageCommit
          ) {
            freshCommitGuards.add(hooks.beforeFreshMessageCommit);
          }
          if (!facts.pending && message !== undefined && options.atomicGroup !== true) {
            message = redactTranscriptMessageForStorage(message, { config });
          }
          return {
            ...append,
            message: prepare ? append.message : message,
            ...(prepare && !facts.pending
              ? { preparation: { expected: facts.existing, message } }
              : {}),
          };
        });
        assertCurrent();
        return commit(() => worker.execute({ type: "session.turn.commit", input: plan }));
      },
      onAcknowledged(candidate) {
        if (candidate.custody) {
          custody?.publish(candidate.custody);
        }
        installCommittedTranscriptMessageSequences(
          candidate.result.appendedMessages,
          candidate.sequences,
        );
        if (candidate.projectionNeedsReconcile) {
          startSessionTranscriptIndexReconcile({
            ...database,
            preferredSessionId: scope.sessionId,
          });
        }
      },
      async onCommitted(candidate, published, identity) {
        rememberTranscriptMessageProvenance(
          candidate.result.appendedMessages,
          createTranscriptEntryProvenance(
            published?.current.get(scope.sessionKey) ?? candidate.result.sessionEntry,
            committedDatabase,
          ),
          scope,
        );
        if (published) {
          publishCommittedSessionIdentity(
            scope.agentId,
            identity,
            published.previous,
            published.current,
            published.prepared,
          );
        }
        await completeSessionTranscriptCommit(
          candidate.result.appendedMessages,
          options.onMessageCommitted,
        );
        return candidate.result;
      },
    });
  })().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    await execution.release();
  } catch (error) {
    if (outcome.ok) {
      throw error;
    }
    throw retainSqliteWorkerErrorCode(
      createSqliteLifecycleAggregateError(
        [outcome.error, error],
        "Session turn and executor cleanup failed",
        outcome.error,
      ),
      outcome.error,
    );
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
