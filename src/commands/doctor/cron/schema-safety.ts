import { assertCronStateReadSchemaReadOnly } from "../../../cron/store/read-only.js";
import { isSqliteSchemaVersionError } from "../../../infra/sqlite-user-version.js";
import { isStatePostgres } from "../../../state/openclaw-state-db-engine.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync } from "../../../state/openclaw-state-db-readonly.js";

export async function assertCronStateSchemaSupportedAsync(env?: NodeJS.ProcessEnv): Promise<void> {
  if (isStatePostgres()) {
    await assertCronStateReadSchemaReadOnly(env);
    return;
  }
  await withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(() => undefined, { env });
}

export function rethrowSqliteSchemaVersionError(error: unknown): void {
  if (isSqliteSchemaVersionError(error)) {
    throw error;
  }
}
