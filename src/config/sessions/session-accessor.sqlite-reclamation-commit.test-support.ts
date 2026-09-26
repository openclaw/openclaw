import { once } from "node:events";
import { parentPort, workerData } from "node:worker_threads";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import {
  markSqliteReclamationSettled,
  waitForSqliteReclamationCommit,
} from "./session-accessor.sqlite-reclamation-commit.js";

type CommitFixture = {
  databasePath: string;
  gate: SharedArrayBuffer;
  progress: SharedArrayBuffer;
  holdAfterApproval?: boolean;
  outcome?: "rollback" | "exit-before-commit" | "exit-after-commit";
};

const port = parentPort;
if (!port) {
  throw new Error("commit fixture requires a Worker parent port");
}
const fixture = workerData as CommitFixture;
const progress = new Int32Array(fixture.progress);
await once(port, "message");
const admitted = once(port, "message");
port.postMessage({ type: "admission-request", operationId: 1, admissionId: 1 });
await admitted;
const database = openNodeSqliteDatabase(fixture.databasePath);
database.exec("BEGIN IMMEDIATE; UPDATE proof SET value = 2");
try {
  waitForSqliteReclamationCommit(fixture.gate, () =>
    port.postMessage({ type: "commit-request", operationId: 1 }),
  );
  if (fixture.holdAfterApproval) {
    // Failure watchdog: a blocking parent cannot release this gate. Passing tests never time out.
    Atomics.wait(progress, 0, 0, 1_500);
  }
  if (fixture.outcome === "exit-before-commit") {
    process.exit(7);
  }
  if (fixture.outcome === "rollback") {
    throw new Error("injected worker transaction failure");
  }
  database.exec("COMMIT");
  if (fixture.outcome === "exit-after-commit") {
    process.exit(9);
  }
} catch {
  if (database.isTransaction) {
    database.exec("ROLLBACK");
  }
} finally {
  database.close();
  markSqliteReclamationSettled(fixture.gate);
}
port.postMessage({ type: "reclaimed", operationId: 1, result: true, settled: true });
port.close();
