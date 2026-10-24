import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { MessagePort, parentPort, workerData } from "node:worker_threads";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { ensureUserBackgroundSchema } from "../../state/user-background.store.js";
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
  environment: NodeJS.ProcessEnv & { OPENCLAW_STATE_DIR: string };
  selection: DatabaseEngineSelection;
  admissions: SqliteDatabaseAdmissions;
  gate: SharedArrayBuffer;
};
if (!parentPort) {
  throw new Error("Publication fixture requires a worker");
}
const port = parentPort;
const [initial]: unknown[] = await once(port, "message");
const admissionPort = (initial as { admissionPort?: unknown })?.admissionPort;
if (!(admissionPort instanceof MessagePort)) {
  throw new Error("Publication fixture requires its relay");
}
const gate = new Int32Array(input.gate);
const wait = (index: number) => {
  if (Atomics.wait(gate, index, 0, 30_000) === "timed-out") {
    throw new Error("Publication fixture was not released");
  }
};
let committed = false;
let held = false;
const statements = channel("openclaw.database.statement");
const listener = (message: unknown) => {
  const event = message as { engine?: string; sql?: string; outcome?: string };
  if (event.engine === "postgres" && event.sql === "COMMIT" && event.outcome === "ok") {
    committed = true;
  }
};
try {
  installSqliteDatabaseAdmissions(input.admissions);
  installDatabaseEngineSelection(input.selection);
  bindSqliteDatabaseAdmissionUpstream(admissionPort);
  withSqliteDatabaseAdmissionExchange(
    (admissions, location, create) => {
      if (committed && !held) {
        held = true;
        port.postMessage({ phase: "publication-pending" });
        wait(1);
      }
      return exchangeSqliteDatabaseAdmissions(admissionPort, admissions, location, create);
    },
    () =>
      withEngineStoreAdmission(() =>
        runWithSqliteWorkerStateContext({ environment: input.environment }, () => {
          openOpenClawStateDatabase({ env: input.environment });
          port.postMessage({ phase: "publisher-ready" });
          wait(0);
          statements.subscribe(listener);
          ensureUserBackgroundSchema({ env: input.environment });
          port.postMessage({ phase: "published" });
          closeOpenClawStateDatabaseForTest();
        }),
      ),
  );
  port.postMessage({ ok: true });
} catch (error) {
  port.postMessage({ error: error instanceof Error ? error.stack : String(error) });
} finally {
  statements.unsubscribe(listener);
  admissionPort.close();
  port.close();
}
