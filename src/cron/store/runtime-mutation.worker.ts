import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { ownedWorkerBytes } from "../../infra/worker-transfer-bytes.js";
import type { CronRuntimeMutationContracts } from "./runtime-mutation.types.js";
import type { CronRuntimeMutationType } from "./runtime-worker.types.js";

/** Host policy is prepared only after this worker has read authoritative transaction rows. */
export function prepareCronRuntimeMutation<Type extends CronRuntimeMutationType>(
  _type: Type,
  nonce: string,
  facts: CronRuntimeMutationContracts[Type]["facts"],
): CronRuntimeMutationContracts[Type]["preparation"] {
  const { port1, port2 } = new MessageChannel();
  try {
    requestSqliteWorkerOperationAdmission(
      { stage: "transaction", facts: { nonce, preparation: facts, preparationPort: port2 } },
      [port2],
    );
    // SAFETY: the private port receives only this command's host-owned policy preparation.
    const preparation = receiveMessageOnPort(port1)?.message as
      | CronRuntimeMutationContracts[Type]["preparation"]
      | undefined;
    if (!preparation) {
      throw new Error("Cron mutation has no admitted policy preparation");
    }
    return preparation;
  } finally {
    port1.close();
    port2.close();
  }
}

/** Retain the outcome before commit; only the compact nonce enters the native receipt. */
export function retainCronRuntimeMutationOutcome<Type extends CronRuntimeMutationType>(
  _type: Type,
  db: DatabaseSync,
  nonce: string,
  outcome: CronRuntimeMutationContracts[Type]["outcome"],
): { nonce: string } {
  const bytes = ownedWorkerBytes(serialize(outcome));
  deferSqliteWorkerCommitReceipt(db, { nonce });
  requestSqliteWorkerOperationAdmission({ stage: "commit", facts: { nonce, bytes } }, [
    bytes.buffer,
  ]);
  return { nonce };
}
