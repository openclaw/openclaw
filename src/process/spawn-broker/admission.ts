import { AsyncLocalStorage } from "node:async_hooks";
import type { BrokerAdmission } from "./protocol.js";

const admission = new AsyncLocalStorage<BrokerAdmission>();

/** Carry the producer's admission class through asynchronous relay preparation. */
export function runWithSpawnBrokerAdmission<T>(value: BrokerAdmission, run: () => T): T {
  return admission.run(value, run);
}

export function getSpawnBrokerAdmission(): BrokerAdmission {
  return admission.getStore() ?? "command";
}
