import fs from "node:fs/promises";
import path from "node:path";
import { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/engine-storage.js";
import { parseUpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import { ensurePrivateSnapshotRepositoryRoot } from "../snapshot/local-repository.js";
import { pinDirectory, sha256File } from "./directory-durability.js";
import { copyFileHandle, sameFileMutationFingerprint } from "./file-descriptor.js";
import { root as safeRoot } from "./fs-safe.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { createPrivateSqliteTempDirectory } from "./sqlite-private-directory.js";
import {
  updateRecoveryBackupRefSchema,
  type UpdateRecoveryBackupRef,
} from "./update-recovery-backup-contract.js";
import { digest, MAX_MANIFEST_BYTES } from "./update-recovery-backup-files.js";
import { assertManifestLocation } from "./update-recovery-backup-metadata.js";

/** Private verified copies bind B/C/T without exposing mutable source payloads. */
export async function prepareVerifiedBackup(ref: UpdateRecoveryBackupRef) {
  updateRecoveryBackupRefSchema.parse(ref);
  if (
    path.resolve(ref.directory) !== ref.directory ||
    ref.manifestPath !== path.join(ref.directory, "manifest.json")
  ) {
    throw new Error("Invalid update recovery manifest locator.");
  }
  if (!(await fs.lstat(ref.directory)).isDirectory()) {
    throw new Error("Update recovery backup is not a directory.");
  }
  await ensurePrivateSnapshotRepositoryRoot(ref.directory);
  const directoryPin = await pinDirectory(ref.directory);
  let staging: string | undefined;
  const close = async () => {
    try {
      await directoryPin.assertCurrent();
      if (staging) {
        await fs.rm(staging, { recursive: true });
      }
    } finally {
      await directoryPin.close();
    }
  };
  try {
    const sourceRoot = await safeRoot(ref.directory);
    const raw = (
      await sourceRoot.read("manifest.json", {
        maxBytes: MAX_MANIFEST_BYTES,
        symlinks: "reject",
        hardlinks: "reject",
      })
    ).buffer.toString("utf8");
    if (digest(raw) !== ref.manifestSha256) {
      throw new Error("Update recovery manifest hash mismatch.");
    }
    const manifest = parseUpdateRecoveryBackupManifest(raw);
    assertManifestLocation(ref, manifest);
    if (manifest.generation && manifest.generation.kind !== "baseline") {
      const baselineRoot = await safeRoot(path.dirname(ref.directory));
      const baselineRaw = (
        await baselineRoot.read("manifest.json", {
          maxBytes: MAX_MANIFEST_BYTES,
          symlinks: "reject",
          hardlinks: "reject",
        })
      ).buffer;
      const baseline = parseUpdateRecoveryBackupManifest(baselineRaw.toString("utf8"));
      if (
        digest(baselineRaw) !== manifest.generation.baselineSha256 ||
        baseline.generation?.kind !== "baseline" ||
        baseline.runId !== manifest.runId ||
        baseline.installRoot !== manifest.installRoot ||
        baseline.stateDir !== manifest.stateDir ||
        baseline.configPath !== manifest.configPath
      ) {
        throw new Error("Update recovery generation does not belong to its retained baseline.");
      }
    }
    if (manifest.generation?.kind === "prepared") {
      const candidateRoot = await safeRoot(path.join(path.dirname(ref.directory), "candidate"));
      const candidateRaw = (
        await candidateRoot.read("manifest.json", {
          maxBytes: MAX_MANIFEST_BYTES,
          symlinks: "reject",
          hardlinks: "reject",
        })
      ).buffer;
      const candidate = parseUpdateRecoveryBackupManifest(candidateRaw.toString("utf8"));
      if (
        digest(candidateRaw) !== manifest.generation.candidateSha256 ||
        candidate.generation?.kind !== "candidate" ||
        candidate.generation.baselineSha256 !== manifest.generation.baselineSha256
      ) {
        throw new Error("Prepared recovery generation does not belong to its retained candidate.");
      }
    }
    staging = await createPrivateSqliteTempDirectory(ref.directory, ".verify-");
    const payloads = new Map<string, string>();
    for (const entry of manifest.entries) {
      if (entry.kind !== "file") {
        continue;
      }
      await directoryPin.assertCurrent();
      const source = await sourceRoot.open(entry.archivePath, {
        symlinks: "reject",
        hardlinks: "reject",
      });
      const targetPath = path.join(staging, path.basename(entry.archivePath));
      const target = await fs.open(targetPath, "wx+", 0o600);
      try {
        const before = await source.handle.stat({ bigint: true });
        await copyFileHandle(source.handle, target, {
          noProgressMessage: "Update recovery staging copy made no progress.",
        });
        const actual = await sha256File(target);
        if (
          !sameFileMutationFingerprint(before, await source.handle.stat({ bigint: true })) ||
          actual.bytes !== entry.size ||
          actual.digest !== entry.sha256
        ) {
          throw new Error(`Update recovery payload hash or size mismatch: ${entry.archivePath}`);
        }
        await target.sync();
      } finally {
        await target.close();
        await source.handle.close();
      }
      if (entry.sqlite) {
        const database = openNodeSqliteDatabase(targetPath, {
          readOnly: true,
          allowExtension: true,
        });
        try {
          await loadSqliteVecExtension({ db: database });
          assertSqliteIntegrity(database, targetPath);
        } finally {
          database.close();
        }
      }
      payloads.set(entry.archivePath, targetPath);
    }
    await directoryPin.assertCurrent();
    return { manifest, payloads, close, assertCurrent: () => directoryPin.assertCurrent() };
  } catch (error) {
    await close();
    throw error;
  }
}
