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
import type { SessionPendingInputAuthorityFacts } from "./session-pending-input-authority.js";
import {
  prepareSessionSourceAuthority,
  releaseSessionSourceAuthorities,
  type PreparedSessionSourceAuthority,
  type SessionSourcePredicateFacts,
} from "./session-source-authority.js";
import { completeSessionTranscriptCommit } from "./session-transcript-commit-completion.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { prepareSessionTurnGoalMessage } from "./session-turn.kernel.js";
import type {
  SessionTurnCommitted,
  SessionTurnPlan,
  SqliteSessionTurnOptions,
  SqliteExpectedSessionTranscriptTurnResult,
} from "./session-turn.types.js";

export async function appendSessionTurnInWorker(
  requested: ResolvedTranscriptScope,
  options: SqliteSessionTurnOptions,
  context: SessionTranscriptTurnWriteContext,
  native: (
    messages: SessionTranscriptTurnMessageAppend[],
  ) => Promise<SqliteExpectedSessionTranscriptTurnResult>,
): Promise<SqliteExpectedSessionTranscriptTurnResult> {
  const scope = captureLifecycleDatabaseScope(requested);
  const database = { ...toDatabaseOptions(scope), path: scope.path };
  const execution = captureOpenClawAgentDatabaseExecution(database);
  const custody = captureSessionPendingInputWorkerCustody();
  const cliWriter = getCliHistoryWriter({ ...scope, storePath: scope.path });
  let custodyRequired = false;
  const freshCommitGuards = new Set<() => void>();
  const sources: (PreparedSessionSourceAuthority | undefined)[] = [];
  const assertCurrent = () => {
    execution.assertCurrent();
    options.assertCurrent?.();
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
    onCommittedSource: _onCommittedSource,
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
        if (isRecord(facts) && facts.kind === "session-turn-fresh") {
          const source = typeof facts.index === "number" ? sources[facts.index] : undefined;
          if (!source) {
            throw new Error("Session turn omitted its fresh-message authority");
          }
          source.assertCurrent();
          if (isRecord(facts.refusedSource) && typeof facts.refusedSource.index === "number") {
            source.checks[facts.refusedSource.index]?.refuse(
              // SAFETY: The paired worker read these facts from the current transaction.
              facts.refusedSource.facts as SessionSourcePredicateFacts,
            );
            throw new Error("Session source refusal omitted its prepared assertion");
          }
          freshCommitGuards.add(source.assertCurrent);
          return true;
        }
        if (!isRecord(facts) || facts.kind !== "session-turn-custody") {
          return false;
        }
        if (!custody) {
          throw new Error("Session turn has no pending-input owner");
        }
        // SAFETY: The paired worker captures the row and members in its current transaction.
        custody.assertCurrent(facts.authority as SessionPendingInputAuthorityFacts, assertCurrent);
        custodyRequired = true;
        return true;
      },
      assertCandidate(candidate) {
        if (custodyRequired) {
          custody?.assertCurrent(candidate.authority, assertCurrent);
        }
      },
      async run(worker, commit) {
        // Selection must precede observable callbacks; ordinary turns validate in COMMIT.
        if (messages.some((append) => append.shouldAppend)) {
          const selected = await worker.execute({ type: "session.turn.prepare", input: plan });
          assertCurrent();
          if (selected.result) {
            return selected.result;
          }
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
        // Keyed user messages may already own accepted bytes and skip host preparation.
        const needsPreparation =
          sessionTurnMutation ||
          accepted.some(
            (append) =>
              append.workerPreparation ||
              (isRecord(append.message) &&
                append.message.role === "user" &&
                typeof append.message.idempotencyKey === "string"),
          );
        const preparation = needsPreparation
          ? await worker.execute({ type: "session.turn.prepare", input: plan })
          : undefined;
        assertCurrent();
        if (preparation?.result) {
          return preparation.result;
        }
        // Select one adapter for the whole turn before any message preparer can have effects.
        for (const [index, append] of accepted.entries()) {
          const hooks = append.workerPreparation;
          const facts = preparation?.messages[index];
          if (!facts?.pending && !facts?.existing && hooks?.beforeFreshMessageCommit) {
            const source = await prepareSessionSourceAuthority(hooks.beforeFreshMessageCommit);
            sources[index] = source;
            if (
              source.nativeSource ||
              source.checks.some((check) => check.predicate.source.path !== database.path)
            ) {
              assertCurrent();
              return native(accepted.map(({ shouldAppend: _shouldAppend, ...message }) => message));
            }
          }
        }
        plan.options.preparedGoalId = preparation?.goalId;
        for (const [index, append] of plan.options.messages.entries()) {
          const hooks = accepted[index]!.workerPreparation;
          const facts = preparation?.messages[index];
          const config = accepted[index]!.config ?? options.config;
          const prepare =
            hooks?.prepareMessageAfterIdempotencyCheckAsync ??
            hooks?.prepareMessageAfterIdempotencyCheck;
          let message = prepareSessionTurnGoalMessage(
            append.message,
            sessionTurnMutation,
            preparation?.goalId,
          );
          if (!facts?.pending && !facts?.existing && prepare) {
            if (hooks?.prepareMessageAfterIdempotencyCheckAsync) {
              append.preparationVersion = preparation?.version;
            }
            message = await prepare(message);
            assertCurrent();
          }
          if (!facts?.pending && message !== undefined && hooks?.beforeFreshMessageCommit) {
            append.sources = sources[index]?.checks.map((check) => check.predicate);
            append.freshGuard = true;
          }
          if (!facts?.pending && message !== undefined && options.atomicGroup !== true) {
            message = redactTranscriptMessageForStorage(message, { config });
          }
          plan.options.messages[index] = {
            ...append,
            message: prepare ? append.message : message,
            ...(prepare && !facts?.pending
              ? { preparation: { prepared: !facts?.existing, expected: facts?.existing, message } }
              : {}),
          };
        }
        assertCurrent();
        return commit(() => worker.execute({ type: "session.turn.commit", input: plan }));
      },
      onAcknowledged(candidate) {
        try {
          if (
            options.onCommittedSource &&
            !candidate.result.rejectedReason &&
            candidate.result.sessionEntry
          ) {
            const identity = execution.fileIdentity;
            if (!identity) {
              throw new Error("Committed transcript turn omitted its admitted database identity");
            }
            options.onCommittedSource(
              {
                agentId: execution.agentId,
                path: database.path,
                databaseIdentity: identity.physicalIdentity,
                databaseBirthtime: identity.birthtime,
              },
              candidate.result.sessionEntry,
            );
          }
        } finally {
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
        }
      },
      async onCommitted(candidate, published, identity) {
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
    try {
      await releaseSessionSourceAuthorities(sources.filter((source) => source !== undefined));
    } finally {
      await execution.release();
    }
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
