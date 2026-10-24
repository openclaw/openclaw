import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { MessagePort, parentPort, workerData } from "node:worker_threads";
import { withOpenClawStateReadOnlyLocation } from "../../state/openclaw-state-db-read-connection.js";
import { PostgresSchemaAdmissionUnavailableError } from "../../state/openclaw-state-db-schema-version.js";
import { postgresStateReadSnapshot } from "../../state/openclaw-state-postgres-snapshot-context.js";
import { withSqliteDatabaseAdmissionExchange } from "../sqlite-database-admission-context.js";
import {
  installSqliteDatabaseAdmissions,
  type SqliteDatabaseAdmissions,
} from "../sqlite-database-admission.js";
import {
  bindSqliteDatabaseAdmissionUpstream,
  exchangeSqliteDatabaseAdmissions,
} from "../sqlite-worker-database-admission-relay.js";
import { runWithSqliteWorkerStateContext } from "../sqlite-worker-state-context.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { installDatabaseEngineSelection, type DatabaseEngineSelection } from "./context.js";

const input = workerData as {
  path: string;
  environment: NodeJS.ProcessEnv & { OPENCLAW_STATE_DIR: string };
  selection: DatabaseEngineSelection;
  admissions: SqliteDatabaseAdmissions;
  gate: SharedArrayBuffer;
  snapshot?: string;
  throwFromCallback?: boolean;
};
if (!parentPort) {
  throw new Error("State admission fixture requires a worker");
}
const port = parentPort;
const [initial]: unknown[] = await once(port, "message");
const admissionPort = (initial as { admissionPort?: unknown })?.admissionPort;
if (!(admissionPort instanceof MessagePort)) {
  throw new Error("State admission fixture requires its owner's relay");
}
const statements = channel("openclaw.database.statement");
let callbackCalls = 0;
let transactions = 0;
let paused = false;
const listener = (message: unknown) => {
  const event = message as { engine?: string; sql?: string; outcome?: string };
  if (
    event.engine !== "postgres" ||
    event.sql !== "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" ||
    event.outcome !== "ok"
  ) {
    return;
  }
  transactions++;
  if (paused) {
    return;
  }
  paused = true;
  port.postMessage({ phase: "reader-begun" });
  if (Atomics.wait(new Int32Array(input.gate), 0, 0, 30_000) === "timed-out") {
    throw new Error("State admission fixture was not released");
  }
};

try {
  installSqliteDatabaseAdmissions(input.admissions);
  installDatabaseEngineSelection(input.selection);
  bindSqliteDatabaseAdmissionUpstream(admissionPort);
  statements.subscribe(listener);
  const read = () =>
    withSqliteDatabaseAdmissionExchange(
      (admissions, location, create) =>
        exchangeSqliteDatabaseAdmissions(admissionPort, admissions, location, create),
      () =>
        withEngineStoreAdmission(() =>
          runWithSqliteWorkerStateContext({ environment: input.environment }, () =>
            withOpenClawStateReadOnlyLocation(
              ({ db }) => {
                callbackCalls++;
                if (input.throwFromCallback) {
                  throw new PostgresSchemaAdmissionUnavailableError("Callback admission failed");
                }
                return db
                  .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
                  .get("admission.fixture")?.value_json;
              },
              input.path,
              input.path,
            ),
          ),
        ),
    );
  const value = input.snapshot
    ? postgresStateReadSnapshot.run({ path: input.path, snapshot: input.snapshot }, read)
    : read();
  port.postMessage({ ok: true, value, callbackCalls, transactions });
} catch (error) {
  port.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    callbackCalls,
    transactions,
  });
} finally {
  statements.unsubscribe(listener);
  admissionPort.close();
  port.close();
}
