import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import { captureNativeSessionWorkerDeletion } from "./session-accessor.sqlite-deletion.js";
import type {
  ReclamationDatabaseOptions,
  SessionMaintenanceMetadataResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  collectReclamationDeletionEntries,
  prepareReclamationPublication,
} from "./session-accessor.sqlite-reclamation-publication.js";
import {
  runSessionEntryWorkerMutation,
  withSessionEntryWorker,
} from "./session-accessor.sqlite-replacement-worker.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import type {
  SessionMaintenanceFinalizationCommitted,
  SessionMaintenanceFinalizationPlan,
  SessionMaintenanceFinalizationResult,
} from "./session-maintenance-finalization.types.js";
import { runSessionNativeBindingWorkerOperation } from "./session-native-binding.js";

export function readSessionMaintenanceArchiveSizesInWorker(
  database: ReclamationDatabaseOptions,
  sessionIds: string[],
  execution: OpenClawAgentDatabaseExecution,
  assertCurrent: () => void,
): Promise<Map<string, number>> {
  return withSessionEntryWorker(
    database,
    undefined,
    assertCurrent,
    async (owner, source) => {
      const result = await owner.runExisting(source, (worker) =>
        worker.execute({ type: "session.maintenance.size", input: { sessionIds } }),
      );
      if (!result) {
        throw new Error("Session database disappeared before maintenance sizing");
      }
      return result;
    },
    undefined,
    execution,
  );
}

export async function refreshSessionMaintenanceStatisticsInWorker(
  database: ReclamationDatabaseOptions,
  execution: OpenClawAgentDatabaseExecution,
  assertCurrent: () => void,
): Promise<void> {
  execution.assertCurrent();
  const identity = execution.fileIdentity;
  if (!identity) {
    throw new Error("Session maintenance lost its admitted database");
  }
  await runSessionEntryWorkerMutation<SessionMaintenanceMetadataResult>(
    database,
    identity.physicalIdentity,
    assertCurrent,
    (worker) =>
      worker.execute({
        type: "session.maintenance.metadata",
        input: { kind: "maintenance-statistics" },
      }),
    { identityAgentId: database.agentId },
    { retainedExecution: execution },
  );
}

/** Keep cleanup admission and participant settlement on the caller's original executor. */
export function finalizeSessionMaintenanceInWorker(
  plan: SessionMaintenanceFinalizationPlan,
  execution: OpenClawAgentDatabaseExecution,
  assertCurrent: () => void,
): Promise<SessionMaintenanceFinalizationResult> {
  const entries = collectReclamationDeletionEntries(plan);
  const captured = captureNativeSessionWorkerDeletion(entries);
  const operation: Omit<
    Parameters<
      typeof runSessionEntryWorkerOperation<
        SessionMaintenanceFinalizationCommitted,
        SessionMaintenanceFinalizationResult
      >
    >[0],
    "run"
  > = {
    database: plan.databaseOptions,
    agentId: plan.agentId,
    retainedExecution: execution,
    assertCurrent,
    candidateKind: "session-maintenance-finalize",
    onCommitted(candidate, _published, identity) {
      prepareReclamationPublication(plan, identity, candidate.result)?.();
      return candidate.result;
    },
  };
  return captured
    ? runSessionNativeBindingWorkerOperation<
        SessionMaintenanceFinalizationCommitted,
        SessionMaintenanceFinalizationResult
      >({
        ...operation,
        captured,
        entries,
        execute: (worker, nativeBindings) =>
          worker.execute({ type: "session.maintenance.finalize", input: { plan, nativeBindings } }),
      })
    : runSessionEntryWorkerOperation<
        SessionMaintenanceFinalizationCommitted,
        SessionMaintenanceFinalizationResult
      >({
        ...operation,
        run: (worker, commit) =>
          commit(() => worker.execute({ type: "session.maintenance.finalize", input: { plan } })),
      });
}
