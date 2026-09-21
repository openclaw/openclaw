import { AsyncLocalStorage } from "node:async_hooks";
import type { DevicePairingAdmissionFacts } from "./device-pairing-worker-contract.js";
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

export function withDevicePairingMutationAdmission<T>(operate: () => T): T {
  return admission.run([], () => {
    requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: [] });
    const result = operate();
    requestSqliteWorkerOperationAdmission({ stage: "commit", facts: admission.getStore() });
    return result;
  });
}
