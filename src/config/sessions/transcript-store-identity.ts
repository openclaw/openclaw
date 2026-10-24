import { getPostgresPhysicalFactsForPath } from "../../infra/database-engine/physical-facts.js";
import { getSqliteDatabaseAdmissionIdentityForPath } from "../../infra/sqlite-database-admission.js";

/** Match admitted aliases without probing paths or admitting a new database. */
export function sameSessionTranscriptStorePath(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  const leftIdentity = getSqliteDatabaseAdmissionIdentityForPath(left);
  const rightIdentity = getSqliteDatabaseAdmissionIdentityForPath(right);
  if (!leftIdentity || !rightIdentity) {
    return false;
  }
  // The registry gate keeps PostgreSQL fact reads on already admitted paths.
  const leftPostgres = getPostgresPhysicalFactsForPath(left);
  const rightPostgres = getPostgresPhysicalFactsForPath(right);
  if (leftPostgres || rightPostgres) {
    return Boolean(
      leftPostgres &&
      rightPostgres &&
      leftPostgres.namespace === rightPostgres.namespace &&
      leftPostgres.storeId === rightPostgres.storeId,
    );
  }
  return (
    leftIdentity.key === rightIdentity.key && leftIdentity.birthtime === rightIdentity.birthtime
  );
}
