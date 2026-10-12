import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";

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
