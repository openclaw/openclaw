import { isTransientAgentDatabaseContention } from "../../state/agent-database-admission.js";

/** One close attempt: the collected failures and whether the handle converged. */
export type SqliteWorkerCloseSettleResult = {
  errors: Error[];
  settled: boolean;
};

/**
 * Bounded backoff for a close that lost its own race with a concurrent writer.
 * The whole budget stays far below the one-second slow-reclamation threshold.
 */
export const SQLITE_WORKER_CLOSE_RETRY_DELAYS_MS = [2, 5, 10, 20, 40, 80] as const;

/**
 * A close that lost its race reports transient SQLite contention; a damaged
 * database does not. A mixed failure keeps its uncertain outcome, so it is not
 * contention either.
 */
export function isSqliteWorkerCloseContention(result: SqliteWorkerCloseSettleResult): boolean {
  return result.errors.some((error) => isTransientAgentDatabaseContention(error));
}

/**
 * Converge one worker close and retry only a close that lost its own race.
 *
 * The canonical-validation worker pool rejects a task whose close never
 * settles, so a losing race dropped the reclamation even though the database
 * work had already succeeded. A damaged database is not contention: it stays
 * terminal and keeps failing loudly instead of being retried into a skip.
 */
export async function settleSqliteWorkerCloseWithContentionRetry(params: {
  settle: () => Promise<SqliteWorkerCloseSettleResult>;
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<{
  result: SqliteWorkerCloseSettleResult;
  attempts: number;
  contended: boolean;
}> {
  const delaysMs = params.delaysMs ?? SQLITE_WORKER_CLOSE_RETRY_DELAYS_MS;
  const sleep =
    params.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let result = await params.settle();
  let attempts = 1;
  let contended = false;
  for (const delayMs of delaysMs) {
    if (result.settled) {
      break;
    }
    // Only a losing close race is retried; corruption and mixed failures stay terminal.
    if (!isSqliteWorkerCloseContention(result)) {
      break;
    }
    contended = true;
    await sleep(delayMs);
    result = await params.settle();
    attempts += 1;
  }
  return { result, attempts, contended };
}
