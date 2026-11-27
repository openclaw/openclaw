import type { EngineConnection } from "../infra/sql-connection.js";
import { readConfigMachineStateRowInDatabase } from "./config-machine-state-row.js";
import type { WorkerOperations } from "./worker-operation-registry.js";

export const machineStateReadOperations = {
  "machineState.read": (input: { key: string }, database: EngineConnection) => ({
    type: "machineState.read" as const,
    row: readConfigMachineStateRowInDatabase(database, input.key),
  }),
};

export type MachineStateReadOperations = WorkerOperations<typeof machineStateReadOperations>;
