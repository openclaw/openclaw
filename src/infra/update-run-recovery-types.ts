import type { UpdateRecoveryRecord } from "./update-run-recovery-schema.js";
/** Current executor-held exclusion, never deserialized. CAS does not authorize effects. */
export type UpdateRecoveryFence = { assertCurrent: () => void };
type UpdateRecoveryRevision = Pick<
  UpdateRecoveryRecord,
  "runId" | "transactionId" | "revision" | "claimId"
>;

/** Correlation only. The receiving runtime must independently reacquire authority. */
export type UpdateRecoveryHandoff = UpdateRecoveryRevision & { handoffId: string };
