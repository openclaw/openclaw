import path from "node:path";
import { withConfigMutationLock } from "../config/mutate.js";
import type { UpdateRecoveryBackupRef } from "./update-recovery-backup-contract.js";
import { captureUpdateRecoveryBackup } from "./update-recovery-backup-create.js";
import { statOrMissing } from "./update-recovery-backup-files.js";
import { prepareVerifiedBackup } from "./update-recovery-backup-verify.js";
import {
  bindUpdateRecoverySourceAssertions,
  type UpdateRecoverySourcePublication,
  type UpdateRecoverySourceAttestationRef,
} from "./update-recovery-source-publication.js";
type Authority = { assertOwned: () => void; env: NodeJS.ProcessEnv };
async function verifyUpdateRecoveryBackup(ref: UpdateRecoveryBackupRef, env: NodeJS.ProcessEnv) {
  const verified = await prepareVerifiedBackup(ref, { env });
  try {
    return verified.manifest;
  } finally {
    await verified.close();
  }
}

/** First stopped-C capture only, under the continuing original publication owner.
 * Existing C cannot be re-attested from later live state or a replacement scope. */
export async function preserveUpdateRecoveryCandidateWithSource(
  ref: UpdateRecoveryBackupRef,
  authority: Authority,
  publication: UpdateRecoverySourcePublication,
): Promise<{
  candidate: UpdateRecoveryBackupRef;
  sourceAttestationRef: UpdateRecoverySourceAttestationRef;
}> {
  const assertCurrent = bindUpdateRecoverySourceAssertions(authority, publication);
  const sourcePublication = { operationId: publication.operationId, assertCurrent };
  const env = authority.env;
  const preserved = await withConfigMutationLock({}, async () => {
    const baseline = await prepareVerifiedBackup(ref, { env });
    let preservationFailure: { error: unknown } | undefined;
    try {
      if (
        baseline.manifest.schemaVersion !== 2 ||
        baseline.manifest.generation?.kind !== "baseline"
      ) {
        throw new Error(
          `Legacy update recovery set is inspection-only: ${ref.manifestPath}. It has no lossless candidate/publication contract; no package or state replacement is permitted. Inspect openclaw update status --json.`,
        );
      }
      // The original caller flushes authored receipts before acquiring physical
      // source exclusion; C never opens a canonical writer to manufacture them.
      await baseline.assertCurrent();
      assertCurrent();
      const directory = path.join(ref.directory, "candidate");
      if (await statOrMissing(directory)) {
        throw new Error(
          "Existing candidate cannot acquire a new source attestation; retain its original binding.",
        );
      }
      const { ref: candidate, sourceAttestationRef } = await captureUpdateRecoveryBackup({
        assertOwned: assertCurrent,
        env,
        runId: baseline.manifest.runId,
        installRoot: baseline.manifest.installRoot,
        drivers: baseline.manifest.drivers,
        baseline: { ref, manifest: baseline.manifest },
        sourcePublication,
      });
      const manifest = await verifyUpdateRecoveryBackup(candidate, env);
      await baseline.assertCurrent();
      assertCurrent();
      if (
        manifest.generation?.kind !== "candidate" ||
        manifest.generation.baselineSha256 !== ref.manifestSha256
      ) {
        throw new Error(
          `Candidate generation belongs to another baseline: ${candidate.manifestPath}`,
        );
      }
      return { candidate, sourceAttestationRef };
    } catch (error) {
      preservationFailure = { error };
      throw error;
    } finally {
      await baseline.close().catch((cleanupError: unknown) => {
        if (preservationFailure) {
          throw new AggregateError(
            [preservationFailure.error, cleanupError],
            `Candidate preservation failed and verification staging cleanup also failed. Baseline and candidate evidence remain retained at ${ref.manifestPath}.`,
            { cause: preservationFailure.error },
          );
        }
        throw cleanupError;
      });
    }
  });
  assertCurrent();
  if (!preserved.sourceAttestationRef) {
    throw new Error("Candidate source attestation was not sealed.");
  }
  return { candidate: preserved.candidate, sourceAttestationRef: preserved.sourceAttestationRef };
}
