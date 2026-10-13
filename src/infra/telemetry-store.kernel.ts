import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { updateConfigMachineStateInDatabase } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import type { SuccessfulTelemetryState, TelemetryState } from "./telemetry-worker-contract.js";

const TELEMETRY_STATE_KEY = "telemetry.updateCheck";

export function readTelemetryStateInWorker(options: OpenClawStateDatabaseOptions): TelemetryState {
  const state = readConfigMachineState<TelemetryState>(TELEMETRY_STATE_KEY, options);
  return state && isRecord(state) ? state : {};
}

export function countRecentTelemetrySessionsInDatabase(
  database: DatabaseSync,
  sinceMs: number,
): number {
  const db =
    getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "session_state_events">>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("session_state_events")
      .select((builder) => builder.fn.countAll<number>().as("count"))
      .where("kind", "=", "created")
      .where("occurred_at", ">=", sinceMs),
  );
  return row?.count ?? 0;
}

export function persistTelemetrySuccessInDatabase(
  database: DatabaseSync,
  state: SuccessfulTelemetryState,
  updatedAtMs: number,
): SuccessfulTelemetryState {
  return updateConfigMachineStateInDatabase<SuccessfulTelemetryState>(
    database,
    TELEMETRY_STATE_KEY,
    (current) =>
      current?.lastPingAt !== undefined && current.lastPingAt >= state.lastPingAt ? current : state,
    updatedAtMs,
  );
}
