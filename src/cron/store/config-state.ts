// Cron store selection preserves the retired configured partition through shared SQLite state.
import type { EngineConnection } from "../../infra/sql-connection.js";
import {
  readConfigMachineState,
  readConfigMachineStateRowInDatabase,
} from "../../state/config-machine-state.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";

export function readCronStoreStatePathInDatabase(db: EngineConnection): string | undefined {
  const row = readConfigMachineStateRowInDatabase(db, "cron.store");
  const value: unknown = row ? JSON.parse(row.value_json) : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readCronStoreStatePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = readConfigMachineState<unknown>("cron.store", { env });
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Runtime selection reads through the shared-state worker. */
export async function readCronStoreStatePathAsync(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const result = await executeExistingOpenClawStateRead({ env }, { type: "cron.store" });
  if (!result) {
    return undefined;
  }
  const value: unknown = result.row ? JSON.parse(result.row.value_json) : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
