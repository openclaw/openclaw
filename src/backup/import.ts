/**
 * Backup import/restore orchestration.
 *
 * Retrieve -> decrypt -> extract -> validate -> apply.
 *
 * @module backup/import
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BackupManifest, ImportOptions, StorageBackend } from "./types.js";
import { resolveConfigPathCandidate, resolveStateDir } from "../config/paths.js";
import { DEFAULT_CRON_STORE_PATH, loadCronStore, saveCronStore } from "../cron/store.js";
import { extractArchive } from "../infra/archive.js";
import { decrypt } from "./crypto.js";
import { validateManifest, verifyIntegrity } from "./manifest.js";

const EXTRACT_TIMEOUT_MS = 60_000;

export type ImportResult = {
  /** The manifest from the archive. */
  manifest: BackupManifest;
  /** Components that were restored. */
  restoredComponents: string[];
  /** Files that were restored (relative paths). */
  restoredFiles: string[];
  /** Whether this was a dry run. */
  dryRun: boolean;
  /** Integrity verification errors (empty if all OK). */
  integrityErrors: string[];
};

/**
 * Import / restore a backup.
 *
 * 1. Read the archive (from file or storage backend)
 * 2. Optionally decrypt
 * 3. Extract to temp directory
 * 4. Validate manifest and checksums
 * 5. Apply files to the state directory (unless dry-run)
 */
