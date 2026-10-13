import { loadOrCreateConfigRevisionKeyInDatabase } from "../gateway/config-revision-key.worker.js";
import { writeConfigMachineStateInDatabase } from "./config-machine-state-write.js";
import type { WorkerOperations, WorkerWriteOperationContext } from "./worker-operation-registry.js";

export const machineStateOperations = {
  "machineState.configRevisionKey": (
    input: { candidateKey: Uint8Array },
    context: WorkerWriteOperationContext,
  ) =>
    context.write(({ db }) => loadOrCreateConfigRevisionKeyInDatabase(db, input.candidateKey), {
      operationLabel: "gateway.config-revision-key.load",
    }),
  "machineState.write": (
    input: { key: string; value: unknown },
    context: WorkerWriteOperationContext,
  ) =>
    context.write(
      ({ db }) => {
        return writeConfigMachineStateInDatabase(db, input.key, input.value);
      },
      { operationLabel: "config-machine-state.write" },
    ),
};

export type MachineStateWorkerOperations = WorkerOperations<typeof machineStateOperations>;
