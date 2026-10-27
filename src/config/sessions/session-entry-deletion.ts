import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import { captureNativeSessionWorkerDeletion } from "./session-accessor.sqlite-deletion.js";
import { collectReclamationDeletionEntries } from "./session-accessor.sqlite-reclamation-publication.js";
import type {
  SessionEntryDeletionCommitted,
  SessionEntryDeletionPlan,
  SessionEntryDeletionResult,
} from "./session-entry-deletion.types.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import { runSessionNativeBindingWorkerOperation } from "./session-native-binding.js";

export function deleteSessionEntryInWorker(
  plan: SessionEntryDeletionPlan,
  execution: OpenClawAgentDatabaseExecution,
  assertCurrent: (operation?: RetainedWorkerTransactionAdmission) => void,
  onResult?: (result: SessionEntryDeletionResult, identity: string) => void,
): Promise<SessionEntryDeletionResult> {
  const entries = collectReclamationDeletionEntries(plan);
  const captured = captureNativeSessionWorkerDeletion(entries);
  const operation: Omit<
    Parameters<
      typeof runSessionEntryWorkerOperation<
        SessionEntryDeletionCommitted,
        SessionEntryDeletionResult
      >
    >[0],
    "run"
  > = {
    database: plan.databaseOptions,
    agentId: plan.databaseOptions.agentId,
    retainedExecution: execution,
    assertCurrent,
    assertCandidate: (_candidate, retained) => assertCurrent(retained),
    candidateKind: "session-entry-deletion",
    onCommitted(candidate, _published, identity) {
      onResult?.(candidate.result, identity);
      return candidate.result;
    },
  };
  return captured
    ? runSessionNativeBindingWorkerOperation<
        SessionEntryDeletionCommitted,
        SessionEntryDeletionResult
      >({
        ...operation,
        captured,
        entries,
        execute: (worker, nativeBindings) =>
          worker.execute({ type: "session.lifecycle.delete", input: { plan, nativeBindings } }),
      })
    : runSessionEntryWorkerOperation<SessionEntryDeletionCommitted, SessionEntryDeletionResult>({
        ...operation,
        run: (worker, commit) =>
          commit(() => worker.execute({ type: "session.lifecycle.delete", input: { plan } })),
      });
}
