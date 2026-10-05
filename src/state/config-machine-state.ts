// Machine-owned values retired from openclaw.json live in the shared state database.
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
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
  { type: "nodeHost.config" | "operator.channelPolicy" | "tts.prefsPath" }
>;

export function isConfigMachineStateReadCommand(
  command: OpenClawStateReadCommand,
): command is ConfigMachineStateReadCommand {
  return (
    command.type === "nodeHost.config" ||
    command.type === "operator.channelPolicy" ||
    command.type === "tts.prefsPath"
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

export function normalizeConfigMachineStateKey(key: string): string {
  const normalized = key.trim();
  if (!normalized) {
    throw new Error("config machine state key must not be empty");
  }
  return normalized;
}

export function readConfigMachineStateRowInDatabase(database: DatabaseSync, key: string) {
  if (!tableExists(database, "config_machine_state")) {
    return undefined;
  }
  const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database);
  return executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("config_machine_state")
      .select(["value_json", "updated_at_ms"])
      .where("state_key", "=", normalizeConfigMachineStateKey(key)),
  );
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Callers own the JSON shape for open-ended state keys.
export function readConfigMachineStateWithMetadata<T>(
  key: string,
  options: OpenClawStateDatabaseOptions = {},
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): { value: T; updatedAtMs: number } | undefined {
  const read = ({ db: database }: { db: DatabaseSync }) =>
    readConfigMachineStateWithMetadataInDatabase<T>(database, key);
  return behavior.artifactPreservingReadOnly
    ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(read, options)
    : withExistingOpenClawStateDatabaseReadOnly(read, options);
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Callers own the JSON shape for open-ended state keys.
export function readConfigMachineStateWithMetadataInDatabase<T>(
  database: DatabaseSync,
  key: string,
): { value: T; updatedAtMs: number } | undefined {
  const row = readConfigMachineStateRowInDatabase(database, key);
  return row
    ? { value: JSON.parse(row.value_json) as T, updatedAtMs: row.updated_at_ms }
    : undefined;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Callers own the JSON shape for open-ended state keys.
export function readConfigMachineState<T>(
  key: string,
  options: OpenClawStateDatabaseOptions = {},
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): T | undefined {
  return readConfigMachineStateWithMetadata<T>(key, options, behavior)?.value;
}
