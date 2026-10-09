import { readSqliteSourceContentVersionSync } from "../infra/sqlite-snapshot-source.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import { isExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import { existingPathOrUndefined } from "./openclaw-state-db.paths.js";

/** The read-only owner has checked retained scopes and exited discovery first. */
export function readAdmittedStateContentVersion(
  pathname: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const assertCurrent = () => {
    getOpenClawDatabaseMaintenanceScope()?.assertReadAdmission();
    openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
  };
  assertCurrent();
  if (existingPathOrUndefined(pathname) === undefined) {
    return undefined;
  }
  const version = readSqliteSourceContentVersionSync(pathname);
  assertCurrent();
  return version === undefined
    ? undefined
    : `${pathname}:${isExistingOpenClawStateSchema(pathname)}:${version}`;
}
