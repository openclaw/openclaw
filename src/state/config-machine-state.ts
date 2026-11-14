// Machine-owned values retired from openclaw.json live in the shared state database.
import type { EngineConnection } from "../infra/sql-connection.js";
import { readConfigMachineStateRowInDatabase } from "./config-machine-state-row.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";

export {
  getTtsMachinePathAdmission,
  readConfigMachineStateRowInDatabase,
  type ConfigMachineStateDatabase,
} from "./config-machine-state-row.js";

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Callers own the JSON shape for open-ended state keys.
export function readConfigMachineState<T>(
  key: string,
  options: OpenClawStateDatabaseOptions = {},
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): T | undefined {
  const read = ({ db: database }: { db: EngineConnection }) => {
    const row = readConfigMachineStateRowInDatabase(database, key);
    // SAFETY: Each key's owner defines its persisted JSON shape.
    return row ? (JSON.parse(row.value_json) as T) : undefined;
  };
  return behavior.artifactPreservingReadOnly
    ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(read, options)
    : withExistingOpenClawStateDatabaseReadOnly(read, options);
}
