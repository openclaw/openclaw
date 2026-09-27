import { isSqliteLockError, sqliteExtendedResultCode } from "../infra/sqlite-error-diagnostics.js";
import { sleep } from "../utils.js";

export function isScheduledTaskSqliteSharingError(error: unknown): boolean {
  // Windows can release SQLite locks before the dying process unmaps shared memory.
  // IOERR_TRUNCATE, IOERR_SHMOPEN, and IOERR_SHMSIZE are not retried by busy_timeout.
  return (
    process.platform === "win32" &&
    (isSqliteLockError(error) || [1546, 4618, 4874].includes(sqliteExtendedResultCode(error) ?? -1))
  );
}

export async function retryScheduledTaskLeaseRead<T>(read: () => T): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      return read();
    } catch (error) {
      if (!isScheduledTaskSqliteSharingError(error) || Date.now() >= deadline) {
        throw error;
      }
      await sleep(Math.min(100, deadline - Date.now()));
    }
  }
}
