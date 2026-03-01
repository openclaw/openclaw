import fs from "node:fs";

export const CONFIG_BACKUP_COUNT = 5;

export async function rotateConfigBackups(
  configPath: string,
  ioFs: {
    unlink: (path: string) => Promise<void>;
    rename: (from: string, to: string) => Promise<void>;
  },
): Promise<void> {
  if (CONFIG_BACKUP_COUNT <= 1) {
    return;
  }
  const backupBase = `${configPath}.bak`;
  const maxIndex = CONFIG_BACKUP_COUNT - 1;
  await ioFs.unlink(`${backupBase}.${maxIndex}`).catch(() => {
    // best-effort
  });
  for (let index = maxIndex - 1; index >= 1; index -= 1) {
    await ioFs.rename(`${backupBase}.${index}`, `${backupBase}.${index + 1}`).catch(() => {
      // best-effort
    });
  }
  await ioFs.rename(backupBase, `${backupBase}.1`).catch(() => {
    // best-effort
  });
}

/**
 * Synchronous version of rotateConfigBackups for use in sync code paths
 * (e.g. config auto-repair during loadConfig).
 */
export function rotateConfigBackupsSync(configPath: string): void {
  if (CONFIG_BACKUP_COUNT <= 1) {
    return;
  }
  const backupBase = `${configPath}.bak`;
  const maxIndex = CONFIG_BACKUP_COUNT - 1;
  try {
    fs.unlinkSync(`${backupBase}.${maxIndex}`);
  } catch {
    // best-effort
  }
  for (let index = maxIndex - 1; index >= 1; index -= 1) {
    try {
      fs.renameSync(`${backupBase}.${index}`, `${backupBase}.${index + 1}`);
    } catch {
      // best-effort
    }
  }
  try {
    fs.renameSync(backupBase, `${backupBase}.1`);
  } catch {
    // best-effort
  }
}
