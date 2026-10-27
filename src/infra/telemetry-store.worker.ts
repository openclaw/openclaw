import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { updateConfigMachineStateInDatabase } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
} from "../state/worker-operation-registry.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import type { SuccessfulTelemetryState, TelemetryState } from "./telemetry-worker-contract.js";

const TELEMETRY_STATE_KEY = "telemetry.updateCheck";

export const telemetryOperations = {
  "telemetry.readState": (_input: undefined, { stateOptions }): TelemetryState => {
    const state = readConfigMachineState<TelemetryState>(TELEMETRY_STATE_KEY, stateOptions());
    return state && isRecord(state) ? state : {};
  },
  "telemetry.countRecentSessions": (input: { sinceMs: number }, { stateOptions }) =>
    withExistingOpenClawStateDatabaseReadOnly(({ db: database }) => {
      const db =
        getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "session_state_events">>(database);
      const row = executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("session_state_events")
          .select((builder) => builder.fn.countAll<number>().as("count"))
          .where("kind", "=", "created")
          .where("occurred_at", ">=", input.sinceMs),
      );
      return row?.count ?? 0;
    }, stateOptions()) ?? 0,
  "telemetry.persistSuccess": (
    input: { state: SuccessfulTelemetryState; updatedAtMs: number },
    { open, stateOptions },
  ) =>
    runOpenClawStateWriteTransaction(
      ({ db: database }) => {
        const { state, updatedAtMs } = input;
        return updateConfigMachineStateInDatabase<SuccessfulTelemetryState>(
          database,
          TELEMETRY_STATE_KEY,
          (current) =>
            current?.lastPingAt !== undefined && current.lastPingAt >= state.lastPingAt
              ? current
              : state,
          updatedAtMs,
        );
      },
      { database: open(), ...stateOptions() },
      { operationLabel: "config-machine-state.update" },
    ),
} satisfies WorkerOperationHandlers;

export type TelemetryWorkerOperations = WorkerOperations<typeof telemetryOperations>;
