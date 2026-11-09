import type { SessionsListBaseMissReason } from "../infra/diagnostic-rpc-types.js";

const baseMissReasons = new WeakMap<object, SessionsListBaseMissReason>();

/** Follow response wrappers without adding diagnostic fields to the wire payload. */
export function retainSessionListBaseMiss(result: object, reason?: SessionsListBaseMissReason) {
  if (reason) {
    baseMissReasons.set(result, reason);
  }
}

export function getSessionListBaseMiss(result: object): SessionsListBaseMissReason | undefined {
  return baseMissReasons.get(result);
}
