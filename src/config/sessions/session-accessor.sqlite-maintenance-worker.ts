import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import type { SqliteSessionReclamationDiagnostics } from "./session-accessor.sqlite-contract.js";
import type {
  ReclamationDatabaseOptions,
  SessionMaintenanceLiveProtection,
  SessionMaintenanceMetadataCommand,
  SessionMaintenanceMetadataResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { invalidateSessionEntryMaintenanceAgeFact } from "./session-accessor.sqlite-maintenance-age.js";
import type { SqliteReclamationClaim } from "./session-accessor.sqlite-reclamation-worker.types.js";
import { runSessionEntryWorkerMutation } from "./session-accessor.sqlite-replacement-worker.js";
import type { SessionMaintenancePreservationPlan } from "./store-maintenance-preserve-snapshot.types.js";

export function runSessionMaintenanceMetadataInWorker(params: {
  plan: SessionMaintenanceMetadataCommand & { databaseOptions: ReclamationDatabaseOptions };
  claim: SqliteReclamationClaim;
  assertCurrent: () => void;
  assertMaintenanceCommitAllowed?: (plans?: readonly SessionMaintenancePreservationPlan[]) => void;
  refreshMaintenanceProtection?: () => SessionMaintenanceLiveProtection;
  signal: AbortSignal;
  diagnostics?: SqliteSessionReclamationDiagnostics;
  onWorkerResult?: (
    result: SessionMaintenanceMetadataResult,
    databaseIdentity: string | symbol,
  ) => void;
}): Promise<SessionMaintenanceMetadataResult> {
  const { plan, claim } = params;
  params.assertCurrent();
  const identity = claim.identity;
  if (typeof identity !== "string") {
    throw new Error("Session maintenance requires its captured file database");
  }
  return runSessionEntryWorkerMutation<SessionMaintenanceMetadataResult>(
    plan.databaseOptions,
    identity,
    params.assertCurrent,
    async (worker) => {
      const input =
        plan.kind === "maintenance-plan"
          ? {
              kind: plan.kind,
              protection: {
                activeSessionKeys: plan.input.activeSessionKeys,
                preservation: plan.input.preservation,
              },
            }
          : plan;
      const result = await worker.execute({ type: "session.maintenance.metadata", input });
      if (params.diagnostics) {
        params.diagnostics.workerThreadId = result.workerThreadId;
      }
      return result;
    },
    {
      identityAgentId: plan.databaseOptions.agentId,
      beforeCommit(publication) {
        if (plan.kind === "maintenance-plan") {
          params.assertMaintenanceCommitAllowed?.(publication.maintenancePlans);
        }
      },
      onResult(result) {
        const openDatabase = getOpenClawAgentDatabaseIfOpen(plan.databaseOptions);
        const database =
          openDatabase && findOpenClawAgentDatabaseIdentity(openDatabase)?.identity === identity
            ? openDatabase
            : undefined;
        if (!result) {
          // A commit receipt can invalidate rows without recovering the lost planning result.
          if (database) {
            invalidateSessionEntryMaintenanceAgeFact(database.db);
          }
          return;
        }
        params.onWorkerResult?.(result, identity);
      },
    },
    {
      signal: params.signal,
      prepare:
        plan.kind === "maintenance-plan"
          ? (execution, source) => ({
              runOptions: { retireNativeOnFailure: true },
              beforeWrite() {
                Object.assign(plan.input, params.refreshMaintenanceProtection?.());
                params.assertCurrent();
              },
              async prepare() {
                const prepared = await execution.runExisting(source, async (worker) => {
                  await worker.execute(
                    {
                      type: "session.maintenance.prepare",
                      input: {
                        input: plan.input,
                        ageChanges: plan.ageChanges,
                      },
                    },
                    { signal: params.signal },
                  );
                  return true;
                });
                if (!prepared) {
                  throw new Error("Session database disappeared during maintenance preparation");
                }
              },
            })
          : undefined,
    },
  );
}
