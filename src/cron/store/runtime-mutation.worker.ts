import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { ownedWorkerBytes } from "../../infra/worker-transfer-bytes.js";
import type { Logger } from "../service/state.js";
import { prepareCronReceiptAuthorityPublication } from "./receipt-authority-publication.js";
import type { CronRunRecoveryOutcome } from "./run-recovery.types.js";
import type { CronRuntimeMutationContracts } from "./runtime-mutation.types.js";
import type { CronRuntimeMutationType } from "./runtime-worker.types.js";

// Two handshakes leave 3s of competing writers' 5s busy budget for SQL and rollback.
const CRON_MUTATION_ADMISSION_DEADLINE_MS = 1_000;

export function createCronMutationLogger(logs: CronRunRecoveryOutcome["logs"]): Logger {
  const record = (level: keyof Logger) => (fields: unknown, message?: string) => {
    logs.push({ level, fields, message });
  };
  return {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}

/** Policy is prepared before dispatch; the native owner requests live authority only. */
export function admitCronRuntimeMutation(nonce: string): void {
  requestSqliteWorkerOperationAdmission({
    stage: "transaction",
    facts: { nonce },
    deadlineMs: CRON_MUTATION_ADMISSION_DEADLINE_MS,
  });
}

/** Retain the outcome before commit; only the compact nonce enters the native receipt. */
export function retainCronRuntimeMutationOutcome<Type extends CronRuntimeMutationType>(
  _type: Type,
  db: DatabaseSync,
  nonce: string,
  outcome: CronRuntimeMutationContracts[Type]["outcome"],
): { nonce: string } {
  const bytes = ownedWorkerBytes(serialize(outcome));
  deferSqliteWorkerCommitReceipt(db, {
    nonce,
    receiptAuthority: prepareCronReceiptAuthorityPublication(db),
  });
  requestSqliteWorkerOperationAdmission(
    { stage: "commit", facts: { nonce, bytes }, deadlineMs: CRON_MUTATION_ADMISSION_DEADLINE_MS },
    [bytes.buffer],
  );
  return { nonce };
}
