import { resolveCommandProcessSignal } from "../process/exec-spawn.js";
import { sleep } from "../utils/sleep.js";

const MAX_CAPTURE_ATTEMPTS = 3;

export class BackupSqliteSourceAppearedError extends Error {
  readonly sourcePath: string;

  constructor(sourcePath: string) {
    super(
      `SQLite state appeared after snapshot discovery: ${sourcePath}. Retry backup so it can be snapshotted.`,
    );
    this.sourcePath = sourcePath;
  }
}

export async function withBackupSqliteDiscoveryRetry<T>(
  capture: (requiredPaths: ReadonlySet<string>) => Promise<T>,
  log?: (message: string) => void,
): Promise<T> {
  const requiredPaths = new Set<string>();
  for (let attempt = 1; ; attempt++) {
    try {
      return await capture(requiredPaths);
    } catch (error) {
      if (!(error instanceof BackupSqliteSourceAppearedError) || attempt === MAX_CAPTURE_ATTEMPTS) {
        throw error;
      }
      requiredPaths.add(error.sourcePath);
      log?.(
        `SQLite state appeared during backup: ${error.sourcePath}. Retrying snapshot discovery (${attempt + 1}/${MAX_CAPTURE_ATTEMPTS}).`,
      );
      await sleep(attempt * 1000, resolveCommandProcessSignal());
    }
  }
}
