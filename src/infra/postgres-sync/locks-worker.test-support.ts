import { parentPort, workerData } from "node:worker_threads";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import {
  installSqliteDatabaseAdmissions,
  readSqliteDatabaseWriteTokenForPath,
  type SqliteDatabaseAdmissions,
} from "../sqlite-database-admission.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteSingleStatementSync,
  runSqliteWorkerTransactionSync,
} from "../sqlite-transaction.js";
import { PostgresSyncConnection } from "./connection.js";

export type PostgresLockWorkerInput = Record<
  "connection" | "schema" | "storeId" | "path" | "id",
  string
> & {
  gates: SharedArrayBuffer;
  admissions: SqliteDatabaseAdmissions;
  mode: "single" | "worker" | "deferred";
  holdStatement?: boolean;
  holdAdmission?: boolean;
  holdRead?: boolean;
};
const input: PostgresLockWorkerInput = workerData;
if (!parentPort) {
  throw new Error("PostgreSQL lock fixture requires a worker");
}
const port = parentPort;
const gates = new Int32Array(input.gates);
const held = [true, input.holdAdmission, input.holdStatement, input.holdRead];
function wait(index: number) {
  while (held[index] && Atomics.load(gates, index) === 0) {
    Atomics.wait(gates, index, 0);
  }
}
const token = () => readSqliteDatabaseWriteTokenForPath(input.path);
const post = (event: string, fields: object = {}) => port.postMessage({ event, ...fields });

try {
  installSqliteDatabaseAdmissions(input.admissions);
  using anchor = openNodeSqliteDatabase(input.path);
  const db = new PostgresSyncConnection(input.connection, input.schema, anchor, input.storeId);
  try {
    post("ready");
    wait(0);
    const before = token();
    const statement = () => {
      post("statement");
      wait(2);
      if (input.mode === "deferred") {
        const value = Number(db.prepare("SELECT value FROM counter").get()!.value);
        post("read", { value });
        wait(3);
        return db.prepare("UPDATE counter SET value = ?").run(value + 1);
      }
      return db.prepare("INSERT INTO events (id) VALUES (?)").run(input.id);
    };
    if (input.mode === "single") {
      runSqliteSingleStatementSync(db, statement);
    } else if (input.mode === "deferred") {
      post("admission");
      runSqliteDeferredTransactionSync(db, statement);
    } else {
      runSqliteWorkerTransactionSync(
        {
          database: db,
          databasePath: input.path,
          admit(stage) {
            if (stage === "transaction") {
              post("admission");
              wait(1);
            }
          },
        },
        statement,
      );
    }
    post("done", { before, after: token() });
  } finally {
    db.close();
  }
} catch (error) {
  post("done", { error: error instanceof Error ? error.message : String(error) });
} finally {
  port.close();
}
