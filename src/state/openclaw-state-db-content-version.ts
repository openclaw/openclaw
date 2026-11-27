import fs from "node:fs";
import { readSqliteSourceContentVersionSync } from "../infra/sqlite-snapshot-source.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import { isExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import { existingPathOrUndefined } from "./openclaw-state-db.paths.js";

const versions = new WeakMap<object, { fingerprint: string; version: string }>();

function assertAdmittedStateRead(pathname: string, env: NodeJS.ProcessEnv): void {
  getOpenClawDatabaseMaintenanceScope()?.assertReadAdmission();
  openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
}

/** Any commit or replacement changes this; it never opens SQLite or a file descriptor. */
function readStateFamilyFingerprint(pathname: string): string {
  const canonical = fs.realpathSync.native(pathname);
  return ["", "-wal", "-journal"]
    .map((suffix) => {
      const stat = fs.lstatSync(canonical + suffix, { bigint: true, throwIfNoEntry: false });
      const identity = stat && [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs];
      return `${canonical}:${identity?.join(":")}`;
    })
    .join("|");
}

/** Returned metadata also invalidates rows when a write races cached hash selection. */
export function readAdmittedStateContentVersion(
  pathname: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  assertAdmittedStateRead(pathname, env);
  if (existingPathOrUndefined(pathname) === undefined) {
    return undefined;
  }
  const scope = getOpenClawDatabaseMaintenanceScope();
  const before = readStateFamilyFingerprint(pathname);
  const previous = scope && versions.get(scope);
  const version =
    previous?.fingerprint === before
      ? previous.version
      : readSqliteSourceContentVersionSync(pathname);
  if (scope && version !== undefined && before === readStateFamilyFingerprint(pathname)) {
    versions.set(scope, { fingerprint: before, version });
  }
  assertAdmittedStateRead(pathname, env);
  return (
    version &&
    `${isExistingOpenClawStateSchema(pathname)}:${version}:${readStateFamilyFingerprint(pathname)}`
  );
}

/** The content version's file proof alone, under the same read admission. */
export function readAdmittedStateFileFingerprint(
  pathname: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  assertAdmittedStateRead(pathname, env);
  if (existingPathOrUndefined(pathname) === undefined) {
    return undefined;
  }
  const fingerprint = `${isExistingOpenClawStateSchema(pathname)}:${readStateFamilyFingerprint(pathname)}`;
  assertAdmittedStateRead(pathname, env);
  return fingerprint;
}
