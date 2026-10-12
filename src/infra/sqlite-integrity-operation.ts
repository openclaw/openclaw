import { recordSqliteDatabaseIntegrity } from "./sqlite-database-admission.js";
import { assertSqliteIntegrityInWorker } from "./sqlite-integrity-worker.js";
import type { SqliteIntegrityOperation } from "./sqlite-integrity.js";
import { resolveSqliteInspectionSignal } from "./sqlite-readonly-worker.js";

/** Keep the caller's connection and authority until every native reader closes. */
export async function runSqliteIntegrityOperationInWorker(
  operation: SqliteIntegrityOperation<void>,
  options: {
    busyTimeoutMs: number;
    signal: AbortSignal;
    beforeResume: () => void;
    repairIntegrityError?: () => boolean;
  },
): Promise<void> {
  const signal = resolveSqliteInspectionSignal(options.signal) ?? options.signal;
  const beforeResume = () => {
    signal.throwIfAborted();
    options.beforeResume();
  };
  try {
    beforeResume();
    let step = operation.next();
    while (!step.done) {
      let failure: { error: unknown } | undefined;
      try {
        await assertSqliteIntegrityInWorker(
          step.value.databaseLabel,
          options.busyTimeoutMs,
          signal,
          undefined,
          step.value.timing,
        );
      } catch (error) {
        failure = { error };
      }
      // Neither cancellation nor lost custody may resume an index/schema repair.
      beforeResume();
      if (!failure) {
        recordSqliteDatabaseIntegrity(step.value.database);
      }
      step =
        failure && !options.repairIntegrityError?.()
          ? operation.throw(failure.error)
          : operation.next();
    }
  } finally {
    operation.return();
  }
}
