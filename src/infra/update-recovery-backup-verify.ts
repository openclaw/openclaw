import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseUpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { ensurePrivateSnapshotRepositoryRoot } from "../snapshot/local-repository.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { pinDirectory, sha256File } from "./directory-durability.js";
import { copyFileHandle, sameFileMutationFingerprint } from "./file-descriptor.js";
import { root as safeRoot } from "./fs-safe.js";
import { createPrivateSqliteTempDirectory } from "./sqlite-private-directory.js";
import {
  updateRecoveryBackupRefSchema,
  type UpdateRecoveryBackupRef,
} from "./update-recovery-backup-contract.js";
import {
  canonicalEntryPath,
  captureDirectory,
  digest,
  MAX_MANIFEST_BYTES,
} from "./update-recovery-backup-files.js";

function assertManifestLocation(
  ref: UpdateRecoveryBackupRef,
  manifest: ReturnType<typeof parseUpdateRecoveryBackupManifest>,
  env: NodeJS.ProcessEnv,
) {
  if (
    manifest.stateDir !== resolvePathViaExistingAncestorSync(resolveStateDir(env)) ||
    manifest.configPath !== canonicalEntryPath(resolveConfigPath(env)) ||
    ref.directory !==
      (manifest.generation && manifest.generation.kind !== "baseline"
        ? path.join(captureDirectory(manifest.runId, manifest.stateDir), manifest.generation.kind)
        : captureDirectory(manifest.runId, manifest.stateDir))
  ) {
    throw new Error("Update recovery backup belongs to another state directory or update run.");
  }
}

/** Private verified copies bind B/C/T without exposing mutable source payloads. */
export async function prepareVerifiedBackup(
  ref: UpdateRecoveryBackupRef,
  options: { env?: NodeJS.ProcessEnv } = {},
) {
  const env = { ...(options.env ?? process.env) };
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
  const sourceFingerprints = new Map<string, BigIntStats>();
  let sourceRoot: Awaited<ReturnType<typeof safeRoot>> | undefined;
  const assertCurrent = async () => {
    await directoryPin.assertCurrent();
    for (const [relativePath, expected] of sourceFingerprints) {
      const source = await sourceRoot!.open(relativePath, {
        symlinks: "reject",
        hardlinks: "reject",
      });
      try {
        if (!sameFileMutationFingerprint(expected, await source.handle.stat({ bigint: true }))) {
          throw new Error(`Update recovery source payload changed: ${relativePath}`);
        }
      } finally {
        await source.handle.close();
      }
    }
  };
  const close = async () => {
    const failures: unknown[] = [];
    try {
      await assertCurrent();
    } catch (error) {
      failures.push(error);
    }
    try {
      if (staging) {
        await fs.rm(staging, { recursive: true });
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      await directoryPin.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Update recovery verification cleanup failed", {
        cause: failures[0],
      });
    }
  };
  try {
    sourceRoot = await safeRoot(ref.directory);
    const raw = (
      await sourceRoot.read("manifest.json", {
        maxBytes: MAX_MANIFEST_BYTES,
        symlinks: "reject",
        hardlinks: "reject",
      })
    ).buffer.toString("utf8");
    const manifestSource = await sourceRoot.open("manifest.json", {
      symlinks: "reject",
      hardlinks: "reject",
    });
    try {
      sourceFingerprints.set("manifest.json", await manifestSource.handle.stat({ bigint: true }));
    } finally {
      await manifestSource.handle.close();
    }
    if (digest(raw) !== ref.manifestSha256) {
      throw new Error("Update recovery manifest hash mismatch.");
    }
    const manifest = parseUpdateRecoveryBackupManifest(raw);
    assertManifestLocation(ref, manifest, env);
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
        candidate.generation.baselineSha256 !== manifest.generation.baselineSha256 ||
        candidate.runId !== manifest.runId ||
        candidate.installRoot !== manifest.installRoot ||
        candidate.stateDir !== manifest.stateDir ||
        candidate.configPath !== manifest.configPath
      ) {
        throw new Error("Prepared recovery generation does not belong to its retained candidate.");
      }
    }
    staging = await createPrivateSqliteTempDirectory(ref.directory, ".verify-");
    const payloads = new Map<string, string>();
    const databaseTargets: Array<{
      path: string;
      kind: "agent" | "state";
      label: string;
    }> = [];
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
      {
        await using sourceHandle = source.handle;
        await using target = await fs.open(targetPath, "wx+", 0o600);
        const before = await sourceHandle.stat({ bigint: true });
        sourceFingerprints.set(entry.archivePath, before);
        await copyFileHandle(sourceHandle, target);
        const actual = await sha256File(target);
        if (
          !sameFileMutationFingerprint(before, await sourceHandle.stat({ bigint: true })) ||
          actual.bytes !== entry.size ||
          actual.digest !== entry.sha256
        ) {
          throw new Error(`Update recovery payload hash or size mismatch: ${entry.archivePath}`);
        }
        await target.sync();
      }
      if (entry.sqlite) {
        const owner = manifest.databases?.find((database) => database.path === entry.sourcePath);
        if (!owner) {
          throw new Error(
            `Update recovery SQLite payload has no database owner: ${entry.sourcePath}`,
          );
        }
        databaseTargets.push({
          path: targetPath,
          kind: owner.role === "global" ? "state" : "agent",
          label: `update recovery ${owner.role} database`,
        });
      }
      payloads.set(entry.archivePath, targetPath);
    }
    if (databaseTargets.length > 0) {
      const { runOpenClawDatabaseVerificationWorker } =
        await import("../state/openclaw-database-verify.js");
      const results = await runOpenClawDatabaseVerificationWorker(databaseTargets);
      const failed = results.find((result) => !result.ok);
      if (failed) {
        throw new Error(
          `Update recovery SQLite payload verification failed: ${failed.error ?? failed.path}`,
        );
      }
    }
    await assertCurrent();
    return { manifest, payloads, close, assertCurrent };
  } catch (error) {
    await close();
    throw error;
  }
}
