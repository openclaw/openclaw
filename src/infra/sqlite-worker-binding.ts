import type { EngineConnection } from "./sql-connection.js";
import { assertTransactionUsable } from "./sqlite-transaction.js";
import type { SqliteWorkerBackend, SqliteWorkerOperations } from "./sqlite-worker-contract.js";

export type SqliteWorkerDatabaseBinding<Operations extends SqliteWorkerOperations> = Omit<
  SqliteWorkerBackend<Operations>,
  "close" | "assertSettled"
> & { close(): undefined; assertOpen(this: void): void; assertSettled(): void };

type BindingImplementation<Operations extends SqliteWorkerOperations> = Pick<
  SqliteWorkerBackend<Operations>,
  "execute" | "prepare"
> & { close?(): undefined };
type Preparation<Operations extends SqliteWorkerOperations> = Required<
  Pick<SqliteWorkerBackend<Operations>, "prepare">
>;

/** A bound backend borrows native state; only its executor closes the connection. */
export function bindSqliteWorkerDatabase<Operations extends SqliteWorkerOperations>(
  database: EngineConnection,
  backend: BindingImplementation<Operations> & Preparation<Operations>,
): SqliteWorkerDatabaseBinding<Operations> & Preparation<Operations>;
export function bindSqliteWorkerDatabase<Operations extends SqliteWorkerOperations>(
  database: EngineConnection,
  backend: BindingImplementation<Operations>,
): SqliteWorkerDatabaseBinding<Operations>;
export function bindSqliteWorkerDatabase<Operations extends SqliteWorkerOperations>(
  database: EngineConnection,
  backend: BindingImplementation<Operations>,
): SqliteWorkerDatabaseBinding<Operations> {
  let closed = false;
  const assertOpen = () => {
    // Preserve the native rollback failure even after retirement closes the handle.
    assertTransactionUsable(database);
    if (closed || !database.isOpen) {
      throw new Error("SQLite worker binding is closed");
    }
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
