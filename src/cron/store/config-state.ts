// Cron store selection preserves the retired configured partition through shared SQLite state.
import { readConfigMachineStateAsync } from "../../state/config-machine-state-async.js";
import { readConfigMachineState } from "../../state/config-machine-state.js";

export function readCronStoreStatePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = readConfigMachineState<unknown>("cron.store", { env });
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Runtime selection reads through the shared-state worker. */
export async function readCronStoreStatePathAsync(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const value = await readConfigMachineStateAsync<unknown>("cron.store", { env });
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
