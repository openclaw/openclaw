import { AsyncLocalStorage } from "node:async_hooks";
import type { DevicePairingAdmissionFacts } from "./device-pairing-admission.types.js";
import type { DevicePairingCommitReceipt } from "./device-pairing-read.types.js";
import { requestSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

const admission = new AsyncLocalStorage<DevicePairingAdmissionFacts[]>();

/** Recheck live host custody while the authoritative SQLite rows remain locked. */
export function requestDevicePairingMutationAdmission(facts: DevicePairingAdmissionFacts): void {
  const requests = admission.getStore();
  if (!requests) {
    throw new Error("Pairing mutation requires its worker transaction");
  }
  const captured = structuredClone(facts);
  requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: [captured] });
  requests.push(captured);
}

export function withDevicePairingMutationAdmission<T>(
  operate: () => { value: T; receipt?: DevicePairingCommitReceipt },
): T {
  return admission.run([], () => {
    requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: [] });
    const { value, receipt } = operate();
    const facts = admission.getStore()!;
    if (receipt) {
      facts.push({ kind: "pairing-publication", receipt });
    }
    requestSqliteWorkerOperationAdmission({ stage: "commit", facts });
    return value;
  });
}
