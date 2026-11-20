import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import {
  assertAgentDeletionRecoveryHoldPredicate,
  type AgentDeletionRecoveryHoldPredicate,
} from "../state/agent-deletion-journal-recovery.kernel.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { WorkspaceStateGuard } from "./workspace-state-store.worker-contract.js";

/** Admit only the synchronous hold read; the caller's effects remain outside admission. */
export function assertCurrentAgentDeletionRecoveryHolds(
  predicate: AgentDeletionRecoveryHoldPredicate,
): void {
  withEngineStoreAdmission(() =>
    withExistingOpenClawStateDatabaseCurrentReadOnly(
      (database) => assertAgentDeletionRecoveryHoldPredicate(database, predicate),
      { allowNativeRead: true },
    ),
  );
}

/** Filesystem grants retain the current recovery read, outside SQLite writer grants. */
export function createWorkspaceFileMutationGuard(
  guard?: WorkspaceStateGuard,
): (() => void) | undefined {
  if (!guard) {
    return undefined;
  }
  return () => {
    guard.assertHost?.();
    guard.beforeLegacyApply?.();
    const predicate = guard.recoveryHoldPredicate;
    if (predicate?.applies) {
      assertCurrentAgentDeletionRecoveryHolds(predicate);
    }
  };
}
