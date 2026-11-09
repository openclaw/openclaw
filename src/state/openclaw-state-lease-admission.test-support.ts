import type { SqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";

export function requestLeaseAdmission(
  admission: SqliteWorkerOperationAdmission,
  stage: "transaction" | "commit",
  facts: unknown,
): number {
  const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  admission.port.postMessage({ stage, facts, decision: decision.buffer }, []);
  admission.service();
  return Atomics.load(decision, 0);
}
