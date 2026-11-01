import {
  encodeOpenClawStateWorkerError,
  type OpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import type { EngineConnection } from "./sql-connection.js";
import { assertTransactionUsable } from "./sqlite-transaction.js";

/** Keep unsettled native failures with the broker; only settled errors become domain refusals. */
export function encodeSqliteWorkerDomainError(
  database: EngineConnection,
  error: unknown,
): OpenClawStateWorkerErrorPayload {
  assertTransactionUsable(database);
  if (!database.isOpen || database.isTransaction) {
    throw error;
  }
  const failure = encodeOpenClawStateWorkerError(error, { includeOrdinary: true });
  if (!failure) {
    throw error;
  }
  return failure;
}
