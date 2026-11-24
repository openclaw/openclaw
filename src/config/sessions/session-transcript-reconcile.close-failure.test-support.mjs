import { DatabaseSync } from "node:sqlite";
import { workerData } from "node:worker_threads";
const close = DatabaseSync.prototype.close;
let failed = false;
DatabaseSync.prototype.close = function () {
  if (!failed && this.location() === workerData.databasePath) {
    failed = true;
    throw new Error("Synthetic native shared-state close failure");
  }
  return close.call(this);
};
await import(workerData.workerUrl);
