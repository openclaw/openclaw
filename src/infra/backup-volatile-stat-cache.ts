import type { Stats } from "node:fs";

const VOLATILE_BACKUP_SYNTHETIC_STAT = {
  isBlockDevice: () => false,
  isCharacterDevice: () => false,
  isDirectory: () => false,
  isFIFO: () => false,
  isFile: () => false,
  isSocket: () => false,
  isSymbolicLink: () => false,
} as unknown as Stats;

class BackupVolatileStatCache extends Map<string, Stats> {
  constructor(private readonly isVolatilePath: (sourcePath: string) => boolean) {
    super();
  }

  override set(key: string, stat: Stats): this {
    // Each archive name is an independent file. Project this before node-tar
    // schedules pending hardlinks; suppressing link-cache writes can deadlock it.
    if (stat.isFile()) {
      stat.nlink = 1;
    }
    return super.set(key, stat);
  }

  override get(key: string): Stats | undefined {
    const cached = super.get(key);
    if (cached) {
      return cached;
    }
    // node-tar consults this cache before lstat. Synthetic hits let known
    // volatile paths disappear during a live backup without aborting it.
    return this.isVolatilePath(key) ? VOLATILE_BACKUP_SYNTHETIC_STAT : undefined;
  }
}

export function createBackupVolatileStatCache(
  isVolatilePath: (sourcePath: string) => boolean,
): Map<string, Stats> {
  return new BackupVolatileStatCache(isVolatilePath);
}
