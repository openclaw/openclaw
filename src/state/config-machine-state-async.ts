import { normalizeConfigMachineStateKey } from "./config-machine-state.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";
import { createAuthProfileCredentialWriteAdmission } from "./user-model-account-authority.js";

export async function readVoiceWakeMachineState(
  key: "voicewake.triggers" | "voicewake.routing",
  options: OpenClawStateDatabaseOptions = {},
): Promise<{ value: unknown; updatedAtMs: number } | undefined> {
  const result = await executeExistingOpenClawStateRead(options, { type: key });
  if (!result) {
    return undefined;
  }
  return result.row
    ? { value: JSON.parse(result.row.value_json) as unknown, updatedAtMs: result.row.updated_at_ms }
    : undefined;
}

export async function writeConfigMachineStateAsync(
  key: string,
  value: unknown,
  options: OpenClawStateDatabaseOptions = {},
): Promise<number> {
  const stateKey = normalizeConfigMachineStateKey(key);
  const context = captureOpenClawStateWorkerContext(options);
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "machineState.write", input: { key: stateKey, value } }),
    stateKey === "authProfiles.store"
      ? { createAdmission: createAuthProfileCredentialWriteAdmission(context) }
      : undefined,
  );
}
