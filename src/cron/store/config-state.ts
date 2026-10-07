// Cron store selection preserves the retired configured partition through shared SQLite state.
import type { DatabaseSync } from "node:sqlite";
import {
  readConfigMachineState,
  readConfigMachineStateRowInDatabase,
} from "../../state/config-machine-state.js";

export function readCronStoreStatePathInDatabase(db: DatabaseSync): string | undefined {
  const row = readConfigMachineStateRowInDatabase(db, "cron.store");
  const value: unknown = row ? JSON.parse(row.value_json) : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readCronStoreStatePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = readConfigMachineState<unknown>("cron.store", { env });
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
