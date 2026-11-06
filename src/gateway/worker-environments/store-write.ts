import { AsyncLocalStorage } from "node:async_hooks";
import type { Compilable } from "kysely";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";

const mutations = new AsyncLocalStorage<{ db: EngineConnection; changed: boolean }>();

export function captureWorkerEnvironmentChanges<Result>(db: EngineConnection, run: () => Result) {
  const mutation = { db, changed: false };
  const result = mutations.run(mutation, run);
  return { result, changed: mutation.changed };
}

export function executeWorkerEnvironmentWrite<Row>(db: EngineConnection, query: Compilable<Row>) {
  const result = executeSqliteQuerySync(db, query);
  const mutation = mutations.getStore();
  // RETURNING reports affected rows through the result set on both engines.
  if (mutation?.db === db && ((result.numAffectedRows ?? 0n) > 0n || result.rows.length > 0)) {
    mutation.changed = true;
  }
  return result;
}
