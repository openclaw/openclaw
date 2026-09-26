import path from "node:path";
import { workerData } from "node:worker_threads";
const { register } = await import(workerData.sourceLoaderUrl);
register();
const { requireNodeSqlite } = await import("../../infra/node-sqlite.ts");
const sqlite = requireNodeSqlite();
// oxlint-disable-next-line typescript/unbound-method -- The fault wrapper calls the captured method with its database receiver.
const close = sqlite.DatabaseSync.prototype.close;
let failed = false;
sqlite.DatabaseSync.prototype.close = function () {
  const location = this.location();
  if (!failed && location && path.basename(location).startsWith("state-lifecycle.")) {
    failed = true;
    throw new Error("Synthetic native coordinator close failure");
  }
  return close.call(this);
};
await import("./session-transcript-reconcile.worker.ts");
