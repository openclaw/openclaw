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
 * Remove all config backup files after a successful write.
 * Backup files contain sensitive data (API keys, tokens) and should not persist
 * beyond the write operation where they serve as crash recovery.
 * @see https://github.com/OpenClaw/openclaw/issues/31699
 */
export async function cleanupConfigBackups(
  configPath: string,
  ioFs: {
    unlink: (path: string) => Promise<void>;
  },
): Promise<void> {
  const backupBase = `${configPath}.bak`;
  // Remove the primary backup
  await ioFs.unlink(backupBase).catch(() => {
    // best-effort: file may not exist
  });
  // Remove numbered backups (.bak.1 through .bak.N)
  for (let index = 1; index < CONFIG_BACKUP_COUNT; index += 1) {
    await ioFs.unlink(`${backupBase}.${index}`).catch(() => {
      // best-effort: file may not exist
    });
  }
}
