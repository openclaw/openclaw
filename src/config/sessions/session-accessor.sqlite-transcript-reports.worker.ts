import { isDeepStrictEqual } from "node:util";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { sqlPublicationAnchor, type EngineConnection } from "../../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { bindSqliteWorkerDatabase } from "../../infra/sqlite-worker-binding.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseAdmissionRestriction } from "../../state/openclaw-agent-execution-domain.js";
import type { CliHistoryWriterFacts } from "./cli-history-boundary.js";
import { advanceCliHistoryBoundaryRangeInTransaction } from "./session-accessor.sqlite-cli-history-boundary.js";
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
import type { InternalSessionEntry } from "./types.js";

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
    database: EngineConnection;
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
  const sameOwner = sqlPublicationAnchor(context.database).location()
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
  const readCurrentEntry = () => {
    const entry = readSessionEntryRow(database, resolved.sessionKey, "list")?.entry;
    return {
      entry,
      refusal: resolveTranscriptAppendRefusal(entry, resolved, { ...resolved, ...fence }),
    };
  };
  let prepared:
    | {
        facts: PreparedTranscriptReport;
        version: SessionTranscriptContextVersion;
      }
    | undefined;
  return bindSqliteWorkerDatabase<TranscriptReportWorkerOperations>(database.db, {
    execute(command) {
      if (command.type === "prepare") {
        return runSqliteReadSnapshotSync<Result<PreparedTranscriptReport, TranscriptAppendRefusal>>(
          database.db,
          () => {
            prepared = undefined;
            const { refusal } = readCurrentEntry();
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
      return runOpenClawAgentWriteTransaction<
        Result<TranscriptReportCommit, TranscriptAppendRefusal>
      >(
        (current) => {
          if (current.db !== database.db) {
            throw new Error("Transcript report lost its canonical database owner");
          }
          admit("transaction");
          const { refusal } = readCurrentEntry();
          if (refusal) {
            admit("commit");
            return err(refusal);
          }
          const firstSeq = target.cliWriter
            ? (readTranscriptContextVersionInTransaction(database, resolved.sessionId).rawSeq ??
                -1) + 1
            : undefined;
          let projectionNeedsReconcile = false;
          let fullEntry: InternalSessionEntry | undefined;
          const onEntryUpdated = (entry: InternalSessionEntry) => {
            fullEntry = entry;
          };
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
              onEntryUpdated,
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
                  onEntryUpdated,
                )
              : false;
          const { entry, refusal: rebound } = readCurrentEntry();
          if (rebound) {
            throw new SessionTranscriptWriterClaimReboundError(rebound);
          }
          authorizeCommit();
          return ok({
            committed: true,
            projectionNeedsReconcile,
            cliHistoryChanged,
            ...((cliHistoryChanged ||
              (abortedPartial && !abortedPartial.skipped && abortedPartial.append.appended)) && {
              entry,
              fullEntry,
            }),
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
    close() {
      prepared = undefined;
    },
  });
}
