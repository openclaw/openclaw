import { setTimeout as delay } from "node:timers/promises";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";

// Five existing SQLite busy waits plus capped backoff allow about 37s for a competing writer.
const WORKER_STARTUP_RECOVERY_ATTEMPTS = 5;

/** Retry settled database recovery operations, never filesystem reconciliation or all sidecars. */
export async function retryGatewayWorkerStartupRecovery<T>(params: {
  operation: string;
  run: () => Promise<T>;
  warn: (message: string) => void;
}): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await params.run();
    } catch (error) {
      if (!isSqliteLockError(error)) {
        throw error;
      }
      if (attempt === WORKER_STARTUP_RECOVERY_ATTEMPTS) {
        throw new Error(
          `${params.operation} failed after ${attempt} attempts: the database is locked by another process or connection. Run openclaw doctor or openclaw gateway status --deep to diagnose the lock.`,
          { cause: error },
        );
      }
      const waitMs = Math.min(1_000 * 2 ** (attempt - 1), 5_000);
      params.warn(
        `${params.operation}: database is locked; retrying attempt ${attempt + 1}/${WORKER_STARTUP_RECOVERY_ATTEMPTS} in ${waitMs} ms.`,
      );
      await delay(waitMs);
    }
  }
}
