import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  isUpdateRecoveryPending,
  decodeUpdateRecovery,
  UpdateRecoveryRequiredError,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";
import { inspectRecoveryRows, readRecovery } from "./update-run-recovery-store.js";
export type { UpdateRecoveryFence, UpdateRecoveryHandoff } from "./update-run-recovery-types.js";
export { UpdateRecoveryRequiredError } from "./update-run-recovery-schema.js";
export type { UpdateRecoveryRecord } from "./update-run-recovery-schema.js";
export { inspectUpdateRecoveries } from "./update-run-recovery-store.js";
export function loadUpdateRecovery(
  runId: string,
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryRecord | undefined {
  return withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
    ({ db }) => readRecovery(db, runId),
    options,
  );
}
/** Detection only. This delivery never claims, rewrites, or retires retained recovery. */
export function assertNoPendingUpdateRecovery(options: OpenClawStateDatabaseOptions = {}): void {
  // Candidate children can migrate the ledger after this updater admitted its original format.
  const pending = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
    ({ db }) => inspectRecoveryRows(db).find((entry) => isUpdateRecoveryPending(entry.record)),
    options,
    openDoctorStateSchemaReadAdmission,
  );
  if (pending) {
    // Historical completion does not grant current execution authority. An
    // unfinished legacy operation still requires explicit compatible recovery.
    throw new UpdateRecoveryRequiredError(decodeUpdateRecovery(pending.raw, pending.record.runId));
  }
}
