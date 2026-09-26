import path from "node:path";
import { withConfigMutationLock } from "../config/mutate.js";
import { root as safeRoot } from "./fs-safe.js";
import type { UpdateRecoveryBackupRef } from "./update-recovery-backup-contract.js";
import { captureUpdateRecoveryBackup } from "./update-recovery-backup-create.js";
import { digest, MAX_MANIFEST_BYTES, statOrMissing } from "./update-recovery-backup-files.js";
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
  publication: Omit<UpdateRecoverySourcePublication, "onSealed">,
): Promise<{
  candidate: UpdateRecoveryBackupRef;
  sourceAttestationRef: UpdateRecoverySourceAttestationRef;
}> {
  let sealed: UpdateRecoverySourceAttestationRef | undefined;
  const assertCurrent = bindUpdateRecoverySourceAssertions(authority, publication);
  const candidate = await preserveCandidate(
    ref,
    { assertOwned: assertCurrent, env: authority.env },
    {
      operationId: publication.operationId,
      assertCurrent,
      onSealed(value) {
        if (sealed) {
          throw new Error("Candidate source was already sealed.");
        }
        sealed = value;
      },
    },
  );
  assertCurrent();
  if (!sealed) {
    throw new Error("Candidate source attestation was not sealed.");
  }
  return { candidate, sourceAttestationRef: sealed };
}

async function preserveCandidate(
  ref: UpdateRecoveryBackupRef,
  authority: Authority,
  sourcePublication?: UpdateRecoverySourcePublication,
): Promise<UpdateRecoveryBackupRef> {
  return await withConfigMutationLock({}, async () => {
    const baseline = await prepareVerifiedBackup(ref, { env: authority.env });
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
      authority.assertOwned();
      const directory = path.join(ref.directory, "candidate");
      let candidate: UpdateRecoveryBackupRef;
      if (await statOrMissing(directory)) {
        if (sourcePublication) {
          throw new Error(
            "Existing candidate cannot acquire a new source attestation; retain its original binding.",
          );
        }
        const source = await safeRoot(directory);
        let raw: Buffer;
        try {
          raw = (
            await source.read("manifest.json", {
              maxBytes: MAX_MANIFEST_BYTES,
              symlinks: "reject",
              hardlinks: "reject",
            })
          ).buffer;
        } catch (cause) {
          throw new Error(
            `Candidate preservation is incomplete at ${directory}; baseline and partial candidate retained. Do not overwrite or remove either generation. Inspect openclaw update status --json.`,
            { cause },
          );
        }
        candidate = {
          directory,
          manifestPath: path.join(directory, "manifest.json"),
          manifestSha256: digest(raw),
        };
      } else {
        candidate = await captureUpdateRecoveryBackup({
          ...authority,
          runId: baseline.manifest.runId,
          installRoot: baseline.manifest.installRoot,
          drivers: baseline.manifest.drivers,
          baseline: { ref, manifest: baseline.manifest },
          sourcePublication,
        });
      }
      const manifest = await verifyUpdateRecoveryBackup(candidate, authority.env);
      await baseline.assertCurrent();
      authority.assertOwned();
      if (
        manifest.generation?.kind !== "candidate" ||
        manifest.generation.baselineSha256 !== ref.manifestSha256
      ) {
        throw new Error(
          `Candidate generation belongs to another baseline: ${candidate.manifestPath}`,
        );
      }
      return candidate;
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
}
