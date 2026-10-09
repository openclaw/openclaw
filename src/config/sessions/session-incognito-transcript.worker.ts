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
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import type { TranscriptReportWorkerOperations } from "./session-accessor.sqlite-transcript-reports.types.js";
import type { TranscriptReportWorkerTarget } from "./session-accessor.sqlite-transcript-reports.worker.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import { readClosedTranscriptTurnInDatabase } from "./session-accessor.transcript-range.js";
import type { IncognitoManagerOperations } from "./session-incognito-manager-contract.js";
import type { IncognitoTranscriptOperations } from "./session-incognito-transcript-contract.js";

type Command = SqliteWorkerCommand<
  Omit<IncognitoTranscriptOperations, keyof IncognitoManagerOperations>
>;

/** Report preparation is detached; every append rebinds and validates its captured revision. */
export function createIncognitoTranscriptWorker(
  database: OpenClawAgentDatabase,
  env: SqliteWorkerStateContext["environment"],
  admit: (stage: "transaction" | "commit", keys: readonly string[]) => void,
) {
  let keys: string[] = [];
  const domain = createAgentDatabaseDomainOwner({
    databasePath: database.path,
    assertCurrent: () => database.db,
    assertCleanupCurrent() {},
    admit: (stage) => admit(stage, keys),
  });
  let binding: { id: string; moduleUrl: string; input: TranscriptReportWorkerTarget } | undefined;
  const resolved = (input: Command["input"]) => ({
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
        admit("commit", keys);
        return result;
      },
      { agentId: database.agentId, path: database.path, env },
      { operationLabel: "session.incognito.transcript" },
    );
  return {
    async prepare(command: Command) {
      if (command.type.startsWith("session.report.")) {
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
      keys = [command.input.sessionKey];
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
