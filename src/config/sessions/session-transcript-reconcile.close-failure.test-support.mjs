import { DatabaseSync } from "node:sqlite";
import { workerData } from "node:worker_threads";
// Capture the native method without a source import; every call below passes its receiver.
const close = Reflect.get(DatabaseSync.prototype, "close");
let failed = false;
DatabaseSync.prototype.close = function () {
  if (!failed && this.location() === workerData.databasePath) {
    failed = true;
    throw new Error("Synthetic native shared-state close failure");
  }
  return close.call(this);
};
await import(workerData.workerUrl);
