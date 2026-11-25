import type { EngineConnection } from "../../infra/sql-connection.js";
import {
  getOrLoadSqliteDatabaseAdmissionForPath,
  publishSqliteDatabaseAdmission,
  readSqliteDatabaseWriteTokenForPath,
  type SqliteDatabaseAdmissionKey,
} from "../../infra/sqlite-database-admission.js";

const readiness: SqliteDatabaseAdmissionKey<string> = {
  name: "session-transcript-index-readiness",
  schemaDependent: true,
  read: (value) => (typeof value === "string" ? value : undefined),
};

/** The physical owner retains readiness across idle writer retirement while readers remain. */
export function isSessionTranscriptIndexReady(databasePath: string): boolean {
  const token = readSqliteDatabaseWriteTokenForPath(databasePath);
  return (
    token !== undefined &&
    getOrLoadSqliteDatabaseAdmissionForPath(databasePath, readiness, () => undefined) === token
  );
}

/** Publish only after the bounded traversal and its cleanup transaction have committed. */
export function publishSessionTranscriptIndexReady(
  database: EngineConnection,
  databasePath: string,
): void {
  const token = readSqliteDatabaseWriteTokenForPath(databasePath);
  if (token !== undefined) {
    publishSqliteDatabaseAdmission(database, readiness, token);
  }
}
