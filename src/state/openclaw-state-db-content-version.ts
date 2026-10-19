import fs from "node:fs";
import { readSqliteSourceContentVersionSync } from "../infra/sqlite-snapshot-source.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import { isExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import { existingPathOrUndefined } from "./openclaw-state-db.paths.js";

const versions = new WeakMap<object, { fingerprint: string; version: string }>();

/** Returned metadata also invalidates rows when a write races cached hash selection. */
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
  const scope = getOpenClawDatabaseMaintenanceScope();
  const fingerprint = () => {
    const canonical = fs.realpathSync.native(pathname);
    return ["", "-wal", "-journal"]
      .map((suffix) => {
        const stat = fs.lstatSync(canonical + suffix, { bigint: true, throwIfNoEntry: false });
        const identity = stat && [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs];
        return `${canonical}:${identity?.join(":")}`;
      })
      .join("|");
  };
  const before = fingerprint();
  const previous = scope && versions.get(scope);
  const version =
    previous?.fingerprint === before
      ? previous.version
      : readSqliteSourceContentVersionSync(pathname);
  if (scope && version !== undefined && before === fingerprint()) {
    versions.set(scope, { fingerprint: before, version });
  }
  assertCurrent();
  return version && `${isExistingOpenClawStateSchema(pathname)}:${version}:${fingerprint()}`;
}
