import { workerData } from "node:worker_threads";
const { register } = await import(workerData.sourceLoaderUrl);
register();
const { requireNodeSqlite, resolveNodeSqliteLocation } = await import("../../infra/node-sqlite.ts");
const sqlite = requireNodeSqlite();
const target = resolveNodeSqliteLocation(workerData.databasePath);
// oxlint-disable-next-line typescript/unbound-method -- The fault wrapper calls the captured method with its database receiver.
const close = sqlite.DatabaseSync.prototype.close;
let failed = false;
sqlite.DatabaseSync.prototype.close = function () {
  if (!failed && this.location() === target) {
    failed = true;
    throw new Error("Synthetic native shared-state close failure");
  }
  return close.call(this);
};
await import("./session-transcript-reconcile.worker.ts");
