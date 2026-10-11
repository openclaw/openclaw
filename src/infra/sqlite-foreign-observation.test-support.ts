import { randomUUID } from "node:crypto";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { createSqliteCommitReceipt, type SqliteCommitReceipt } from "./sqlite-commit-receipt.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
} from "./sqlite-transaction.js";
import type { SqliteWorkerBackend } from "./sqlite-worker-contract.js";

export type ObservationRow = { key: string; value: number };
export type ObservationOperations = {
  read: { input: undefined; output: { rows: ObservationRow[]; statements: string[] } };
  write: { input: ObservationRow; output: SqliteCommitReceipt<number> };
};

export function createSqliteWorkerBackend(
  _input: undefined,
  { databasePath }: { databasePath: string },
): SqliteWorkerBackend<ObservationOperations> {
  const database = openNodeSqliteDatabase(databasePath);
  let statements: string[] | undefined;
  const exec = database.exec.bind(database);
  database.exec = (sql) => {
    statements?.push(sql);
    return exec(sql);
  };
  const prepare = database.prepare.bind(database);
  database.prepare = (sql) => {
    const statement = prepare(sql);
    for (const method of ["all", "get", "run", "iterate"] as const) {
      Object.defineProperty(statement, method, {
        value: new Proxy(statement[method], {
          apply(target, receiver, parameters) {
            statements?.push(sql);
            return Reflect.apply(target, receiver, parameters);
          },
        }),
      });
    }
    return statement;
  };
  const query = getNodeSqliteKysely<{ observation_facts: ObservationRow }>(database);
  const source = { identity: databasePath, incarnation: randomUUID() };
  return {
    execute(command) {
      if (command.type === "read") {
        statements = [];
        try {
          const rows = runSqliteDeferredTransactionSync(
            database,
            () =>
              executeSqliteQuerySync(
                database,
                query.selectFrom("observation_facts").selectAll().orderBy("key"),
              ).rows,
          );
          return { rows, statements };
        } finally {
          statements = undefined;
        }
      }
      return runSqliteImmediateTransactionSync(database, () => {
        const rows = executeSqliteQuerySync(
          database,
          query
            .updateTable("observation_facts")
            .set({ value: command.input.value })
            .where("key", "=", command.input.key)
            .returningAll(),
        ).rows;
        return createSqliteCommitReceipt<number, typeof source>({
          source,
          domain: "observation-facts",
          keys: [command.input.key],
          readFact: () =>
            rows[0] ? { kind: "postimage", value: rows[0].value } : { kind: "absent" },
        });
      });
    },
    close() {
      database.close();
    },
  };
}
