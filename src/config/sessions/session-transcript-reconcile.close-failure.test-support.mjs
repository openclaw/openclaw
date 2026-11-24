import { DatabaseSync } from "node:sqlite";
import { workerData } from "node:worker_threads";
// Capture the original before installing the shim; invoke it below with the SQLite receiver.
const close = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "close").value;
let failed = false;
DatabaseSync.prototype.close = function () {
  if (!failed && this.location() === workerData.databasePath) {
    failed = true;
    throw new Error("Synthetic native shared-state close failure");
  }
  return close.call(this);
};
await import(workerData.workerUrl);
