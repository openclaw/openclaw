import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
} from "./openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";

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
  if (!result.ok || result.type !== "machineState.read") {
    throw new Error(result.ok ? "Unexpected machine state reply" : result.message);
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
  if (!result.ok || result.type !== key) {
    throw new Error(result.ok ? "Unexpected voice wake state reply" : result.message);
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
  const context = captureOpenClawStateWorkerContext(options);
  return runOpenClawStateWorkerOperation(context, (scope) =>
    scope.execute({ type: "machineState.write", input: { key, value } }),
  );
}
