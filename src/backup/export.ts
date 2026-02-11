/**
 * Backup export orchestration.
 *
 * Collect -> stage -> archive -> store.
 *
 * @module backup/export
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import type { BackupComponent, BackupManifest, ExportOptions, StorageBackend } from "./types.js";
import { VERSION } from "../version.js";
import { collectFiles } from "./collector.js";
import { encrypt } from "./crypto.js";
import { buildManifest } from "./manifest.js";
import { CORE_BACKUP_COMPONENTS } from "./types.js";

export type ExportResult = {
  /** Path or key where the backup was stored. */
  destination: string;
  /** The manifest. */
  manifest: BackupManifest;
  /** Size of the archive in bytes. */
  size: number;
};

/**
 * Export a backup.
 *
 * 1. Collect files from the state directory
 * 2. Stage them in a temporary directory
 * 3. Create a tar.gz archive
 * 4. Optionally encrypt
 * 5. Store via the provided backend (or write to `opts.output`)
 */
export async function exportBackup(
  opts: ExportOptions,
  storage?: StorageBackend,
): Promise<ExportResult> {
  const components: BackupComponent[] = opts.components ?? [...CORE_BACKUP_COMPONENTS];

  // 1. Collect files
  const collectedFiles = await collectFiles({ components });
  if (collectedFiles.length === 0) {
    throw new Error("No files to backup. Check your components selection and state directory.");
  }

  // 2. Stage files in a temp directory
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-"));

  try {
    for (const file of collectedFiles) {
      const destPath = path.join(stagingDir, file.archivePath);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      if (file.content !== undefined) {
        await fs.writeFile(destPath, file.content, "utf-8");
      } else {
        await fs.copyFile(file.sourcePath, destPath);
      }
    }

    // 3. Build manifest
    const manifest = await buildManifest({
      stagingDir,
      components,
      openclawVersion: VERSION,
      label: opts.label,
      encrypted: !!opts.encrypt,
    });

    // Write manifest into staging dir
    await fs.writeFile(
      path.join(stagingDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );

    // 4. Create tar.gz archive
    const archivePath = path.join(os.tmpdir(), `openclaw-backup-${Date.now()}.tar.gz`);
    await tar.c(
      {
        gzip: true,
        file: archivePath,
        cwd: stagingDir,
      },
      ["."],
    );

    // 5. Optionally encrypt
    let finalData = await fs.readFile(archivePath);
    if (opts.encrypt) {
      finalData = encrypt(finalData, opts.encrypt);
    }

    // 6. Store
    let destination: string;
    if (storage) {
      const key = path.basename(opts.output);
      await storage.put(key, finalData);
      // Also store sidecar manifest for quick listing
      await storage.put(
        `${key}.manifest.json`,
        Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"),
      );
      destination = key;
    } else {
      // Write directly to output path
      const outputPath = path.resolve(opts.output);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, finalData);
      // Write sidecar manifest next to the archive
      await fs.writeFile(`${outputPath}.manifest.json`, JSON.stringify(manifest, null, 2), "utf-8");
      destination = outputPath;
    }

    // Cleanup temp archive
    await fs.unlink(archivePath).catch(() => undefined);

    return {
      destination,
      manifest,
      size: finalData.length,
    };
  } finally {
    // Cleanup staging directory
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
