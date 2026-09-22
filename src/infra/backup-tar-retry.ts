import { sleep } from "../utils/sleep.js";
import { hasErrnoCode } from "./errno.js";

const BACKUP_TAR_MAX_ATTEMPTS = 3;
const BACKUP_TAR_BACKOFF_MS = [10_000, 20_000];

type BackupTarRetryLogger = (message: string) => void;

function resolveBackupTarAttemptTempPath(tempArchivePath: string, attempt: number): string {
  return attempt === 1 ? tempArchivePath : `${tempArchivePath}.retry-${attempt}`;
}

export async function writeTarArchiveWithRetry<T>(params: {
  tempArchivePath: string;
  runTar: (tempArchivePath: string) => Promise<T>;
  log?: BackupTarRetryLogger;
  sleepMs?: (ms: number) => Promise<void>;
}): Promise<T> {
  const sleepFn = params.sleepMs ?? sleep;
  let lastErr: unknown;
  let attempts = 0;
  for (let attempt = 1; attempt <= BACKUP_TAR_MAX_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    const attemptTempArchivePath = resolveBackupTarAttemptTempPath(params.tempArchivePath, attempt);
    try {
      return await params.runTar(attemptTempArchivePath);
    } catch (err) {
      lastErr = err;
      if (!hasErrnoCode(err, "EOF") || attempt === BACKUP_TAR_MAX_ATTEMPTS) {
        break;
      }
      // The writer owns checked cleanup inside the private staging directory.
      // A fresh path keeps retries independent when a changed entry is preserved.
      const backoff = BACKUP_TAR_BACKOFF_MS[attempt - 1] ?? 0;
      const offendingPath = (err as NodeJS.ErrnoException).path;
      params.log?.(
        `Backup archiver hit a live-write race${
          offendingPath ? ` on ${offendingPath}` : ""
        } (attempt ${attempt}/${BACKUP_TAR_MAX_ATTEMPTS}); retrying in ${Math.round(backoff / 1000)}s.`,
      );
      await sleepFn(backoff);
    }
  }
  const final = lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  const offendingPath = (lastErr as NodeJS.ErrnoException | undefined)?.path;
  const attemptSuffix = `after ${attempts} attempt${attempts === 1 ? "" : "s"}`;
  const suffix = offendingPath
    ? ` (last offending path: ${offendingPath}, ${attemptSuffix})`
    : ` (${attemptSuffix})`;
  throw new Error(`Backup archive write failed: ${final.message}${suffix}`, { cause: final });
}
