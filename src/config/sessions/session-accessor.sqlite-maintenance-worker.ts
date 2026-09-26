import { performance } from "node:perf_hooks";
import { runWithSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import { getChildLogger } from "../../logging/logger.js";
import type { OpenClawAgentDatabaseClaim } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import type { SqliteSessionReclamationDiagnostics } from "./session-accessor.sqlite-contract.js";
import type {
  ReclamationDatabaseOptions,
  SessionMaintenanceMetadataCommand,
  SessionMaintenanceMetadataResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { invalidateSessionEntryMaintenanceAgeFact } from "./session-accessor.sqlite-maintenance-age.js";
import { logSqliteReclamationWorkerOutcome } from "./session-accessor.sqlite-reclamation-worker-diagnostics.js";
import { runSessionEntryWorkerMutation } from "./session-accessor.sqlite-replacement-worker.js";

export function runSessionMaintenanceMetadataInWorker(params: {
  plan: SessionMaintenanceMetadataCommand & { databaseOptions: ReclamationDatabaseOptions };
  database: OpenClawAgentReadOnlyDatabase;
  claim: OpenClawAgentDatabaseClaim;
  assertCurrent: () => void;
  signal: AbortSignal;
  diagnostics?: SqliteSessionReclamationDiagnostics;
  onWorkerResult?: (
    result: SessionMaintenanceMetadataResult,
    databaseIdentity: string | symbol,
  ) => void;
}): Promise<SessionMaintenanceMetadataResult> {
  const { database, plan, claim } = params;
  params.assertCurrent();
  const identity = claim.identity;
  if (typeof identity !== "string") {
    throw new Error("Session maintenance requires its captured file database");
  }
  const input: SessionMaintenanceMetadataCommand =
    plan.kind === "maintenance-plan" ? { kind: plan.kind, input: plan.input } : { kind: plan.kind };
  const startedAt = performance.now();
  let workerThreadId: number | undefined;
  const observeCompletion = (outcome: "resolved" | "rejected", failure?: unknown) =>
    logSqliteReclamationWorkerOutcome({
      startedAt,
      kind: plan.kind,
      workerThreadId,
      outcome,
      failure,
    });
  return runSessionEntryWorkerMutation<SessionMaintenanceMetadataResult>(
    plan.databaseOptions,
    identity,
    params.assertCurrent,
    async (worker) => {
      const result = await worker.execute({ type: "session.maintenance.metadata", input });
      workerThreadId = result.workerThreadId;
      if (params.diagnostics) {
        params.diagnostics.workerThreadId = result.workerThreadId;
      }
      return result;
    },
    {
      identityAgentId: database.agentId,
      onResult(result) {
        if (!result) {
          // A commit receipt can invalidate rows without recovering the lost planning result.
          invalidateSessionEntryMaintenanceAgeFact(database.db);
          return;
        }
        params.onWorkerResult?.(result, identity);
        if (
          result.kind === "maintenance-statistics" &&
          getOpenClawAgentDatabaseIfOpen(plan.databaseOptions)?.db === database.db
        ) {
          try {
            params.assertCurrent();
            runWithSqliteBusyTimeout(database.db, 0, () => {
              // sqlite-allow-raw -- Reload committed planner metadata without scanning tables.
              database.db.exec("ANALYZE sqlite_schema;");
            });
          } catch (error) {
            try {
              getChildLogger({ subsystem: "session-sqlite" }).warn(
                "Committed SQLite session statistics could not refresh parent planner metadata",
                { agentId: database.agentId, error, path: database.path },
              );
            } catch {
              // Diagnostic transport failure cannot undo the committed result.
            }
          }
        }
      },
    },
    { signal: params.signal },
  ).then(
    (result) => {
      observeCompletion("resolved");
      return result;
    },
    (error: unknown) => {
      observeCompletion("rejected", error);
      throw error;
    },
  );
}
