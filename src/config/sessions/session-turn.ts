import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createSqliteLifecycleAggregateError,
  throwSqliteLifecycleErrors,
} from "../../infra/sqlite-lifecycle-errors.js";
import { retainSqliteWorkerErrorCode } from "../../infra/sqlite-worker-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { getCliHistoryWriter } from "./cli-history-boundary.js";
import { assertSessionGoalOperationTime } from "./goals-operations.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import { captureSessionPendingInputWorkerCustody } from "./session-accessor.sqlite-pending-inputs.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import {
  captureLifecycleDatabaseScope,
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { redactTranscriptMessageForStorage } from "./session-accessor.sqlite-transcript-store.js";
import type {
  SessionTranscriptTurnMessageAppend,
  SessionTranscriptTurnWriteContext,
} from "./session-accessor.types.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import {
  captureIncognitoSessionOperation,
  publishIncognitoSessionEntry,
} from "./session-incognito-binding.js";
import { getSessionInputActor, throwSessionInputActorFailure } from "./session-input-actor.js";
import { prepareSessionInputFromReplica } from "./session-input-preparation.js";
import type { SessionPendingInputAuthorityFacts } from "./session-pending-input-authority.js";
import {
  acceptSessionSourceValidation,
  prepareSessionSourceAuthority,
  releaseSessionSourceAuthorities,
  type PreparedSessionSourceAuthority,
  type SessionSourceValidation,
} from "./session-source-authority.js";
import { buildRestartRecoveryExpectedState } from "./session-transcript-turn-state.js";
import {
  completeSessionTurnPublication,
  publishCommittedSessionTurn,
} from "./session-turn-publication.js";
import { prepareSessionTurnGoalMessage } from "./session-turn.kernel.js";
import type {
  IncognitoSessionTurnOperations,
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
  const inputActor = await getSessionInputActor(scope);
  if (inputActor && inputActor.target.readSource?.path !== database.path) {
    throw new Error("Input actor changed the transcript's physical target");
  }
  const incognito = captureIncognitoSessionOperation({ ...scope, storePath: scope.path });
  const execution =
    incognito || inputActor ? undefined : captureOpenClawAgentDatabaseExecution(database);
  const ownerSource = options.ownerSource;
  const custody = captureSessionPendingInputWorkerCustody();
  const cliWriter = getCliHistoryWriter({ ...scope, storePath: scope.path });
  let custodyRequired = false;
  const freshCommitGuards = new Set<() => void>();
  const sources: (PreparedSessionSourceAuthority | undefined)[] = [];
  const committedCompletions: Promise<void>[] = [];
  const assertCurrent = () => {
    execution?.assertCurrent();
    incognito?.authority.assertCurrent();
    (ownerSource?.assertPreparedCurrent ?? ownerSource?.assertCurrent)?.();
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
    ownerSource: _ownerSource,
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
    ownerSources: ownerSource?.checks.map(({ predicate }) => predicate),
    custody: custody?.facts,
    relocation: custody?.relocation,
  };
  const actor = inputActor?.actor;
  const transportSources = (checks: PreparedSessionSourceAuthority["checks"]) =>
    checks.map(({ predicate }) => predicate);
  if (ownerSource && actor) {
    plan.ownerSources = transportSources(ownerSource.checks);
  }
  const fixedVoiceTranscript =
    !incognito &&
    Boolean(options.voiceTranscript) &&
    !custody &&
    !cliWriter &&
    !options.sessionTurnMutation &&
    !options.sessionLifecyclePatch &&
    !options.initialSessionEntry &&
    messages.every(
      (message) =>
        !message.shouldAppend &&
        !message.workerPreparation &&
        !message.preparation &&
        !message.prepareMessageAfterIdempotencyCheck &&
        !message.beforeFreshMessageCommit &&
        !message.shouldAppendInTransaction &&
        !message.predicate,
    );
  // Observable append predicates and fixed voice commits retain eager restoration.
  const prepareColdTranscript =
    !incognito &&
    !fixedVoiceTranscript &&
    !messages.some((append) => append.shouldAppend) &&
    (Boolean(sessionTurnMutation) ||
      messages.some(
        (append) =>
          append.workerPreparation ||
          (isRecord(append.message) &&
            append.message.role === "user" &&
            typeof append.message.idempotencyKey === "string"),
      ));
  if (prepareColdTranscript) {
    plan.prepareColdTranscript = true;
  }
  let outcome = await (async () => {
    if (
      !actor &&
      incognito &&
      ownerSource &&
      (ownerSource.nativeSource ||
        ownerSource.hasOpaqueCheck ||
        ownerSource.checks.some(
          ({ predicate }) =>
            predicate.source.path !== incognito.actor.path ||
            predicate.source.agentId !== incognito.actor.agentId ||
            predicate.source.databaseIdentity !== incognito.actor.identity.incarnation,
        ))
    ) {
      throw new Error("Incognito turns require owner authority prepared for the same actor");
    }
    const restore = async () => {
      if (incognito) {
        return undefined;
      }
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
                kind: "turn",
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
      return undefined;
    };
    if (!prepareColdTranscript) {
      const rebound = await restore();
      if (rebound) {
        return rebound;
      }
    }
    const operation = {
      database,
      retainedExecution: execution,
      agentId: scope.agentId,
      assertCurrent,
      candidateKind: "session-turn",
      onTransactionFacts(facts) {
        if (isRecord(facts) && facts.kind === "session-turn-owner") {
          if (!ownerSource) {
            throw new Error("Session turn omitted its owner source authority");
          }
          acceptSessionSourceValidation(
            ownerSource,
            // SAFETY: The paired worker compares these predicates in the current transaction.
            facts.sourceValidation as SessionSourceValidation,
          );
          return true;
        }
        if (isRecord(facts) && facts.kind === "session-turn-fresh") {
          const source = typeof facts.index === "number" ? sources[facts.index] : undefined;
          if (!source) {
            throw new Error("Session turn omitted its fresh-message authority");
          }
          acceptSessionSourceValidation(
            source,
            // SAFETY: The paired worker read these facts in the current transaction.
            facts.sourceValidation as SessionSourceValidation,
          );
          source.assertCurrent();
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
      async run(prepareTurn, commit) {
        if (fixedVoiceTranscript) {
          // Fixed voice events keep transaction-local validation without a planning read.
          plan.options.messages = messages.map(({ config, ...message }) => ({
            ...message,
            message:
              options.atomicGroup === true
                ? message.message
                : redactTranscriptMessageForStorage(message.message, {
                    config: config ?? options.config,
                  }),
          }));
          return commit();
        }
        const prepareOwnedTurn = async () => {
          const prepared = await prepareTurn();
          if (prepared.refusedOwnerSource) {
            ownerSource?.checks[prepared.refusedOwnerSource.index]?.refuse(
              prepared.refusedOwnerSource.facts,
            );
            throw new Error("Session owner source refusal omitted its authority assertion");
          }
          if (ownerSource) {
            acceptSessionSourceValidation(ownerSource, prepared.ownerSourceValidation);
          }
          return prepared;
        };
        // Selection must precede observable callbacks; ordinary turns validate in COMMIT.
        if (messages.some((append) => append.shouldAppend)) {
          const selected = await prepareOwnedTurn();
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
            preparation: _publicPreparation,
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
        const preparation = needsPreparation ? await prepareOwnedTurn() : undefined;
        assertCurrent();
        if (preparation?.result) {
          return preparation.result;
        }
        if (preparation?.coldArchive) {
          return { kind: "restore-cold-transcript" };
        }
        // Select one adapter for the whole turn before any message preparer can have effects.
        for (const [index, append] of accepted.entries()) {
          const hooks = append.workerPreparation;
          const facts = preparation?.messages[index];
          if (!facts?.pending && !facts?.existing && hooks?.beforeFreshMessageCommit) {
            const source = await prepareSessionSourceAuthority(hooks.beforeFreshMessageCommit);
            sources[index] = source;
            if (
              (!actor && source.nativeSource) ||
              (incognito && source.hasOpaqueCheck) ||
              source.checks.some((check) => check.predicate.source.path !== database.path)
            ) {
              assertCurrent();
              if (incognito || actor) {
                throw new Error(
                  "Incognito turns require source authority prepared for the same actor",
                );
              }
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
            append.sources = sources[index] ? transportSources(sources[index].checks) : undefined;
            append.freshGuard = true;
          }
          if (!facts?.pending && message !== undefined && options.atomicGroup !== true) {
            message = redactTranscriptMessageForStorage(message, { config });
          }
          plan.options.messages[index] = {
            ...append,
            message: prepare ? append.message : message,
            ...(prepare && !facts?.pending
              ? {
                  preparedMessage: {
                    prepared: !facts?.existing,
                    expected: facts?.existing,
                    message,
                  },
                }
              : {}),
          };
        }
        assertCurrent();
        return commit();
      },
      onAcknowledged(candidate) {
        publishCommittedSessionTurn(candidate, {
          scope,
          database,
          options,
          custody,
          committedCompletions,
          execution,
          incognito,
          inputActor,
        });
      },
      async onCommitted(candidate, published, identity) {
        return completeSessionTurnPublication(candidate, scope.agentId, identity, published);
      },
    } satisfies Omit<
      Parameters<
        typeof runSessionEntryWorkerOperation<
          SessionTurnCommitted,
          SqliteExpectedSessionTranscriptTurnResult | { kind: "restore-cold-transcript" }
        >
      >[0],
      "run"
    > & {
      run(
        prepare: () => Promise<IncognitoSessionTurnOperations["session.turn.prepare"]["output"]>,
        commit: () => Promise<
          SqliteExpectedSessionTranscriptTurnResult | { kind: "restore-cold-transcript" }
        >,
      ): Promise<SqliteExpectedSessionTranscriptTurnResult | { kind: "restore-cold-transcript" }>;
    };
    const run = () => {
      if (actor && inputActor) {
        let authorityFailure: unknown;
        const checkAuthority = (check: () => void) => {
          try {
            check();
          } catch (error) {
            authorityFailure = error;
            throw error;
          }
        };
        const authority = {
          assertCurrent: () => checkAuthority(assertCurrent),
          authorize(_stage: "transaction" | "commit", _state: unknown, publication?: unknown) {
            checkAuthority(() => {
              operation.onTransactionFacts(publication);
              if (isRecord(publication) && publication.kind === "session-turn") {
                // SAFETY: the actor's typed phase kernel publishes this discriminated commit.
                operation.assertCandidate(publication as SessionTurnCommitted);
              }
              assertCurrent();
            });
          },
        };
        return operation.run(
          async () => {
            const hot = inputActor.snapshot(authority) ?? (await actor.read(authority));
            const replicaPreparation = prepareSessionInputFromReplica(plan, hot, scope);
            if (replicaPreparation) {
              return replicaPreparation;
            }
            if (incognito) {
              return incognito.actor.sessions.entry(
                { assertCurrent },
                { type: "session.turn.prepare", input: plan },
                incognito.admissionSignal,
              );
            }
            return withSessionEntryWorker(
              database,
              undefined,
              assertCurrent,
              (preparedExecution, source) =>
                preparedExecution
                  .runExisting(source, (worker) =>
                    worker.execute({ type: "session.turn.prepare", input: plan }),
                  )
                  .then((prepared) => {
                    if (!prepared) {
                      throw new Error("Input preparation lost its database");
                    }
                    return prepared;
                  }),
              undefined,
              undefined,
              undefined,
              undefined,
              (publication) => {
                operation.onTransactionFacts(publication);
              },
            );
          },
          async () => {
            const before = inputActor.snapshot(authority) ?? (await actor.read(authority));
            const expectedState =
              options.expectedSessionState ??
              buildRestartRecoveryExpectedState(
                before.entry ?? { sessionId: options.expectedSessionId, updatedAt: 0 },
              );
            let candidate: SessionTurnCommitted | undefined;
            const record = (turn: SessionTurnCommitted | undefined) => {
              if (!turn) {
                throw new Error("Input actor omitted its committed turn");
              }
              candidate = turn;
              try {
                operation.onAcknowledged(turn);
              } finally {
                if (incognito) {
                  publishIncognitoSessionEntry(
                    incognito.actor,
                    scope.sessionKey,
                    before.entry,
                    turn.result.sessionEntry,
                  );
                } else if (turn.result.sessionEntry && inputActor.target.readSource) {
                  publishCommittedSessionIdentity(
                    scope.agentId,
                    inputActor.target.readSource.databaseIdentity,
                    new Map(before.entry ? [[scope.sessionKey, before.entry]] : []),
                    new Map([[scope.sessionKey, turn.result.sessionEntry]]),
                  );
                }
              }
            };
            const command = {
              commandId: randomUUID(),
              phaseId: `${inputActor.phase}:${options.expectedSessionId}`,
            };
            const actorOutcome =
              inputActor.phase === "acceptInput"
                ? await actor.acceptInput(
                    {
                      ...command,
                      expected: before.version,
                      expectedState,
                      lifecycle: {},
                      turn: plan,
                    },
                    authority,
                    {
                      committed: (commit) => record(commit.value.turn),
                    },
                  )
                : await actor.adoptRun(
                    {
                      ...command,
                      expected: before.version,
                      sessionId: options.expectedSessionId,
                      expectedState,
                      lifecycle: {},
                      turn: plan,
                    },
                    authority,
                    {
                      committed: (commit) => record(commit.value),
                    },
                  );
            if (actorOutcome.kind !== "committed") {
              throwSessionInputActorFailure(actorOutcome, authorityFailure);
            }
            if (actorOutcome.failure && actorOutcome.failure.origin !== "response") {
              throw Object.assign(new Error(actorOutcome.failure.message), {
                name: actorOutcome.failure.name,
              });
            }
            if (!candidate) {
              throw new Error("Input actor omitted its native receipt");
            }
            return candidate.result;
          },
        );
      }
      if (incognito) {
        return incognito.actor.sessions.withSharedState(() =>
          operation.run(
            () =>
              incognito.actor.sessions.entry(
                { assertCurrent },
                { type: "session.turn.prepare", input: plan },
                incognito.admissionSignal,
              ),
            async () => {
              incognito.admissionSignal?.throwIfAborted();
              const candidate = await incognito.actor.sessions.entry(
                { assertCurrent },
                { type: "session.turn.commit", input: plan },
                undefined,
                (committed) => {
                  try {
                    operation.onAcknowledged(committed);
                  } finally {
                    if (committed.publication && committed.result.sessionEntry) {
                      publishIncognitoSessionEntry(
                        incognito.actor,
                        scope.sessionKey,
                        committed.publication.previous.get(scope.sessionKey),
                        committed.result.sessionEntry,
                      );
                    }
                  }
                },
                undefined,
                undefined,
                (facts) => {
                  if (isRecord(facts) && facts.kind === "session-turn") {
                    if (custodyRequired) {
                      custody?.assertCurrent(
                        // SAFETY: The paired turn kernel supplies these transaction-local custody facts.
                        facts.authority as SessionPendingInputAuthorityFacts,
                        assertCurrent,
                      );
                    }
                  } else {
                    operation.onTransactionFacts(facts);
                  }
                },
              );
              return candidate.result;
            },
          ),
        );
      }
      return runSessionEntryWorkerOperation<
        SessionTurnCommitted,
        SqliteExpectedSessionTranscriptTurnResult | { kind: "restore-cold-transcript" }
      >({
        ...operation,
        run: (worker, commit) =>
          operation.run(
            () => worker.execute({ type: "session.turn.prepare", input: plan }),
            () => commit(() => worker.execute({ type: "session.turn.commit", input: plan })),
          ),
      });
    };
    for (let restorations = 0; ; restorations++) {
      const result = await run();
      if (!("kind" in result)) {
        return result;
      }
      if (restorations === 2) {
        throw new SessionTranscriptColdError(scope.sessionId);
      }
      // The read-only refusal released FIFO; restoration uses its existing guarded writer.
      const rebound = await restore();
      if (rebound) {
        return rebound;
      }
    }
  })().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const completions = await Promise.allSettled(committedCompletions);
  const completionErrors = completions.flatMap((completion) =>
    completion.status === "rejected" ? [completion.reason] : [],
  );
  if (completionErrors.length) {
    try {
      throwSqliteLifecycleErrors(
        [...(!outcome.ok ? [outcome.error] : []), ...completionErrors],
        "Session turn committed completion failed",
      );
    } catch (error) {
      outcome = { ok: false as const, error };
    }
  }
  try {
    try {
      await releaseSessionSourceAuthorities(sources.filter((source) => source !== undefined));
    } finally {
      await execution?.release();
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
