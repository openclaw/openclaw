import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  isUpdateRecoveryPending,
  UpdateRecoveryRequiredError,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";
import { readRecoveries } from "./update-run-recovery-store.js";
export type { UpdateRecoveryFence, UpdateRecoveryHandoff } from "./update-run-recovery-types.js";
export { UpdateRecoveryRequiredError } from "./update-run-recovery-schema.js";
export type { UpdateRecoveryRecord } from "./update-run-recovery-schema.js";
export { inspectUpdateRecoveries } from "./update-run-recovery-store.js";
/** Must run before general database open, admission writes, or runtime migration. */
function loadUpdateRecoveries(options: OpenClawStateDatabaseOptions = {}): UpdateRecoveryRecord[] {
  return (
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => readRecoveries(db),
      options,
    ) ?? []
  );
}
export function loadUpdateRecovery(
  runId: string,
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryRecord | undefined {
  return loadUpdateRecoveries(options).find((record) => record.runId === runId);
}
/** Detection only. This delivery never claims, rewrites, or retires retained recovery. */
export function assertNoPendingUpdateRecovery(options: OpenClawStateDatabaseOptions = {}): void {
  const pending = loadUpdateRecoveries(options).find(isUpdateRecoveryPending);
  if (pending) {
    throw new UpdateRecoveryRequiredError(pending);
  }
}
