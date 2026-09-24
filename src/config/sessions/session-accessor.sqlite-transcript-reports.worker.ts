import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  assertTransactionUsable,
  runSqliteDeferredTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  advanceCliHistoryBoundaryRangeInTransaction,
  type CliHistoryWriterFacts,
} from "./session-accessor.sqlite-cli-history-boundary.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import type { PreparedTranscriptMessageAppend } from "./session-accessor.sqlite-transcript-message-append.js";
import {
  appendAbortedSessionTranscriptPartialInTransaction,
  appendSelectedTranscriptReportInTransaction,
  prepareTranscriptReportSelection,
  type AbortedSessionTranscriptPartial,
  type AbortedSessionTranscriptPartialResult,
  type SelectedTranscriptReport,
  type TranscriptReport,
  type TranscriptReportSelection,
} from "./session-accessor.sqlite-transcript-reports.kernel.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import { SessionTranscriptWriterClaimReboundError } from "./transcript-write-context.js";

export type TranscriptReportWorkerTarget = {
  resolved: Omit<ResolvedTranscriptScope, "env">;
  cliWriter?: CliHistoryWriterFacts;
  fence: Pick<SessionTranscriptWriteScope, "expectedLifecycleRevision" | "expectedWriterRunId">;
};
type PreparedReport = ReturnType<typeof prepareTranscriptReportSelection>;
type ReportCommit = {
  committed: boolean;
  projectionNeedsReconcile: boolean;
  cliHistoryChanged?: boolean;
  abortedPartial?: AbortedSessionTranscriptPartialResult;
  sessionEntryChanged?: boolean;
};
export type TranscriptReportWorkerOperations = {
  abortedPartial: {
    input: AbortedSessionTranscriptPartial & {
      preparedMessage: PreparedTranscriptMessageAppend<Record<string, unknown>>;
    };
    output: Result<ReportCommit, TranscriptAppendRefusal>;
  };
  prepare: {
    input: TranscriptReportSelection;
    output: Result<PreparedReport, TranscriptAppendRefusal>;
  };
  append: {
    input: Extract<SelectedTranscriptReport, { kind: "custom" }>;
    output: Result<ReportCommit, TranscriptAppendRefusal>;
  };
  assistant: {
    input: Extract<TranscriptReport, { kind: "assistant" }> & {
      preparedMessage: PreparedTranscriptMessageAppend<
        Extract<TranscriptReport, { kind: "assistant" }>["message"]
      >;
    };
    output: Result<ReportCommit, TranscriptAppendRefusal>;
  };
};

