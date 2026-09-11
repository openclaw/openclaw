import path from "node:path";
import type { z } from "zod";
import {
  parseUpdateRecoveryBackupManifest,
  type UpdateRecoveryBackupManifest,
} from "../commands/backup-verify-manifest.js";
import { resolveConfigPath } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { ensurePrivateSnapshotRepositoryRoot } from "../snapshot/local-repository.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { pinDirectory } from "./directory-durability.js";
import { root as safeRoot } from "./fs-safe.js";
import {
  updateRecoveryBackupRefSchema,
  updateRecoveryTerminalOutcomeSchema,
  type UpdateRecoveryBackupRef,
} from "./update-recovery-backup-contract.js";
import {
  canonicalEntryPath,
  captureDirectory,
  digest,
  MAX_MANIFEST_BYTES,
  statOrMissing,
} from "./update-recovery-backup-files.js";

export const MAX_UPDATE_RECOVERY_OUTCOME_BYTES = 16 * 1024;
type Authority = { assertOwned: () => void };
const recordedOutcomeSchema = updateRecoveryTerminalOutcomeSchema;
type RecordedOutcome = z.infer<typeof recordedOutcomeSchema>;

export function assertManifestLocation(
  ref: UpdateRecoveryBackupRef,
  manifest: UpdateRecoveryBackupManifest,
) {
  if (
    manifest.stateDir !== resolvePathViaExistingAncestorSync(resolveStateDir()) ||
    manifest.configPath !== canonicalEntryPath(resolveConfigPath()) ||
    ref.directory !==
      (manifest.generation && manifest.generation.kind !== "baseline"
        ? path.join(captureDirectory(manifest.runId, manifest.stateDir), manifest.generation.kind)
        : captureDirectory(manifest.runId, manifest.stateDir))
  ) {
    throw new Error("Update recovery backup belongs to another state directory or update run.");
  }
}

export async function withRecoveryMetadata<T>(
  ref: UpdateRecoveryBackupRef,
  authority: Authority,
  run: (state: {
    manifest: UpdateRecoveryBackupManifest;
    outcome?: RecordedOutcome;
    source: Awaited<ReturnType<typeof safeRoot>>;
    pin: Awaited<ReturnType<typeof pinDirectory>>;
  }) => Promise<T>,
): Promise<T> {
  authority.assertOwned();
  updateRecoveryBackupRefSchema.parse(ref);
  if (
    path.resolve(ref.directory) !== ref.directory ||
    ref.manifestPath !== path.join(ref.directory, "manifest.json")
  ) {
    throw new Error("Invalid update recovery manifest locator.");
  }
  await ensurePrivateSnapshotRepositoryRoot(ref.directory);
  const pin = await pinDirectory(ref.directory);
  try {
    const source = await safeRoot(ref.directory);
    const bytes = await source.read("manifest.json", {
      maxBytes: MAX_MANIFEST_BYTES,
      symlinks: "reject",
      hardlinks: "reject",
    });
    if (digest(bytes.buffer) !== ref.manifestSha256) {
      throw new Error("Update recovery manifest changed before metadata access.");
    }
    const manifest = parseUpdateRecoveryBackupManifest(bytes.buffer.toString("utf8"));
    assertManifestLocation(ref, manifest);
    let outcome: RecordedOutcome | undefined;
    if (await statOrMissing(path.join(ref.directory, "outcome.json"))) {
      outcome = recordedOutcomeSchema.parse(
        JSON.parse(
          (
            await source.read("outcome.json", {
              maxBytes: MAX_UPDATE_RECOVERY_OUTCOME_BYTES,
              symlinks: "reject",
              hardlinks: "reject",
            })
          ).buffer.toString("utf8"),
        ),
      );
      if (outcome.manifestSha256 !== ref.manifestSha256) {
        throw new Error("Update recovery outcome refers to another manifest.");
      }
    }
    await pin.assertCurrent();
    authority.assertOwned();
    return await run({ manifest, outcome, source, pin });
  } finally {
    await pin.close();
  }
}

/** Metadata remains available when terminal cleanup has already removed some payloads. */
export async function readUpdateRecoveryBackupManifest(
  ref: UpdateRecoveryBackupRef,
  authority: Authority,
): Promise<UpdateRecoveryBackupManifest> {
  return await withRecoveryMetadata(ref, authority, async ({ manifest }) => manifest);
}

/** Parse the exact manifest binding passed to the target Doctor. */
export function readUpdateRecoveryBackupRef(value: string): UpdateRecoveryBackupRef {
  return updateRecoveryBackupRefSchema.parse(JSON.parse(value));
}
