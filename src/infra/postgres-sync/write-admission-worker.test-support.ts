import { once } from "node:events";
import { parentPort, workerData } from "node:worker_threads";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { installSqliteDatabaseAdmissions } from "../sqlite-database-admission.js";
import { runSqliteWorkerTransactionSync } from "../sqlite-transaction.js";
import {
  requestSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "../sqlite-worker-operation-admission.js";
import { settleSqliteWorkerOperationContext } from "../sqlite-worker-operation-settlement.js";
import { PostgresSyncConnection } from "./connection.js";

if (!parentPort) {
  throw new Error("Write admission test requires a worker");
}
const port = parentPort;
const input = workerData;
const [message] = await once(port, "message");
const owner = { port: message.admission };
const gate = new Int32Array(input.gate);
installSqliteDatabaseAdmissions(input.admissions);
using anchor = openNodeSqliteDatabase(input.path);
const database = new PostgresSyncConnection(input.connection, input.schema, anchor, input.storeId);
try {
  const pid = database.prepare("SELECT pg_backend_pid() AS pid").get()!.pid;
  withSqliteWorkerOperationAdmission(owner, () =>
    runSqliteWorkerTransactionSync(
      {
        database,
        databasePath: input.path,
        admit(stage) {
          if (stage === "commit") {
            port.postMessage({ event: "commit-ready", pid });
            while (Atomics.load(gate, 0) === 0) {
              Atomics.wait(gate, 0, 0);
            }
          }
          requestSqliteWorkerOperationAdmission({ stage, facts: undefined });
        },
      },
      () => database.prepare("INSERT INTO events VALUES (?)").run("worker"),
    ),
  );
  settleSqliteWorkerOperationContext(owner, "completed");
  port.postMessage({ event: "done" });
} catch (error) {
  settleSqliteWorkerOperationContext(owner, "unknown");
  throw error;
} finally {
  database.close();
  owner.port.close();
  port.close();
}