export async function importBackup(
  opts: ImportOptions,
  storage?: StorageBackend,
): Promise<ImportResult> {
  // 1. Read the archive
  let archiveData: Buffer;
  if (storage) {
    archiveData = await storage.get(opts.input);
  } else {
    archiveData = await fs.readFile(path.resolve(opts.input));
  }

  // 2. Optionally decrypt
  if (opts.decrypt) {
    archiveData = decrypt(archiveData, opts.decrypt);
  }

  // 3. Extract to temp directory
  const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-"));
  const tempArchivePath = path.join(extractDir, "archive.tar.gz");
  await fs.writeFile(tempArchivePath, archiveData);

  try {
    await extractArchive({
      archivePath: tempArchivePath,
      destDir: extractDir,
      timeoutMs: EXTRACT_TIMEOUT_MS,
    });

    // Security: validate no extracted files escape the extract directory (tar-slip prevention)
    await validateExtractedPaths(extractDir);

    // Remove the temp archive file after extraction
    await fs.unlink(tempArchivePath).catch(() => undefined);

    // 4. Read and validate manifest
    const manifestPath = path.join(extractDir, "manifest.json");
    let manifest: BackupManifest;
    try {
      const raw = await fs.readFile(manifestPath, "utf-8");
      manifest = JSON.parse(raw) as BackupManifest;
    } catch {
      throw new Error("Backup archive is missing or has an invalid manifest.json");
    }

    const validationErrors = validateManifest(manifest);
    if (validationErrors.length > 0) {
      throw new Error(`Invalid manifest:\n${validationErrors.map((e) => `  - ${e}`).join("\n")}`);
    }

    // Verify integrity
    const mismatched = await verifyIntegrity(manifest, extractDir);
    const integrityErrors = mismatched.map((entry) => `checksum mismatch: ${entry.path}`);

    if (opts.dryRun) {
      return {
        manifest,
        restoredComponents: manifest.components,
        restoredFiles: manifest.entries.map((e) => e.path),
        dryRun: true,
        integrityErrors,
      };
    }

    if (integrityErrors.length > 0) {
      throw new Error(
        `Integrity check failed:\n${integrityErrors.map((e) => `  - ${e}`).join("\n")}\n\nUse --dry-run to inspect the archive without applying.`,
      );
    }

    // 5. Apply files to state directory
    const stateDir = resolveStateDir();
    const restoredFiles: string[] = [];

    // Restore config
    if (manifest.components.includes("config")) {
      const configSource = path.join(extractDir, "config", "openclaw.json");
      const configDest = resolveConfigPathCandidate() ?? path.join(stateDir, "openclaw.json");
      try {
        await fs.access(configSource);
        // Backup existing config before overwriting
        try {
          await fs.copyFile(configDest, `${configDest}.pre-restore.bak`);
        } catch {
          // no existing config to back up
        }
        await fs.mkdir(path.dirname(configDest), { recursive: true });
        await fs.copyFile(configSource, configDest);
        restoredFiles.push("config/openclaw.json");
      } catch {
        // config not in archive
      }
    }

    // Restore cron jobs
    if (manifest.components.includes("cron")) {
      const cronSource = path.join(extractDir, "cron", "jobs.json");
      const cronDest = DEFAULT_CRON_STORE_PATH;
      try {
        await fs.access(cronSource);
        if (opts.merge) {
          await mergeCronJobs(cronSource, cronDest);
        } else {
          await fs.mkdir(path.dirname(cronDest), { recursive: true });
          await fs.copyFile(cronSource, cronDest);
        }
        restoredFiles.push("cron/jobs.json");
      } catch {
        // cron not in archive
      }
    }

    // Restore workspace, skills, sessions, approvals, pairing
    const dirMappings: Array<{ component: string; archiveDir: string; destDir: string }> = [
      {
        component: "workspace",
        archiveDir: "workspace",
        destDir: path.join(stateDir, "agents", "default", "agent"),
      },
      {
        component: "skills",
        archiveDir: "skills",
        destDir: path.join(stateDir, "skills"),
      },
      {
        component: "sessions",
        archiveDir: "sessions",
        destDir: path.join(stateDir, "agents", "default", "agent"),
      },
      {
        component: "pairing",
        archiveDir: "pairing",
        destDir: path.join(stateDir, "pairing"),
      },
    ];

    for (const mapping of dirMappings) {
      if (!manifest.components.includes(mapping.component as never)) {
        continue;
      }
      const sourceDir = path.join(extractDir, mapping.archiveDir);
      try {
        await fs.access(sourceDir);
        const copied = await copyDirRecursive(sourceDir, mapping.destDir);
        restoredFiles.push(...copied.map((f) => `${mapping.archiveDir}/${f}`));
      } catch {
        // component not in archive
      }
    }

    // Restore approvals (single file)
    if (manifest.components.includes("approvals")) {
      const approvalsSource = path.join(extractDir, "approvals", "exec-approvals.json");
      const approvalsDest = path.join(stateDir, "exec-approvals.json");
      try {
        await fs.access(approvalsSource);
        await fs.copyFile(approvalsSource, approvalsDest);
        restoredFiles.push("approvals/exec-approvals.json");
      } catch {
        // approvals not in archive
      }
    }

    return {
      manifest,
      restoredComponents: manifest.components,
      restoredFiles,
      dryRun: false,
      integrityErrors: [],
    };
  } finally {
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Merge cron jobs from a backup into the existing store.
 * Deduplicates by job ID, preferring the backup version for conflicts.
 */
async function mergeCronJobs(sourcePath: string, destPath: string): Promise<void> {
  // Use canonical cron store loader (handles JSON5 + error recovery)
  const sourceStore = await loadCronStore(sourcePath);
  const existingStore = await loadCronStore(destPath);

  // Merge: backup jobs override existing ones with the same ID
  const byId = new Map<string, unknown>();
  for (const job of existingStore.jobs) {
    const jobRecord = job as Record<string, unknown>;
    if (jobRecord.id && typeof jobRecord.id === "string") {
      byId.set(jobRecord.id, job);
    }
  }
  for (const job of sourceStore.jobs) {
    const jobRecord = job as Record<string, unknown>;
    if (jobRecord.id && typeof jobRecord.id === "string") {
      byId.set(jobRecord.id, job);
    }
  }

  const merged = {
    version: 1 as const,
    jobs: [...byId.values()] as typeof existingStore.jobs,
  };

  // Use canonical cron store saver (atomic write with temp + rename + backup)
  await saveCronStore(destPath, merged);
}

/**
 * Security: verify all extracted files/directories are within the expected directory.
 * Prevents tar-slip (path traversal) attacks via entries like `../../etc/passwd`.
 */
async function validateExtractedPaths(extractDir: string): Promise<void> {
  const resolvedBase = path.resolve(extractDir);
  const entries = await fs.readdir(extractDir, { recursive: true });
  for (const entry of entries) {
    const entryStr = typeof entry === "string" ? entry : String(entry);
    const resolved = path.resolve(extractDir, entryStr);
    if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
      throw new Error(`Unsafe archive: entry "${entryStr}" escapes extraction directory`);
    }
  }
}

/**
 * Recursively copy a directory, returning a list of relative paths copied.
 */
async function copyDirRecursive(
  sourceDir: string,
  destDir: string,
  prefix: string = "",
): Promise<string[]> {
  const copied: string[] = [];
  await fs.mkdir(destDir, { recursive: true });

  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isFile()) {
      await fs.copyFile(sourcePath, destPath);
      copied.push(relativePath);
    } else if (entry.isDirectory()) {
      const subCopied = await copyDirRecursive(sourcePath, destPath, relativePath);
      copied.push(...subCopied);
    }
  }

  return copied;
}
