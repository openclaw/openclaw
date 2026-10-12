import { parentPort, workerData } from "node:worker_threads";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import {
  installSqliteDatabaseAdmissions,
  readSqliteDatabaseWriteTokenForPath,
  type SqliteDatabaseAdmissions,
} from "../sqlite-database-admission.js";
import {
  runSqliteSingleStatementSync,
  runSqliteWorkerTransactionSync,
} from "../sqlite-transaction.js";
import { PostgresSyncConnection } from "./connection.js";

const input: {
  connection: string;
  schema: string;
  storeId: string;
  path: string;
  gates: SharedArrayBuffer;
  admissions: SqliteDatabaseAdmissions;
  mode: "single" | "worker";
  id: string;
  holdStatement?: boolean;
  holdAdmission?: boolean;
} = workerData;
if (!parentPort) {
  throw new Error("PostgreSQL lock fixture requires a worker");
}
const port = parentPort;
const gates = new Int32Array(input.gates);
function wait(index: number) {
  while (Atomics.load(gates, index) === 0) {
    Atomics.wait(gates, index, 0);
  }
}

try {
  installSqliteDatabaseAdmissions(input.admissions);
  const anchor = openNodeSqliteDatabase(input.path);
  let db: PostgresSyncConnection | undefined;
  try {
    db = new PostgresSyncConnection(input.connection, input.schema, anchor, input.storeId);
    const connection = db;
    port.postMessage({ event: "ready" });
    wait(0);
    const before = readSqliteDatabaseWriteTokenForPath(input.path);
    const statement = () => {
      port.postMessage({ event: "statement" });
      if (input.holdStatement) {
        wait(2);
      }
      return connection.prepare("INSERT INTO events (id) VALUES (?)").run(input.id);
    };
    if (input.mode === "single") {
      runSqliteSingleStatementSync(db, statement);
    } else {
      runSqliteWorkerTransactionSync(
        {
          database: db,
          databasePath: input.path,
          admit(stage) {
            if (stage === "transaction") {
              port.postMessage({ event: "admission" });
              if (input.holdAdmission) {
                wait(1);
              }
            }
          },
        },
        statement,
      );
    }
    port.postMessage({
      event: "done",
      before,
      after: readSqliteDatabaseWriteTokenForPath(input.path),
    });
  } finally {
    db?.close();
    anchor.close();
  }
} catch (error) {
  port.postMessage({
    event: "done",
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  port.close();
}
