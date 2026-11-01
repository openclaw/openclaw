import { recordSqliteDatabaseIntegrity } from "./sqlite-database-admission.js";
import { assertSqliteIntegrityInWorker } from "./sqlite-integrity-worker.js";
import type { SqliteIntegrityCheck, SqliteIntegrityOperation } from "./sqlite-integrity.js";
import { resolveSqliteInspectionSignal } from "./sqlite-readonly-worker.js";

/** Keep the caller's connection and authority until every native reader closes. */
export async function runSqliteIntegrityOperationInWorker<T>(
  operation: SqliteIntegrityOperation<T | undefined>,
  options: {
    busyTimeoutMs: number;
    signal: AbortSignal;
    beforeResume: () => void;
    repairIntegrityError?: (check: SqliteIntegrityCheck, error: unknown) => boolean;
  },
): Promise<T | undefined> {
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
          {
            check: step.value.check,
            schemaOnly: step.value.schemaOnly,
            tables: step.value.tables,
            ftsSchemas: step.value.ftsSchemas,
          },
        );
      } catch (error) {
        failure = { error };
      }
      // Neither cancellation nor lost custody may resume an index/schema repair.
      beforeResume();
      if (!failure && step.value.check !== "quick") {
        recordSqliteDatabaseIntegrity(step.value.database);
      }
      if (failure && options.repairIntegrityError) {
        const original = failure.error;
        try {
          if (options.repairIntegrityError(step.value, original)) {
            failure = undefined;
          }
        } catch (repairError) {
          // Preserve the corruption verdict so failed repair retains quarantine policy.
          if (original instanceof Error) {
            original.message += ` Startup FTS repair failed: ${String(repairError)}`;
          }
        }
      }
      step = failure ? operation.throw(failure.error) : operation.next();
    }
    return step.value;
  } finally {
    operation.return(undefined);
  }
}
