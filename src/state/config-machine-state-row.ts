// Row access shared by worker commands and explicit native administration.
import type { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  getOrLoadSqliteDatabaseAdmissionForPath,
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../infra/sqlite-database-admission.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";

export type ConfigMachineStateDatabase = Pick<OpenClawStateKyselyDatabase, "config_machine_state">;

type ConfigMachineStateRow = { value_json: string; updated_at_ms: number };
type ConfigMachineStateRowAdmission = { row: ConfigMachineStateRow | undefined };
const ttsPathAdmission: SqliteDatabaseAdmissionKey<ConfigMachineStateRowAdmission> = {
  name: "state.tts-prefs-path",
  read(value) {
    if (!isRecord(value)) {
      return undefined;
    }
    const row = value.row;
    if (row === undefined) {
      return { row: undefined };
    }
    if (
      isRecord(row) &&
      typeof row.value_json === "string" &&
      typeof row.updated_at_ms === "number"
    ) {
      return { row: { value_json: row.value_json, updated_at_ms: row.updated_at_ms } };
    }
    return undefined;
  },
};

/** Only this named key has complete writer coverage; other machine-state owners keep their reads. */
export function publishConfigMachineStateRow(
  database: DatabaseSync,
  key: string,
  row: ConfigMachineStateRow | undefined,
): void {
  if (key === "tts.prefsPath") {
    publishSqliteDatabaseAdmission(database, ttsPathAdmission, { row });
  }
}

/** Host installation is serialized with the synchronous path writer, including absent values. */
export function getTtsMachinePathAdmission(
  databasePath: string,
  load?: () => ConfigMachineStateRow | undefined,
): ConfigMachineStateRowAdmission | undefined {
  return getOrLoadSqliteDatabaseAdmissionForPath(databasePath, ttsPathAdmission, () =>
    load ? { row: load() } : undefined,
  );
}

export function normalizeConfigMachineStateKey(key: string): string {
  const normalized = key.trim();
  if (!normalized) {
    throw new Error("config machine state key must not be empty");
  }
  return normalized;
}

export function readConfigMachineStateRowInDatabase(database: DatabaseSync, key: string) {
  const stateKey = normalizeConfigMachineStateKey(key);
  const admitted =
    stateKey === "tts.prefsPath"
      ? getSqliteDatabaseAdmission(database, ttsPathAdmission)
      : undefined;
  if (admitted) {
    return admitted.row;
  }
  if (!tableExists(database, "config_machine_state")) {
    return undefined;
  }
  const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("config_machine_state")
      .select(["value_json", "updated_at_ms"])
      .where("state_key", "=", stateKey),
  );
  // This host read is synchronous; worker results install through getTtsMachinePathAdmission.
  if (isMainThread) {
    publishConfigMachineStateRow(database, stateKey, row);
  }
  return row;
}
