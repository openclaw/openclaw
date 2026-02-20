import path from "node:path";

export const CONFIG_BACKUP_COUNT = 5;
export const CONFIG_BACKUP_DIR_NAME = "config-backup";

function formatBackupTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/:/g, "-");
}

export function resolveConfigBackupDir(configPath: string): string {
  return path.join(path.dirname(configPath), CONFIG_BACKUP_DIR_NAME);
}

export function resolveConfigBackupPath(configPath: string, date?: Date): string {
  const backupDir = resolveConfigBackupDir(configPath);
  const baseName = path.basename(configPath);
  return path.join(backupDir, `${baseName}.bak.${formatBackupTimestamp(date)}`);
}

export async function rotateConfigBackups(
  configPath: string,
  ioFs: {
    mkdir?: (
      path: string,
      options: { recursive: boolean; mode?: number },
    ) => Promise<string | undefined>;
    readdir?: (path: string) => Promise<string[]>;
    unlink: (path: string) => Promise<void>;
    rename: (from: string, to: string) => Promise<void>;
  },
): Promise<void> {
  const backupDir = resolveConfigBackupDir(configPath);
  const baseName = path.basename(configPath);
  const prefix = `${baseName}.bak.`;

  // Ensure backup directory exists
  if (ioFs.mkdir) {
    await ioFs.mkdir(backupDir, { recursive: true, mode: 0o700 }).catch(() => {
      // best-effort
    });
  }

  // Prune old backups beyond CONFIG_BACKUP_COUNT - 1 (leaving room for the new one)
  if (ioFs.readdir && CONFIG_BACKUP_COUNT > 1) {
    try {
      const entries = await ioFs.readdir(backupDir);
      const backups = entries.filter((e) => e.startsWith(prefix)).toSorted();
      const maxExisting = CONFIG_BACKUP_COUNT - 1; // leave room for the upcoming backup
      if (backups.length >= maxExisting) {
        const toRemove = backups.slice(0, backups.length - maxExisting + 1);
        for (const entry of toRemove) {
          await ioFs.unlink(path.join(backupDir, entry)).catch(() => {
            // best-effort
          });
        }
      }
    } catch {
      // best-effort — directory may not exist yet
    }
  }
}
