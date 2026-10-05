import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  assertTransactionUsable,
  runSqliteDeferredTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseAdmissionRestriction } from "../../state/openclaw-agent-execution-domain.js";
import {
  advanceCliHistoryBoundaryRangeInTransaction,
  type CliHistoryWriterFacts,
} from "./session-accessor.sqlite-cli-history-boundary.js";
import type {
  SessionTranscriptWriteScope,
  SessionTranscriptContextVersion,
  TranscriptAppendRefusal,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import {
  appendAbortedSessionTranscriptPartialInTransaction,
  appendSelectedTranscriptReportInTransaction,
  prepareTranscriptReportSelection,
} from "./session-accessor.sqlite-transcript-reports.kernel.js";
import type {
  AbortedSessionTranscriptPartialResult,
  PreparedTranscriptReport,
  TranscriptReportCommit,
  TranscriptReportWorkerOperations,
} from "./session-accessor.sqlite-transcript-reports.types.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import { requestSessionEntryCurrentAdmission } from "./session-entry-current-admission.worker.js";
import type { SessionEntryCurrentSource } from "./session-entry-current.types.js";
import { SessionTranscriptWriterClaimReboundError } from "./transcript-write-context.js";

export type TranscriptReportWorkerTarget = {
  resolved: Omit<ResolvedTranscriptScope, "env">;
  cliWriter?: CliHistoryWriterFacts;
  sessionEntryCurrentSource?: SessionEntryCurrentSource;
  fence: Pick<SessionTranscriptWriteScope, "expectedLifecycleRevision" | "expectedWriterRunId">;
};

/** Domain binding borrows the existing SQLite broker's canonical writer. */
export function bindSqliteWorkerBackend(
  target: TranscriptReportWorkerTarget,
  context: {
    database: DatabaseSync;
    databasePath: string;
    admit(
      stage: "transaction" | "commit",
      requestAdmission?: AgentDatabaseAdmissionRestriction,
    ): void;
  },
): SqliteWorkerBackend<TranscriptReportWorkerOperations> {
  const { fence } = target;
  const resolved = { ...target.resolved, env: getSqliteWorkerStateContext().environment };
  const options = toDatabaseOptions(resolved);
  const pathname = resolveOpenClawAgentSqlitePath(options);
  const sameOwner = context.database.location()
    ? readDatabasePathIdentitySync(pathname).canonicalPath === context.databasePath
    : pathname === context.databasePath &&
      getOpenClawAgentDatabaseIfOpen(options)?.db === context.database;
  if (!sameOwner) {
    throw new Error("Transcript report target changed its database owner");
  }
  resolved.path = context.databasePath;
  options.path = context.databasePath;
  const database = getOpenClawAgentDatabaseIfOpen(options);
  if (!database || database.db !== context.database || database.path !== context.databasePath) {
    throw new Error("Transcript report lost its canonical database owner");
  }
  const admit = (stage: "transaction" | "commit") =>
    context.admit(stage, (request, dispatch) =>
      requestSessionEntryCurrentAdmission(
        target.sessionEntryCurrentSource,
        request,
        { database },
        dispatch,
      ),
    );
  let closed = false;
  const assertOpen = () => {
    if (closed || !database.db.isOpen) {
      throw new Error("Transcript report domain is closed");
    }
    assertTransactionUsable(database.db);
  };
  const readRefusal = () =>
    resolveTranscriptAppendRefusal(
      readSessionEntryRow(database, resolved.sessionKey, "list")?.entry,
      resolved,
      { ...resolved, ...fence },
    );
  let prepared:
    | {
        facts: PreparedTranscriptReport;
        version: SessionTranscriptContextVersion;
      }
    | undefined;
  return {
    execute(command) {
      assertOpen();
      if (command.type === "prepare") {
        return runSqliteDeferredTransactionSync<
          Result<PreparedTranscriptReport, TranscriptAppendRefusal>
        >(database.db, () => {
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
        });
      }
      return runOpenClawAgentWriteTransaction<
        Result<TranscriptReportCommit, TranscriptAppendRefusal>
      >(
        (current) => {
          if (current.db !== database.db) {
            throw new Error("Transcript report lost its canonical database owner");
          }
          admit("transaction");
          const refusal = readRefusal();
          if (refusal) {
            admit("commit");
            return err(refusal);
          }
          // Coverage needs the host's owner confirmation sent with this very write.
          const coverage =
            command.input.cliHistoryOwnerConfirmed === true ? target.cliWriter : undefined;
          const firstSeq = coverage
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
              admit("commit");
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
              admit("commit");
              commitGranted = true;
            }
          };
          const cliHistoryChanged =
            coverage && firstSeq !== undefined
              ? advanceCliHistoryBoundaryRangeInTransaction(
                  database,
                  resolved,
                  {
                    first: firstSeq,
                    last:
                      readTranscriptContextVersionInTransaction(database, resolved.sessionId)
                        .rawSeq ?? -1,
                  },
                  coverage,
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
