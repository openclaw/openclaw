import fs from "node:fs";
import { readSqliteSourceContentVersionSync } from "../infra/sqlite-snapshot-source.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import { isExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import { existingPathOrUndefined } from "./openclaw-state-db.paths.js";

const versions = new WeakMap<object, { fingerprint: string; version: string }>();

/**
 * Returned metadata also invalidates rows when a write races cached hash selection.
 * The maintenance scope retains the revision; outside one, a caller may supply the
 * object whose lifetime retains it (Doctor's admission reader before and after custody).
 */
export function readAdmittedStateContentVersion(
  pathname: string,
  env: NodeJS.ProcessEnv,
  revisionOwner?: object,
): string | undefined {
  const assertCurrent = () => {
    getOpenClawDatabaseMaintenanceScope()?.assertReadAdmission();
    openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
  };
  assertCurrent();
  if (existingPathOrUndefined(pathname) === undefined) {
    return undefined;
  }
  const owner = getOpenClawDatabaseMaintenanceScope() ?? revisionOwner;
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
  const previous = owner && versions.get(owner);
  const version =
    previous?.fingerprint === before
      ? previous.version
      : readSqliteSourceContentVersionSync(pathname);
  if (owner && version !== undefined && before === fingerprint()) {
    versions.set(owner, { fingerprint: before, version });
  }
  assertCurrent();
  return version && `${isExistingOpenClawStateSchema(pathname)}:${version}:${fingerprint()}`;
}
