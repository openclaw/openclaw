import type { EngineConnection } from "../infra/sql-connection.js";
import { readConfigMachineStateRowInDatabase } from "./config-machine-state-row.js";
import { isStateSchemaVersionAtLeast } from "./openclaw-state-db-admission.js";
import type { OpenClawStateReadCommand } from "./openclaw-state-read.types.js";
import type { WorkerOperations } from "./worker-operation-registry.js";

type ConfigMachineStateReadCommand = Extract<
  OpenClawStateReadCommand,
  {
    type:
      | "nodeHost.config"
      | "cron.store"
      | "hooks.internal.installs"
      | "operator.channelPolicy"
      | "tts.prefsPath"
      | "voicewake.triggers"
      | "voicewake.routing";
  }
>;

export function isConfigMachineStateReadCommand(
  command: OpenClawStateReadCommand,
): command is ConfigMachineStateReadCommand {
  return (
    command.type === "nodeHost.config" ||
    command.type === "cron.store" ||
    command.type === "hooks.internal.installs" ||
    command.type === "operator.channelPolicy" ||
    command.type === "tts.prefsPath" ||
    command.type === "voicewake.triggers" ||
    command.type === "voicewake.routing"
  );
}

export function readConfigMachineStateCommandInDatabase(
  database: EngineConnection,
  command: ConfigMachineStateReadCommand,
) {
  return {
    type: command.type,
    // Activation may precede deferred publication; never issue authority before v19.
    row:
      command.type === "operator.channelPolicy" && !isStateSchemaVersionAtLeast(database, 19)
        ? undefined
        : readConfigMachineStateRowInDatabase(database, command.type),
  };
}

export const machineStateReadOperations = {
  "machineState.read": (input: { key: string }, database: EngineConnection) => ({
    type: "machineState.read" as const,
    row: readConfigMachineStateRowInDatabase(database, input.key),
  }),
};

export type MachineStateReadOperations = WorkerOperations<typeof machineStateReadOperations>;
