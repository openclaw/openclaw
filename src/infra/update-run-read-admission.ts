import type {
  OpenClawStateDatabaseOptions,
  OpenClawStateSchemaReadAdmission,
} from "../state/openclaw-state-db-contract.js";
import { isStatePostgres } from "../state/openclaw-state-db-engine.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseCurrentReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateReadOnlyDatabase } from "../state/openclaw-state-read.types.js";
import { withEngineStoreAdmission } from "./database-engine/admission-scope.js";

/** PostgreSQL reads admitted rows; SQLite retains private snapshots and legacy catalog admission. */
export function withUpdateRunRead<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions & { allowNativeRead?: true },
  schemaAdmission?: OpenClawStateSchemaReadAdmission,
): T | undefined {
  if (isStatePostgres()) {
    return withEngineStoreAdmission(() =>
      withExistingOpenClawStateDatabaseCurrentReadOnly(operation, options),
    );
  }
  const read = options.allowNativeRead
    ? withExistingOpenClawStateDatabaseCurrentReadOnly
    : withExistingOpenClawStateDatabaseArtifactPreservingReadOnly;
  return read(operation, options, schemaAdmission);
}
