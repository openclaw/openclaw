import type { DatabaseSync } from "node:sqlite";
import { readConfigMachineStateRowInDatabase } from "./config-machine-state-row.js";
import type { WorkerOperations } from "./worker-operation-registry.js";

export const machineStateReadOperations = {
  "machineState.read": (input: { key: string }, database: DatabaseSync) => ({
    type: "machineState.read" as const,
    row: readConfigMachineStateRowInDatabase(database, input.key),
  }),
};

export type MachineStateReadOperations = WorkerOperations<typeof machineStateReadOperations>;
