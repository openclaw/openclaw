/**
 * Backup CLI commands: export, import, list, restore.
 *
 * @module cli/backup-cli
 */
import type { Command } from "commander";
import { ALL_BACKUP_COMPONENTS, CORE_BACKUP_COMPONENTS } from "../backup/types.js";

/**
 * Register all `openclaw backup *` subcommands.
 */
export function registerBackupCli(program: Command) {
  const backup = program
    .command("backup")
    .alias("bak")
    .description("Backup and restore OpenClaw configuration, workspace, and state");

  // --- backup export ---
  backup
    .command("export")
    .description("Export a backup archive")
    .option(
      "-o, --output <path>",
      "Output file path",
      `openclaw-backup-${formatTimestamp()}.tar.gz`,
    )
    .option(
      "-c, --components <list>",
      `Components to include (comma-separated: ${ALL_BACKUP_COMPONENTS.join(",")})`,
      CORE_BACKUP_COMPONENTS.join(","),
    )
    .option("--since <date>", "Incremental: only include sessions after this ISO date")
    .option("-l, --label <text>", "Human-readable label for the backup")
    .option("-e, --encrypt <passphrase>", "Encrypt the backup archive")
    .option("--storage-type <type>", "Storage backend: local or s3", "local")
    .action(async (opts: Record<string, string>) => {
      const { exportBackup } = await import("../backup/export.js");
      const { createStorageBackend } = await import("../backup/storage/factory.js");

      const components = opts.components.split(",").map((s: string) => s.trim());
      const useStorage = opts.storageType !== "local" || !opts.output;

      let storage;
      if (useStorage && opts.storageType === "s3") {
        const { loadConfig } = await import("../config/config.js");
        const config = loadConfig();
        const backupConfig = (config as Record<string, unknown>).backup as
          | Record<string, unknown>
          | undefined;
        const storageConfig = backupConfig?.storage as
          | import("../backup/types.js").BackupStorageConfig
          | undefined;
        storage = await createStorageBackend(storageConfig);
      }

      const result = await exportBackup(
        {
          output: opts.output,
          components: components as import("../backup/types.js").BackupComponent[],
          since: opts.since,
          label: opts.label,
          encrypt: opts.encrypt,
        },
        storage,
      );

      console.log(`Backup exported successfully!`);
      console.log(`  Destination: ${result.destination}`);
      console.log(`  Size: ${formatSize(result.size)}`);
      console.log(`  Components: ${result.manifest.components.join(", ")}`);
      console.log(`  Files: ${result.manifest.entries.length}`);
      if (result.manifest.encrypted) {
        console.log(`  Encrypted: yes`);
      }
    });

  // --- backup import ---
  backup
    .command("import")
    .description("Restore from a backup archive")
    .argument("<input>", "Backup archive path or S3 key")
    .option("-m, --merge", "Merge cron jobs instead of replacing", false)
    .option("-n, --dry-run", "Show what would be restored without applying", false)
    .option("-d, --decrypt <passphrase>", "Decrypt the backup archive")
    .action(async (input: string, opts: Record<string, string | boolean>) => {
      const { importBackup } = await import("../backup/import.js");

      const result = await importBackup({
        input,
        merge: opts.merge === true,
        dryRun: opts.dryRun === true,
        decrypt: typeof opts.decrypt === "string" ? opts.decrypt : undefined,
      });

      if (result.dryRun) {
        console.log("Dry run — the following would be restored:");
      } else {
        console.log("Backup restored successfully!");
      }
      console.log(`  Created: ${result.manifest.createdAt}`);
      console.log(`  OpenClaw version: ${result.manifest.openclawVersion}`);
      console.log(`  Components: ${result.restoredComponents.join(", ")}`);
      console.log(`  Files: ${result.restoredFiles.length}`);
      for (const file of result.restoredFiles) {
        console.log(`    - ${file}`);
      }
      if (result.integrityErrors.length > 0) {
        console.warn(`\n  Integrity warnings:`);
        for (const err of result.integrityErrors) {
          console.warn(`    - ${err}`);
        }
      }
    });

  // --- backup list ---
  backup
    .command("list")
    .alias("ls")
    .description("List stored backups")
    .option("--storage-type <type>", "Storage backend: local or s3", "local")
    .action(async (opts: Record<string, string>) => {
      const { createStorageBackend } = await import("../backup/storage/factory.js");

      let storageConfig;
      if (opts.storageType === "s3") {
        const { loadConfig } = await import("../config/config.js");
        const config = loadConfig();
        const backupConfig = (config as Record<string, unknown>).backup as
          | Record<string, unknown>
          | undefined;
        storageConfig = backupConfig?.storage as
          | import("../backup/types.js").BackupStorageConfig
          | undefined;
      }

      const storage = await createStorageBackend(storageConfig);
      const backups = await storage.list();

      if (backups.length === 0) {
        console.log("No backups found.");
        return;
      }

      console.log(`Found ${backups.length} backup(s):\n`);
      for (const entry of backups) {
        const label = entry.label ? ` [${entry.label}]` : "";
        const encrypted = entry.encrypted ? " (encrypted)" : "";
        const components = entry.components.length > 0 ? ` | ${entry.components.join(", ")}` : "";
        console.log(
          `  ${entry.id}  ${entry.createdAt}  ${formatSize(entry.size)}${components}${label}${encrypted}`,
        );
      }
    });

  // --- backup restore (alias for import) ---
  backup
    .command("restore")
    .description("Restore a specific backup (alias for import)")
    .argument("<input>", "Backup archive path or S3 key")
    .option("-m, --merge", "Merge cron jobs instead of replacing", false)
    .option("-n, --dry-run", "Show what would be restored without applying", false)
    .option("-d, --decrypt <passphrase>", "Decrypt the backup archive")
    .action(async (input: string, opts: Record<string, string | boolean>) => {
      const { importBackup } = await import("../backup/import.js");

      const result = await importBackup({
        input,
        merge: opts.merge === true,
        dryRun: opts.dryRun === true,
        decrypt: typeof opts.decrypt === "string" ? opts.decrypt : undefined,
      });

      if (result.dryRun) {
        console.log("Dry run — the following would be restored:");
      } else {
        console.log("Backup restored successfully!");
      }
      console.log(`  Created: ${result.manifest.createdAt}`);
      console.log(`  OpenClaw version: ${result.manifest.openclawVersion}`);
      console.log(`  Components: ${result.restoredComponents.join(", ")}`);
      console.log(`  Files: ${result.restoredFiles.length}`);
      for (const file of result.restoredFiles) {
        console.log(`    - ${file}`);
      }
    });
}

function formatTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
