// Machine-owned values retired from openclaw.json live in the shared state database.
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
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadResult,
} from "./openclaw-state-read.types.js";

type ConfigMachineStateReadCommand = Extract<
  OpenClawStateReadCommand,
  {
    type:
      | "nodeHost.config"
      | "operator.channelPolicy"
      | "tts.prefsPath"
      | "voicewake.triggers"
      | "voicewake.routing";
  }
>;

export function isConfigMachineStateReadCommand(
  command: OpenClawStateReadCommand,
): command is ConfigMachineStateReadCommand {
  return (
    command.type === "nodeHost.config" ||
    command.type === "operator.channelPolicy" ||
    command.type === "tts.prefsPath" ||
    command.type === "voicewake.triggers" ||
    command.type === "voicewake.routing"
  );
}

export function readConfigMachineStateCommandInDatabase(
  database: DatabaseSync,
  command: ConfigMachineStateReadCommand,
): Extract<OpenClawStateReadResult, { type: ConfigMachineStateReadCommand["type"] }> {
  return {
    type: command.type,
    // Activation may precede deferred publication; never issue authority before v19.
    row:
      command.type === "operator.channelPolicy" &&
      (getAdmittedSqliteSchemaFacts(database)?.userVersion ?? 0) < 19
        ? undefined
        : readConfigMachineStateRowInDatabase(database, command.type),
  };
}

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

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Callers own the JSON shape for open-ended state keys.
export function readConfigMachineState<T>(
  key: string,
  options: OpenClawStateDatabaseOptions = {},
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): T | undefined {
  const read = ({ db: database }: { db: DatabaseSync }) => {
    const row = readConfigMachineStateRowInDatabase(database, key);
    // SAFETY: Each key's owner defines its persisted JSON shape.
    return row ? (JSON.parse(row.value_json) as T) : undefined;
  };
  return behavior.artifactPreservingReadOnly
    ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(read, options)
    : withExistingOpenClawStateDatabaseReadOnly(read, options);
}
