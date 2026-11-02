import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import {
  assertSqliteDatabaseAdmissionWaitActive,
  readSqliteDatabaseAdmissionDeadline,
  withSqliteDatabaseAdmissionWait,
} from "../infra/sqlite-worker-database-admission-relay.js";
import { PostgresSchemaAdmissionUnavailableError } from "./openclaw-state-db-schema-version.js";

/** Callers own replay safety; retries require a settled PostgreSQL transaction. */
export function withPostgresSchemaAdmissionRetry<T>(
  database: EngineConnection,
  operation: () => T,
  canRetry?: () => boolean,
): T {
  try {
    return operation();
  } catch (error) {
    if (
      !(error instanceof PostgresSchemaAdmissionUnavailableError) ||
      !isPostgresSqlConnection(database) ||
      canRetry?.() === false ||
      !database.isOpen ||
      database.isTransaction
    ) {
      throw error;
    }
    const deadlineAtMs = Math.min(
      Date.now() + 1000,
      readSqliteDatabaseAdmissionDeadline() ?? Infinity,
    );
    const deadline = performance.now() + Math.max(0, deadlineAtMs - Date.now());
    const pause = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    // Committed facts can still be in transit. Longer gaps fail with the original
    // error; cancellation and owner loss still win.
    return withSqliteDatabaseAdmissionWait({ deadlineAtMs }, () => {
      for (let delayMs = 10; ; delayMs = Math.min(delayMs * 2, 100)) {
        assertSqliteDatabaseAdmissionWaitActive();
        const remaining = Math.min(deadline - performance.now(), deadlineAtMs - Date.now());
        if (remaining <= 0) {
          throw error;
        }
        Atomics.wait(pause, 0, 0, Math.min(delayMs, remaining));
        assertSqliteDatabaseAdmissionWaitActive();
        if (performance.now() >= deadline || Date.now() >= deadlineAtMs) {
          throw error;
        }
        if (canRetry?.() === false || !database.isOpen || database.isTransaction) {
          throw error;
        }
        if (!getPostgresPhysicalFacts(database, { refresh: true })) {
          continue;
        }
        try {
          return operation();
        } catch (retryError) {
          if (
            !(retryError instanceof PostgresSchemaAdmissionUnavailableError) ||
            canRetry?.() === false ||
            !database.isOpen ||
            database.isTransaction
          ) {
            throw retryError;
          }
        }
      }
    });
  }
}
