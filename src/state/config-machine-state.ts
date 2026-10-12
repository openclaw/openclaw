// Machine-owned values retired from openclaw.json live in the shared state database.
import type { DatabaseSync } from "node:sqlite";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { readConfigMachineStateRowInDatabase } from "./config-machine-state-row.js";
export {
  getTtsMachinePathAdmission,
  normalizeConfigMachineStateKey,
  publishConfigMachineStateRow,
  readConfigMachineStateRowInDatabase,
  type ConfigMachineStateDatabase,
} from "./config-machine-state-row.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadResult,
} from "./openclaw-state-read.types.js";

type ConfigMachineStateReadCommand = Extract<
  OpenClawStateReadCommand,
  {
    type:
      | "nodeHost.config"
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
    command.type === "operator.channelPolicy" ||
    command.type === "tts.prefsPath" ||
    command.type === "voicewake.triggers" ||
    command.type === "voicewake.routing"
  );
}

export function readConfigMachineStateCommandInDatabase(
  database: DatabaseSync,
  command: ConfigMachineStateReadCommand,
): Extract<OpenClawStateReadResult, { type: ConfigMachineStateReadCommand["type"] }> {
  return {
    type: command.type,
    // Activation may precede deferred publication; never issue authority before v19.
    row:
      command.type === "operator.channelPolicy" &&
      (getAdmittedSqliteSchemaFacts(database)?.userVersion ?? 0) < 19
        ? undefined
        : readConfigMachineStateRowInDatabase(database, command.type),
  };
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Callers own the JSON shape for open-ended state keys.
export function readConfigMachineState<T>(
  key: string,
  options: OpenClawStateDatabaseOptions = {},
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): T | undefined {
  const read = ({ db: database }: { db: DatabaseSync }) => {
    const row = readConfigMachineStateRowInDatabase(database, key);
    // SAFETY: Each key's owner defines its persisted JSON shape.
    return row ? (JSON.parse(row.value_json) as T) : undefined;
  };
  return behavior.artifactPreservingReadOnly
    ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(read, options)
    : withExistingOpenClawStateDatabaseReadOnly(read, options);
}
