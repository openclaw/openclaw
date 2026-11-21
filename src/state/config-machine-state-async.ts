import { normalizeConfigMachineStateKey } from "./config-machine-state-row.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
} from "./openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { createAuthProfileCredentialWriteAdmission } from "./user-model-account-authority.js";

export async function readConfigMachineStateAsync<T>(
  key: string,
  options: OpenClawStateDatabaseOptions = {},
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): Promise<T | undefined> {
  const read = () =>
    executeExistingOpenClawStateRead(options, { type: "machineState.read", input: { key } });
  const result = await (behavior.artifactPreservingReadOnly
    ? withArtifactPreservingStateReads(read)
    : read());
  if (!result) {
    return undefined;
  }
  // SAFETY: Each key's owner defines its persisted JSON shape.
  return result.row ? (JSON.parse(result.row.value_json) as T) : undefined;
}

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
  const { runOpenClawStateWorkerOperation } = await import("./openclaw-state-worker-store.js");
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
