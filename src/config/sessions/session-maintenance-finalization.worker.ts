import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { finalizeSessionMaintenanceInDatabase } from "./session-accessor.sqlite-maintenance-transaction.js";
import { collectReclamationEntryReplacement } from "./session-accessor.sqlite-reclamation-publication.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import type { SessionEntryPatchReceipt } from "./session-entry-patch.types.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import type {
  SessionMaintenanceFinalizationCommitted,
  SessionMaintenanceFinalizationInput,
} from "./session-maintenance-finalization.types.js";
import { runSessionNativeBindingTransaction } from "./session-native-binding.worker.js";

export function finalizeSessionMaintenance(
  input: SessionMaintenanceFinalizationInput,
  context: AgentWorkerOperationContext,
) {
  const plan = {
    ...input.plan,
    databaseOptions: { ...input.plan.databaseOptions, ...context.options },
  };
  const mutate = <Receipt extends object>(
    database: OpenClawAgentDatabase,
    wrapReceipt: (receipt: SessionEntryPatchReceipt) => Receipt,
  ): Receipt => {
    const result = finalizeSessionMaintenanceInDatabase(database, plan);
    const replacement = collectReclamationEntryReplacement(plan, result);
    const publication = replacement
      ? prepareSessionEntryReplacementPublication(replacement, database)
      : undefined;
    const candidate: SessionMaintenanceFinalizationCommitted = {
      kind: "session-maintenance-finalize",
      result,
      publication,
    };
    const receipt = transferSessionEntryWorkerCandidate(
      database,
      context.admit,
      candidate,
      wrapReceipt,
    );
    return receipt;
  };
  return input.nativeBindings
    ? runSessionNativeBindingTransaction(
        input.nativeBindings,
        context,
        "session.maintenance.finalize",
        "Session maintenance",
        mutate,
      )
    : context.writeTransaction("session.maintenance.finalize", "Session maintenance", (database) =>
        mutate(database, (receipt) => receipt),
      );
}
