import { writeConfigMachineStateInDatabase } from "./config-machine-state-write.js";
import type { WorkerOperations, WorkerWriteOperationContext } from "./worker-operation-registry.js";

export const machineStateOperations = {
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