/** Domain binding borrows the existing SQLite broker's canonical writer. */
export function bindSqliteWorkerBackend(
  target: TranscriptReportWorkerTarget,
  context: {
    database: DatabaseSync;
    databasePath: string;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<TranscriptReportWorkerOperations> {
  const { fence } = target;
  const resolved = { ...target.resolved, env: getSqliteWorkerStateContext().environment };
  const options = toDatabaseOptions(resolved);
  const database = getOpenClawAgentDatabaseIfOpen(options);
  if (!database || database.db !== context.database || database.path !== context.databasePath) {
    throw new Error("Transcript report lost its canonical database owner");
  }
  let closed = false;
  const assertOpen = () => {
    if (closed || !database.db.isOpen) {
      throw new Error("Transcript report domain is closed");
    }
    assertTransactionUsable(database.db);
  };
  const readRefusal = () => {
    const refusal = resolveTranscriptAppendRefusal(
      readSessionEntryRow(database, resolved.sessionKey, "list")?.entry,
      resolved,
      { ...resolved, ...fence },
    );
    return refusal;
  };
  let prepared:
    | {
        facts: PreparedReport;
        version: ReturnType<typeof readTranscriptContextVersionInTransaction>;
      }
    | undefined;
  return {
    execute(command) {
      assertOpen();
      if (command.type === "prepare") {
        return runSqliteDeferredTransactionSync<Result<PreparedReport, TranscriptAppendRefusal>>(
          database.db,
          () => {
            prepared = undefined;
            const refusal = readRefusal();
            if (refusal) {
              return err(refusal);
            }
            prepared = {
              facts: prepareTranscriptReportSelection(database, resolved, command.input),
              version: readTranscriptContextVersionInTransaction(database, resolved.sessionId),
            };
            return ok(prepared.facts);
          },
        );
      }
      return runOpenClawAgentWriteTransaction<Result<ReportCommit, TranscriptAppendRefusal>>(
        (current) => {
          if (current.db !== database.db) {
            throw new Error("Transcript report lost its canonical database owner");
          }
          context.admit("transaction");
          const refusal = readRefusal();
          if (refusal) {
            context.admit("commit");
            return err(refusal);
          }
          const firstSeq = target.cliWriter
            ? (readTranscriptContextVersionInTransaction(database, resolved.sessionId).rawSeq ??
                -1) + 1
            : undefined;
          let projectionNeedsReconcile = false;
          const projection = {
            scheduleProjectionReconcile: false as const,
            onProjectionReconcileNeeded: () => {
              projectionNeedsReconcile = true;
            },
          };
          let abortedPartial: AbortedSessionTranscriptPartialResult | undefined;
          if (command.type === "abortedPartial") {
            abortedPartial = appendAbortedSessionTranscriptPartialInTransaction(
              database,
              resolved,
              command.input,
              command.input.preparedMessage,
              projection,
            );
          } else if (command.type === "assistant") {
            const facts = prepareTranscriptReportSelection(database, resolved, {
              kind: "assistant",
              responseId: command.input.message.responseId,
            });
            if (!facts.suppressed) {
              appendSelectedTranscriptReportInTransaction(
                database,
                resolved,
                facts.appendParentId,
                command.input,
                projection,
                command.input.preparedMessage,
              );
            }
          } else {
            const plan = prepared;
            prepared = undefined;
            if (!plan || plan.facts.suppressed) {
              throw new Error("Transcript report append requires its prepared selection");
            }
            const currentVersion = readTranscriptContextVersionInTransaction(
              database,
              resolved.sessionId,
            );
            if (!isDeepStrictEqual(currentVersion, plan.version)) {
              context.admit("commit");
              return ok({ committed: false, projectionNeedsReconcile: false });
            }
            appendSelectedTranscriptReportInTransaction(
              database,
              resolved,
              plan.facts.appendParentId,
              command.input,
              projection,
            );
          }
          let commitGranted = false;
          const authorizeCommit = () => {
            if (!commitGranted) {
              context.admit("commit");
              commitGranted = true;
            }
          };
          const cliHistoryChanged =
            target.cliWriter && firstSeq !== undefined
              ? advanceCliHistoryBoundaryRangeInTransaction(
                  database,
                  resolved,
                  {
                    first: firstSeq,
                    last:
                      readTranscriptContextVersionInTransaction(database, resolved.sessionId)
                        .rawSeq ?? -1,
                  },
                  target.cliWriter,
                  authorizeCommit,
                )
              : false;
          const rebound = readRefusal();
          if (rebound) {
            throw new SessionTranscriptWriterClaimReboundError(rebound);
          }
          authorizeCommit();
          return ok({
            committed: true,
            projectionNeedsReconcile,
            cliHistoryChanged,
            ...(abortedPartial
              ? {
                  abortedPartial,
                  sessionEntryChanged: !abortedPartial.skipped && abortedPartial.append.appended,
                }
              : {}),
          });
        },
        options,
        { operationLabel: "session.transcript.report" },
      );
    },
    assertSettled() {
      assertOpen();
      if (database.db.isTransaction) {
        throw new Error("Transcript report command left a transaction open");
      }
    },
    close() {
      closed = true;
      prepared = undefined;
    },
  };
}
