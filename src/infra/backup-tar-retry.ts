import { sleep } from "../utils/sleep.js";
import { hasErrnoCode } from "./errno.js";

const BACKUP_TAR_MAX_ATTEMPTS = 3;
const BACKUP_TAR_BACKOFF_MS = [10_000, 20_000];

type BackupTarRetryLogger = (message: string) => void;

export async function writeTarArchiveWithRetry<T>(params: {
  tempArchivePath: string;
  runTar: (tempArchivePath: string) => Promise<T>;
  log?: BackupTarRetryLogger;
  sleepMs?: (ms: number) => Promise<void>;
}): Promise<T> {
  const sleepFn = params.sleepMs ?? sleep;
  for (let attempt = 1; ; attempt += 1) {
    const attemptTempArchivePath =
      attempt === 1 ? params.tempArchivePath : `${params.tempArchivePath}.retry-${attempt}`;
    try {
      return await params.runTar(attemptTempArchivePath);
    } catch (err) {
      const offendingPath = (err as NodeJS.ErrnoException | undefined)?.path;
      if (!hasErrnoCode(err, "EOF") || attempt === BACKUP_TAR_MAX_ATTEMPTS) {
        const final = err instanceof Error ? err : new Error(String(err));
        const attemptSuffix = `after ${attempt} attempt${attempt === 1 ? "" : "s"}`;
        const suffix = offendingPath
          ? ` (last offending path: ${offendingPath}, ${attemptSuffix})`
          : ` (${attemptSuffix})`;
        throw new Error(`Backup archive write failed: ${final.message}${suffix}`, { cause: final });
      }
      // The writer owns checked cleanup inside the private staging directory.
      // A fresh path keeps retries independent when a changed entry is preserved.
      const backoff = BACKUP_TAR_BACKOFF_MS[attempt - 1] ?? 0;
      params.log?.(
        `Backup archiver hit a live-write race${
          offendingPath ? ` on ${offendingPath}` : ""
        } (attempt ${attempt}/${BACKUP_TAR_MAX_ATTEMPTS}); retrying in ${Math.round(backoff / 1000)}s.`,
      );
      await sleepFn(backoff);
    }
  }
}
