import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  readWorkspaceStateSnapshot,
  type WorkspaceStateSnapshot,
} from "./workspace-state-store.js";
import type { WorkspaceStateGuard } from "./workspace-state-store.worker-contract.js";

export async function readCanonicalWorkspaceStateSnapshot(
  dir: string,
  options: OpenClawStateDatabaseOptions = {},
  guard?: WorkspaceStateGuard,
): Promise<WorkspaceStateSnapshot> {
  const snapshot = await readWorkspaceStateSnapshot(dir, {
    ...options,
    checkLegacySources: true,
    assertCurrent: guard?.assertHost,
    filesystem: guard?.filesystem,
    stateOwnerPath: guard?.stateOwnerPath,
    recoveryHoldPredicate: guard?.recoveryHoldPredicate,
    beforeLegacyApply: guard?.beforeLegacyApply,
  });
  guard?.assertHost?.();
  return snapshot;
}
