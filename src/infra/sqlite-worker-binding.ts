import type { EngineConnection } from "./sql-connection.js";
import { assertTransactionUsable } from "./sqlite-transaction.js";
import type { SqliteWorkerBackend, SqliteWorkerOperations } from "./sqlite-worker-contract.js";

export type SqliteWorkerDatabaseBinding<Operations extends SqliteWorkerOperations> = Omit<
  SqliteWorkerBackend<Operations>,
  "close"
> & { close(): undefined; assertOpen(this: void): void };

/** A bound backend borrows native state; only its executor closes the connection. */
export function bindSqliteWorkerDatabase<Operations extends SqliteWorkerOperations>(
  database: EngineConnection,
  backend: Pick<SqliteWorkerBackend<Operations>, "execute" | "prepare"> & { close?(): undefined },
): SqliteWorkerDatabaseBinding<Operations> {
  let closed = false;
  const assertOpen = () => {
    if (closed || !database.isOpen) {
      throw new Error("SQLite worker binding is closed");
    }
    assertTransactionUsable(database);
  };
  return {
    ...backend,
    assertOpen,
    execute(command) {
      assertOpen();
      return backend.execute(command);
    },
    assertSettled() {
      assertOpen();
      if (database.isTransaction) {
        throw new Error("SQLite worker binding left an unsettled transaction");
      }
    },
    close() {
      closed = true;
      backend.close?.();
    },
  };
}
