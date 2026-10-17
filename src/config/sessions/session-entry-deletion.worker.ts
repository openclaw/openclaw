import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { prepareSessionDeletionInDatabase } from "./session-accessor.sqlite-deletion-plan.js";
import type { SessionDeletionPlanningOperation } from "./session-accessor.sqlite-lifecycle-types.js";
import {
  collectReclamationChangedSessionKeys,
  collectReclamationDeletionEntries,
} from "./session-accessor.sqlite-reclamation-publication.js";
import { reclaimSqliteSessionInTransaction } from "./session-accessor.sqlite-reclamation.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import type {
  SessionEntryDeletionCommitted,
  SessionEntryDeletionInput,
} from "./session-entry-deletion.types.js";
import type { SessionEntryPatchReceipt } from "./session-entry-patch.types.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import { runSessionNativeBindingTransaction } from "./session-native-binding.worker.js";
import type { SessionEntry } from "./types.js";

export function planSessionDeletionInAgentWorker(
  planning: SessionDeletionPlanningOperation,
  { open }: AgentWorkerOperationContext,
) {
  const database = open();
  return runSqliteReadSnapshotSync(database.db, () =>
    prepareSessionDeletionInDatabase(database, planning),
  );
}

export function deleteSessionEntryInAgentWorker(
  input: SessionEntryDeletionInput,
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
    const result = reclaimSqliteSessionInTransaction(plan);
    if (result.kind !== "entry") {
      throw new Error("Session entry deletion returned another reclamation operation");
    }
    const changedKeys = result.value.deleted
      ? collectReclamationChangedSessionKeys(plan, result)
      : [];
    const removedEntries = collectReclamationDeletionEntries(plan, result);
    const publication =
      changedKeys.length > 0
        ? prepareSessionEntryReplacementPublication(
            {
              previous: new Map(removedEntries.map(({ sessionKey, entry }) => [sessionKey, entry])),
              current: new Map<string, SessionEntry>(),
              pendingArchiveRecovery: false,
              membershipInvalidatedKeys: changedKeys,
              maintenancePlans: [],
            },
            database,
          )
        : undefined;
    if (publication && result.value.transcriptInventoryUnchanged) {
      publication.transcriptInventoryUnchanged = true;
    }
    const candidate: SessionEntryDeletionCommitted = {
      kind: "session-entry-deletion",
      result,
      publication,
    };
    return transferSessionEntryWorkerCandidate(database, context.admit, candidate, wrapReceipt);
  };
  return input.nativeBindings
    ? runSessionNativeBindingTransaction(
        input.nativeBindings,
        context,
        "session.lifecycle.delete",
        "Session entry deletion",
        mutate,
      )
    : context.writeTransaction("session.lifecycle.delete", "Session entry deletion", (database) =>
        mutate(database, (receipt) => receipt),
      );
}
