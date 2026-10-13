import { randomUUID } from "node:crypto";
import { err, ok } from "@openclaw/normalization-core/result";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  runWithSqliteWorkerStateContext,
  type SqliteWorkerStateContext,
} from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { createAgentDatabaseDomainOwner } from "../../state/openclaw-agent-execution-domain.js";
import { ensureSessionGoalOperationsSchema } from "../../state/openclaw-agent-goal-operations-schema.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import {
  mutateSessionGoalInDatabase,
  readSessionGoalOperationInDatabase,
} from "./goals-operations.js";
import {
  readSessionKeyBySessionIdInDatabase,
  readExactSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
import { readSessionEntrySelectionSnapshot } from "./session-accessor.sqlite-entry-store.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import type { TranscriptReportWorkerOperations } from "./session-accessor.sqlite-transcript-reports.types.js";
import type { TranscriptReportWorkerTarget } from "./session-accessor.sqlite-transcript-reports.worker.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import { readClosedTranscriptTurnInDatabase } from "./session-accessor.transcript-range.js";
import { readSessionTranscriptRuntimeTarget } from "./session-accessor.transcript-target.js";
import type { IncognitoManagerOperations } from "./session-incognito-manager-contract.js";
import {
  isIncognitoTranscriptReceiptCommand,
  type IncognitoTranscriptOperations,
} from "./session-incognito-transcript-contract.js";
import { executeIncognitoTranscriptLock } from "./session-incognito-transcript-lock.worker.js";
import { applyManualCompactInTransaction } from "./session-manual-compact.kernel.js";
import {
  applySessionTranscriptCorrection,
  applySessionMessageRewrite,
  applySessionTranscriptEvent,
  prepareSessionMessageRewrite,
} from "./session-message-rewrite.worker.js";
import type {
  SessionSourcePredicate,
  SessionSourceValidation,
} from "./session-source-authority.js";
import { readSessionSourceValidation } from "./session-source-predicate.worker.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";

type Command = SqliteWorkerCommand<
  Omit<IncognitoTranscriptOperations, keyof IncognitoManagerOperations>
>;

/** Report preparation is detached; every append rebinds and validates its captured revision. */
export function createIncognitoTranscriptWorker(
  database: OpenClawAgentDatabase,
  env: SqliteWorkerStateContext["environment"],
  admit: (
    stage: "transaction" | "commit",
    keys: readonly string[],
    receipt?: { value?: unknown; sourceValidation?: SessionSourceValidation },
  ) => void,
  incarnation: string,
) {
  let keys: string[] = [];
  let recoverValue = false;
  let sourceValidation: SessionSourceValidation | undefined;
  const acceptValidation = (validation: SessionSourceValidation) => {
    sourceValidation = validation;
    if (!validation.refusedSource && recoverValue) {
      admit("transaction", keys, { sourceValidation: validation });
    }
  };
  const validateSources = (sources: SessionSourcePredicate[] | undefined) => {
    const validation = readSessionSourceValidation(database, sources, incarnation);
    acceptValidation(validation);
    return validation;
  };
  const domain = createAgentDatabaseDomainOwner({
    databasePath: database.path,
    assertCurrent: () => database.db,
    assertCleanupCurrent() {},
    admit: (stage) => admit(stage, keys),
  });
  let binding: { id: string; moduleUrl: string; input: TranscriptReportWorkerTarget } | undefined;
  let workerTranscript:
    | typeof import("../../gateway/worker-environments/transcript-commit.kernel.js")
    | undefined;
  const resolved = (input: { sessionKey: string; sessionId: string }) => ({
    agentId: database.agentId,
    path: database.path,
    sessionKey: input.sessionKey,
    sessionId: input.sessionId,
    env,
  });
  const write = <T>(operation: () => T): T =>
    runOpenClawAgentWriteTransaction(
      (current) => {
        if (current.db !== database.db) {
          throw new Error("Incognito transcript lost its native owner");
        }
        admit("transaction", keys);
        const result = operation();
        admit("commit", keys, recoverValue ? { value: result, sourceValidation } : undefined);
        return result;
      },
      { agentId: database.agentId, path: database.path, env },
      { operationLabel: "session.incognito.transcript" },
    );
  const context: AgentWorkerOperationContext = {
    options: { agentId: database.agentId, path: database.path, env },
    open: () => database,
    admit: (stage) => admit(stage, keys),
    writeTransaction: (_label, _owner, run) => write(() => run(database)),
  };
  return {
    async prepare(command: Command) {
      if (command.type === "session.workerTranscript.commit") {
        workerTranscript =
          await import("../../gateway/worker-environments/transcript-commit.kernel.js");
      }
      if (command.type === "session.goal.mutate") {
        ensureSessionGoalOperationsSchema(database.db);
      }
      if (command.type !== "session.keyById.read" && command.type.startsWith("session.report.")) {
        binding = {
          id: randomUUID(),
          moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscriptReports)
            .href,
          input: { resolved: resolved(command.input), fence: command.input.fence },
        };
        await domain.prepare({ type: "database.domain.bind", input: binding });
      }
    },
    execute(command: Command) {
      sourceValidation = undefined;
      if (command.type === "session.keyById.read") {
        const value = readSessionKeyBySessionIdInDatabase(database, command.input.sessionId);
        return { value, keys: value ? [value] : [] };
      }
      keys = [command.input.sessionKey];
      recoverValue = isIncognitoTranscriptReceiptCommand(command.type);
      const bound = binding;
      const executeReport = <Key extends keyof TranscriptReportWorkerOperations>(inner: {
        type: Key;
        input: TranscriptReportWorkerOperations[Key]["input"];
      }): TranscriptReportWorkerOperations[Key]["output"] => {
        if (!bound) {
          throw new Error("Incognito report domain was not prepared");
        }
        const result = domain.execute({
          type: "database.domain.execute",
          input: { id: bound.id, command: inner },
        });
        // SAFETY: the fixed report backend owns these command/result pairs.
        return result as TranscriptReportWorkerOperations[Key]["output"];
      };
      try {
        if (bound) {
          // The reused report backend captures its environment during connection binding.
          runWithSqliteWorkerStateContext({ environment: env }, () =>
            domain.execute({ type: "database.domain.bind", input: bound }),
          );
        }
        const reply = <Key extends keyof IncognitoTranscriptOperations>(
          value: IncognitoTranscriptOperations[Key]["output"],
        ) => ({ value, keys });
        return withSqlitePostCommitPublications(database.db, () => {
          const target = resolved(command.input);
          switch (command.type) {
            case "session.workerTranscript.commit":
              return reply<"session.workerTranscript.commit">(
                write(() => {
                  if (!workerTranscript) {
                    throw new Error("Worker transcript kernel was not prepared");
                  }
                  const scope = { ...target, storePath: database.path, ...command.input.fence };
                  const refusal = resolveTranscriptAppendRefusal(
                    readExactSessionEntryRow(database, target.sessionKey)?.entry,
                    target,
                    scope,
                  );
                  if (refusal) {
                    throw new SessionTranscriptWriterClaimReboundError(refusal);
                  }
                  const input = { ...command.input.batch, scope };
                  const plan = workerTranscript.prepareTranscriptCommit(input);
                  let projectionNeedsReconcile = false;
                  const result =
                    !plan.result.ok || plan.result.messages.length === input.messages.length
                      ? plan.result
                      : workerTranscript.applyPreparedTranscriptCommit(
                          input,
                          plan,
                          command.input.preparedMessages.slice(plan.result.messages.length),
                          () => {
                            projectionNeedsReconcile = true;
                          },
                        );
                  return { result, projectionNeedsReconcile };
                }),
              );
            case "session.lock.events":
            case "session.lock.facts":
            case "session.lock.replace": {
              const run = () =>
                executeIncognitoTranscriptLock(database, command, incarnation, acceptValidation);
              const value = command.type === "session.lock.replace" ? write(run) : run();
              return { value, keys };
            }
            case "session.goal.mutate":
              return reply<"session.goal.mutate">(
                write(() => {
                  const { refusedSource: refusedOwnerSource } = validateSources(
                    command.input.sources,
                  );
                  if (refusedOwnerSource) {
                    return { refusedOwnerSource };
                  }
                  return mutateSessionGoalInDatabase(database, command.input);
                }),
              );
            case "session.manualCompact.prepare": {
              const validation = validateSources(command.input.sources);
              const refusedOwnerSource = validation.refusedSource;
              if (refusedOwnerSource) {
                return reply<"session.manualCompact.prepare">({ refusedOwnerSource });
              }
              return reply<"session.manualCompact.prepare">({
                sourceValidation: validation,
                rows: readTranscriptEventRows(database, target.sessionId),
                sessionSnapshot: readSessionEntrySelectionSnapshot(
                  database,
                  target.sessionKey,
                  true,
                ),
              });
            }
            case "session.manualCompact.commit":
              return reply<"session.manualCompact.commit">(
                write(() => {
                  const { refusedSource: refusedOwnerSource } = validateSources(
                    command.input.sources,
                  );
                  if (refusedOwnerSource) {
                    return { refusedOwnerSource };
                  }
                  let projectionNeedsReconcile = false;
                  const result = applyManualCompactInTransaction(
                    database,
                    target,
                    {
                      rows: command.input.prepared.rows,
                      entries: command.input.prepared.sessionSnapshot,
                      events: command.input.retainedEvents,
                      nowMs: command.input.nowMs,
                    },
                    {
                      scheduleProjectionReconcile: false,
                      onProjectionReconcileNeeded: () => {
                        projectionNeedsReconcile = true;
                      },
                    },
                  );
                  return { ...result, projectionNeedsReconcile };
                }),
              );
            case "session.runtimeTarget.read": {
              const value = readSessionTranscriptRuntimeTarget(
                { ...target, storePath: database.path },
                { keyFormat: command.input.keyFormat },
                database,
              );
              keys = value.sessionKey ? [value.sessionKey] : [];
              return reply<"session.runtimeTarget.read">(value);
            }
            case "session.goalReceipt.read":
              return reply<"session.goalReceipt.read">(
                readSessionGoalOperationInDatabase(database, command.input),
              );
            case "session.rewrite.prepare":
              return reply<"session.rewrite.prepare">(
                prepareSessionMessageRewrite({ ...command.input, scope: target }, context),
              );
            case "session.rewrite.commit":
              return reply<"session.rewrite.commit">(
                applySessionMessageRewrite(
                  { ...command.input, scope: target },
                  context,
                  (_database, candidate) => candidate,
                ),
              );
            case "session.event.append":
              return reply<"session.event.append">(
                applySessionTranscriptEvent(
                  {
                    scope: target,
                    eventJson: command.input.eventJson,
                    fence: { ...target, ...command.input.fence },
                  },
                  context,
                  (_database, candidate) => candidate,
                ),
              );
            case "session.correction.prepare": {
              const validation = validateSources(command.input.ownerSources);
              const refusedOwnerSource = validation.refusedSource;
              if (refusedOwnerSource) {
                return reply<"session.correction.prepare">({ refusedOwnerSource });
              }
              const entry = readExactSessionEntryRow(database, target.sessionKey)?.entry;
              const refusal = resolveTranscriptAppendRefusal(entry, target, {
                ...target,
                ...command.input.fence,
              });
              if (
                refusal ||
                (entry?.lifecycleRevision ?? null) !== command.input.selectedLifecycleRevision
              ) {
                throw new SessionTranscriptWriterClaimReboundError(refusal);
              }
              return reply<"session.correction.prepare">({
                sourceValidation: validation,
                rows: readTranscriptEventRows(database, target.sessionId, command.input),
                version: readTranscriptContextVersionInTransaction(database, target.sessionId),
              });
            }
            case "session.correction.commit":
              return reply<"session.correction.commit">(
                write(() => {
                  const { refusedSource: refusedOwnerSource } = validateSources(
                    command.input.ownerSources,
                  );
                  if (refusedOwnerSource) {
                    return { refusedOwnerSource };
                  }
                  const entry = readExactSessionEntryRow(database, target.sessionKey)?.entry;
                  const refusal = resolveTranscriptAppendRefusal(entry, target, {
                    ...target,
                    ...command.input.fence,
                  });
                  if (
                    refusal ||
                    (entry?.lifecycleRevision ?? null) !== command.input.selectedLifecycleRevision
                  ) {
                    throw new SessionTranscriptWriterClaimReboundError(refusal);
                  }
                  return applySessionTranscriptCorrection(database, {
                    ...command.input,
                    scope: target,
                  });
                }),
              );
            case "session.report.latestCustomReport": {
              const result = executeReport({
                type: "prepare",
                input: { kind: "custom", customTypes: command.input.customTypes },
              });
              return reply<"session.report.latestCustomReport">(
                result.ok ? ok(result.value.latest) : result,
              );
            }
            case "session.report.prepare": {
              const result = executeReport({ type: "prepare", input: command.input.selection });
              return reply<"session.report.prepare">(
                result.ok
                  ? ok({
                      facts: result.value,
                      prepared: {
                        selection: command.input.selection,
                        version: readTranscriptContextVersionInTransaction(
                          database,
                          target.sessionId,
                        ),
                      },
                    })
                  : result,
              );
            }
            case "session.report.append": {
              const prepared = executeReport({
                type: "prepare",
                input: command.input.prepared.selection,
              });
              const version = readTranscriptContextVersionInTransaction(database, target.sessionId);
              const expected = command.input.prepared.version;
              if (
                !prepared.ok ||
                prepared.value.suppressed ||
                // Worker transfer normalizes SQLite row prototypes; compare the version fields.
                version.generation !== expected.generation ||
                version.rawSeq !== expected.rawSeq ||
                version.updatedAt !== expected.updatedAt
              ) {
                // Even a no-write result settles the same transaction/receipt publication interval.
                return reply<"session.report.append">(
                  write<IncognitoTranscriptOperations["session.report.append"]["output"]>(() =>
                    prepared.ok
                      ? ok({ committed: false, projectionNeedsReconcile: false })
                      : prepared,
                  ),
                );
              }
              return reply<"session.report.append">(
                executeReport({ type: "append", input: command.input.report }),
              );
            }
            case "session.report.assistant":
              return reply<"session.report.assistant">(
                executeReport({ type: "assistant", input: command.input.report }),
              );
            case "session.report.abortedPartial":
              return reply<"session.report.abortedPartial">(
                executeReport({ type: "abortedPartial", input: command.input.report }),
              );
            case "session.message.append":
              return reply<"session.message.append">(
                write<IncognitoTranscriptOperations["session.message.append"]["output"]>(() => {
                  const refusal = resolveTranscriptAppendRefusal(
                    readExactSessionEntryRow(database, target.sessionKey)?.entry,
                    target,
                    { ...target, ...command.input.fence },
                  );
                  if (refusal) {
                    return err(refusal);
                  }
                  let projectionNeedsReconcile = false;
                  const append = appendTranscriptMessageInTransaction(
                    database,
                    target,
                    {
                      message: command.input.message,
                      parentId: command.input.parentId,
                    },
                    undefined,
                    {
                      scheduleProjectionReconcile: false,
                      onProjectionReconcileNeeded: () => {
                        projectionNeedsReconcile = true;
                      },
                    },
                  );
                  return ok({ append: append?.result, projectionNeedsReconcile });
                }),
              );
            case "session.turn.read": {
              for (const anchor of [
                command.input.boundary.admission,
                command.input.boundary.terminal,
              ]) {
                if (
                  anchor.agentId !== database.agentId ||
                  anchor.storePath !== database.path ||
                  anchor.sessionKey !== target.sessionKey ||
                  anchor.sessionId !== target.sessionId
                ) {
                  throw new Error("Incognito transcript turn changed its actor target");
                }
              }
              const refusal = resolveTranscriptAppendRefusal(
                readExactSessionEntryRow(database, target.sessionKey)?.entry,
                target,
                { ...target, ...command.input.fence },
              );
              return reply<"session.turn.read">(
                refusal
                  ? { kind: "session-rebound" as const }
                  : readClosedTranscriptTurnInDatabase(database.db, command.input),
              );
            }
          }
          throw new Error("Unsupported incognito transcript operation");
        });
      } finally {
        if (bound) {
          domain.assertSettled();
          domain.execute({ type: "database.domain.close", input: { id: bound.id } });
          binding = undefined;
        }
      }
    },
    assertSettled() {
      domain.assertSettled();
      binding = undefined;
    },
    close: () => domain.close(),
  };
}
