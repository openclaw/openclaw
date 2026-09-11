import type { UpdateRecoveryBackupRef } from "./update-recovery-backup-contract.js";

/** Typed only at the no-publication boundary, never inferred from retained artifacts. */
export class UpdateRecoveryPublicationUnavailableError extends Error {
  override name = "UpdateRecoveryPublicationUnavailableError";
}

/** No baseline-only caller may overwrite a stopped candidate, including legacy Doctor.
 * Package-only recovery currently cannot resume reverse publication, and released
 * 9.2/9.3 cannot enforce a mixed-state bootstrap fence or explicit agent preflight.
 * Keep this refusal at reverse admission, never at forward-update admission. */
export async function assertUpdateRecoveryPublicationPrepared(
  baseline: UpdateRecoveryBackupRef,
  candidate: UpdateRecoveryBackupRef,
  authority: { assertOwned: () => void },
): Promise<never> {
  const { prepareUpdateRecoveryGeneration } = await import("./update-recovery-backup.js");
  const prepared = await prepareUpdateRecoveryGeneration(baseline, candidate, authority);
  authority.assertOwned();
  throw new UpdateRecoveryPublicationUnavailableError(
    `Rollback publication is unavailable: the selected older runtime must provide exact per-agent preflight and mixed-generation startup admission, and the package owner must provide restartable reverse publication. No package or state was replaced. Baseline: ${baseline.manifestPath}; candidate: ${candidate.manifestPath}; prepared generation: ${prepared.manifestPath}. Inspect openclaw update status --json. This does not prohibit a compatible forward update or require stopping a functioning candidate.`,
  );
}
