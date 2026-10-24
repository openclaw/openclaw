import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { MessagePort, parentPort, workerData } from "node:worker_threads";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { legacySessionMigrationReadOperations } from "../../config/sessions/legacy-main-session-ledger.read.worker.js";
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
  withSqliteDatabaseAdmissionWait,
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
  startupLedger?: boolean;
  admissionTimeoutMs?: number;
  observeRefresh?: boolean;
  cancellable?: boolean;
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
let refreshed = false;
let admissionRefreshes = 0;
let readStartedAt: number | undefined;
const gate = new Int32Array(input.gate);
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
  if (Atomics.wait(gate, 0, 0, 30_000) === "timed-out") {
    throw new Error("State admission fixture was not released");
  }
  readStartedAt = Date.now();
};

try {
  installSqliteDatabaseAdmissions(input.admissions);
  installDatabaseEngineSelection(input.selection);
  bindSqliteDatabaseAdmissionUpstream(admissionPort);
  statements.subscribe(listener);
  const read = () =>
    withSqliteDatabaseAdmissionWait(
      {
        get deadlineAtMs() {
          return input.admissionTimeoutMs === undefined || readStartedAt === undefined
            ? undefined
            : readStartedAt + input.admissionTimeoutMs;
        },
        assertActive() {
          if (input.cancellable && Atomics.load(gate, 1) === 1) {
            throw new Error("State admission fixture cancelled");
          }
        },
      },
      () =>
        withSqliteDatabaseAdmissionExchange(
          (admissions, location, create) => {
            // Missing-fact refreshes carry no outgoing publications or path discovery.
            if (paused && admissions.length === 0 && location === undefined) {
              admissionRefreshes++;
            }
            const result = exchangeSqliteDatabaseAdmissions(
              admissionPort,
              admissions,
              location,
              create,
            );
            if (input.observeRefresh && paused && !refreshed) {
              refreshed = true;
              port.postMessage({ phase: "reader-refreshed" });
            }
            return result;
          },
          () =>
            withEngineStoreAdmission(() =>
              runWithSqliteWorkerStateContext({ environment: input.environment }, () =>
                withOpenClawStateReadOnlyLocation(
                  ({ db }) => {
                    callbackCalls++;
                    if (input.throwFromCallback) {
                      throw new PostgresSchemaAdmissionUnavailableError(
                        "Callback admission failed",
                      );
                    }
                    if (input.startupLedger) {
                      return legacySessionMigrationReadOperations[
                        "legacySessionMigration.readLedger"
                      ](undefined, db);
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
        ),
    );
  const value = input.snapshot
    ? postgresStateReadSnapshot.run({ path: input.path, snapshot: input.snapshot }, read)
    : read();
  port.postMessage({
    ok: true,
    value,
    callbackCalls,
    transactions,
    admissionRefreshes,
    elapsedMs: Date.now() - (readStartedAt ?? Date.now()),
  });
} catch (error) {
  const causes = collectNestedErrorCandidates(error);
  port.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    callbackCalls,
    transactions,
    admissionRefreshes,
    admissionError: causes.some(
      (cause) => cause instanceof PostgresSchemaAdmissionUnavailableError,
    ),
    errors: causes.flatMap((cause) => (cause instanceof Error ? [cause.message] : [])),
    elapsedMs: Date.now() - (readStartedAt ?? Date.now()),
  });
} finally {
  statements.unsubscribe(listener);
  admissionPort.close();
  port.close();
}
