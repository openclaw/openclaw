// Machine-owned values retired from openclaw.json live in the shared state database.
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";

export type ConfigMachineStateDatabase = Pick<OpenClawStateKyselyDatabase, "config_machine_state">;

export function normalizeConfigMachineStateKey(key: string): string {
  const normalized = key.trim();
  if (!normalized) {
    throw new Error("config machine state key must not be empty");
  }
  return normalized;
}

export function readConfigMachineStateWithMetadataInDatabase(
  database: DatabaseSync,
  key: string,
): { value: unknown; updatedAtMs: number } | undefined {
  if (!tableExists(database, "config_machine_state")) {
    return undefined;
  }
  const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("config_machine_state")
      .select(["value_json", "updated_at_ms"])
      .where("state_key", "=", normalizeConfigMachineStateKey(key)),
  );
  if (!row) {
    return undefined;
  }
  const value: unknown = JSON.parse(row.value_json);
  return { value, updatedAtMs: row.updated_at_ms };
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Callers own the JSON shape for open-ended state keys.
export function readConfigMachineStateWithMetadata<T>(
  key: string,
  options: OpenClawStateDatabaseOptions = {},
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): { value: T; updatedAtMs: number } | undefined {
  const read = ({ db }: { db: DatabaseSync }) => {
    const row = readConfigMachineStateWithMetadataInDatabase(db, key);
    return row ? { value: row.value as T, updatedAtMs: row.updatedAtMs } : undefined;
  };
  return behavior.artifactPreservingReadOnly
    ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(read, options)
    : withExistingOpenClawStateDatabaseReadOnly(read, options);
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Callers own the JSON shape for open-ended state keys.
export function readConfigMachineState<T>(
  key: string,
  options: OpenClawStateDatabaseOptions = {},
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): T | undefined {
  return readConfigMachineStateWithMetadata<T>(key, options, behavior)?.value;
}
