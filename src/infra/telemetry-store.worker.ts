import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
} from "../state/worker-operation-registry.js";
import {
  countRecentTelemetrySessionsInDatabase,
  persistTelemetrySuccessInDatabase,
  readTelemetryStateInWorker,
} from "./telemetry-store.kernel.js";
import type { SuccessfulTelemetryState } from "./telemetry-worker-contract.js";

export const telemetryOperations = {
  "telemetry.readState": (_input: undefined, { stateOptions }) =>
    readTelemetryStateInWorker(stateOptions()),
  "telemetry.countRecentSessions": (input: { sinceMs: number }, { stateOptions }) =>
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => countRecentTelemetrySessionsInDatabase(db, input.sinceMs),
      stateOptions(),
    ) ?? 0,
  "telemetry.persistSuccess": (
    input: { state: SuccessfulTelemetryState; updatedAtMs: number },
    { open, stateOptions },
  ) =>
    runOpenClawStateWriteTransaction(
      ({ db }) => persistTelemetrySuccessInDatabase(db, input.state, input.updatedAtMs),
      { database: open(), ...stateOptions() },
      { operationLabel: "config-machine-state.update" },
    ),
} satisfies WorkerOperationHandlers;

export type TelemetryWorkerOperations = WorkerOperations<typeof telemetryOperations>;
