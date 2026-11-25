import {
  hasSqliteWorkerOutcomeUnknown,
  SqliteWorkerError,
  wrapSqliteWorkerError,
} from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";

export type SessionWorkerReceiptAdmission = {
  admission: SqliteWorkerOperationAdmission;
  retained: RetainedWorkerTransactionAdmission;
};

export function throwSessionWorkerOutcomeUnknown(message: string, cause: unknown): never {
  if (hasSqliteWorkerOutcomeUnknown(cause)) {
    throw cause;
  }
  throw wrapSqliteWorkerError(message, "outcome-unknown", cause);
}

/** An acknowledged native receipt survives failed result delivery; FIFO stays held until settlement. */
export async function settleSessionWorkerReceipt<T>(
  run: () => Promise<unknown>,
  getAdmission: () => SessionWorkerReceiptAdmission | undefined,
  readReceipt: (facts: unknown) => T | undefined,
  missingMessage: string,
  unsettledMessage?: string,
): Promise<T> {
  const outcome = await run().then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const admitted = getAdmission();
  if (admitted) {
    const settlement = await admitted.retained.settled;
    if (admitted.admission.settlement?.kind === "completed") {
      const receipt = readReceipt(admitted.admission.committed?.facts);
      if (receipt !== undefined) {
        return receipt;
      }
    } else if (unsettledMessage) {
      throw wrapSqliteWorkerError(
        unsettledMessage,
        "outcome-unknown",
        !outcome.ok ? outcome.error : undefined,
        settlement.kind !== "completed" ? settlement.error : undefined,
      );
    }
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  throw new SqliteWorkerError(missingMessage, "outcome-unknown");
}
