import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { WorkerResourceReceipt } from "./capability-provider.types.js";

/** Admit bounded identity fields once at the provider/storage boundary. */
export function requireWorkerResourceReceipt(value: unknown): WorkerResourceReceipt {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.leaseId !== "string" ||
    !/^\S{1,128}$/u.test(value.leaseId) ||
    !isRecord(value.identity)
  ) {
    throw new Error("Worker provider resource receipt is invalid");
  }
  const entries = Object.entries(value.identity);
  if (entries.length === 0 || entries.length > 16) {
    throw new Error("Worker provider resource identity is invalid");
  }
  const identity: Record<string, string> = {};
  for (const [key, field] of entries) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/u.test(key) ||
      typeof field !== "string" ||
      !field.trim() ||
      field !== field.trim() ||
      field.length > 2048 ||
      /\p{Cc}/u.test(field)
    ) {
      throw new Error("Worker provider resource identity is invalid");
    }
    identity[key] = field;
  }
  return { version: 1, leaseId: value.leaseId, identity };
}

export function sameWorkerResourceReceipt(
  left: WorkerResourceReceipt,
  right: WorkerResourceReceipt,
): boolean {
  return (
    left.version === right.version &&
    left.leaseId === right.leaseId &&
    Object.keys(left.identity).length === Object.keys(right.identity).length &&
    Object.entries(left.identity).every(
      ([key, value]) => Object.hasOwn(right.identity, key) && right.identity[key] === value,
    )
  );
}

/** Missing or replaced identities never qualify an already recorded resource. */
export function assertWorkerResourceReceiptMatch(
  expected: WorkerResourceReceipt | null | undefined,
  observed: WorkerResourceReceipt | undefined,
): void {
  if (
    (expected || observed) &&
    (!expected || !observed || !sameWorkerResourceReceipt(expected, observed))
  ) {
    throw new Error("Worker provider resource receipt does not match committed identity");
  }
}
