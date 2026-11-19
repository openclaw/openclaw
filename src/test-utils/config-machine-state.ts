import { readConfigMachineStateRowInDatabase } from "../state/config-machine-state.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Tests own the JSON shape for each persisted key.
export function readConfigMachineStateWithMetadata<T>(
  key: string,
  options: OpenClawStateDatabaseOptions = {},
): { value: T; updatedAtMs: number } | undefined {
  return withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
    const row = readConfigMachineStateRowInDatabase(db, key);
    // SAFETY: Each test supplies the JSON shape written by the key's owner.
    return row
      ? { value: JSON.parse(row.value_json) as T, updatedAtMs: row.updated_at_ms }
      : undefined;
  }, options);
}
