import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { runWithSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { getChildLogger } from "../../logging/logger.js";
import type { OpenClawAgentDatabaseClaim } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-contract.js";
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
  const preparationId = randomUUID();
  const input =
    plan.kind === "maintenance-plan" ? { kind: plan.kind, preparationId } : { kind: plan.kind };
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
    {
      signal: params.signal,
      prepare:
        plan.kind === "maintenance-plan"
          ? (execution, source) => {
              let attempted = false;
              const cleanupSource: AgentDatabaseRequestExecutionSource = {
                assertCurrent: () => execution.assertCurrent(),
                createAdmission(binding) {
                  return () => ({
                    nativeLocations: binding.nativeLocations,
                    admission: createSqliteWorkerOperationAdmission((request, grant) => {
                      if (request.stage !== "prepare") {
                        throw new Error(
                          "Maintenance preparation cleanup cannot open or write storage",
                        );
                      }
                      binding.authorize(request);
                      if (!grant()) {
                        throw new Error("Maintenance preparation cleanup authority expired");
                      }
                    }, binding.attachment),
                  });
                },
              };
              return {
                async prepare() {
                  attempted = true;
                  const prepared = await execution.runExisting(source, async (worker) => {
                    await worker.execute(
                      {
                        type: "session.maintenance.prepare",
                        input: { id: preparationId, input: plan.input },
                      },
                      { signal: params.signal },
                    );
                    return true;
                  });
                  if (!prepared) {
                    throw new Error("Session database disappeared during maintenance preparation");
                  }
                },
                async release() {
                  if (!attempted) {
                    return;
                  }
                  await execution.runExisting(
                    cleanupSource,
                    (worker) =>
                      worker.execute({
                        type: "session.maintenance.release",
                        input: { id: preparationId },
                      }),
                    { retireNativeOnFailure: true },
                  );
                },
              };
            }
          : undefined,
    },
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
