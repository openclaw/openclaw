import { appendFileSync } from "node:fs";
import { workerData } from "node:worker_threads";
const { register } = await import(workerData.sourceLoaderUrl);
register();
const { captureMethodCall } = await import("../../../test/helpers/capture-method-call.ts");
const { requireNodeSqlite, resolveNodeSqliteLocation } = await import("../../infra/node-sqlite.ts");
const sqlite = requireNodeSqlite();
const target = workerData.databasePath && resolveNodeSqliteLocation(workerData.databasePath);
// oxlint-disable-next-line typescript/unbound-method -- The fault wrapper calls the captured method with its database receiver.
const close = sqlite.DatabaseSync.prototype.close;
let failed = false;
sqlite.DatabaseSync.prototype.close = function () {
  if (target && !failed && this.location() === target) {
    failed = true;
    throw new Error("Synthetic native shared-state close failure");
  }
  return close.call(this);
};
if (workerData.schemaTrace) {
  const paths = new Set(workerData.schemaTrace.databasePaths.map(resolveNodeSqliteLocation));
  const statements = new WeakMap();
  const prepare = captureMethodCall("prepare")(sqlite.DatabaseSync.prototype);
  sqlite.DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare(this, sql);
    if (paths.has(this.location())) {
      statements.set(statement, sql);
    }
    return statement;
  };
  for (const method of ["get", "all", "iterate"]) {
    const execute = sqlite.StatementSync.prototype[method];
    sqlite.StatementSync.prototype[method] = function (...args) {
      const sql = statements.get(this);
      if (sql && /PRAGMA\s+(?:schema_version|user_version)\b/i.test(sql)) {
        appendFileSync(workerData.schemaTrace.path, `${JSON.stringify(sql)}\n`);
      }
      return Reflect.apply(execute, this, args);
    };
  }
}
await import("./session-transcript-reconcile.worker.ts");
