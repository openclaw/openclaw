import { fileURLToPath } from "node:url";
import { isDeletedAgentDatabasePath } from "./agent-database-readers.js";

/** Resolve SQLite's absolute URLs and encoded filename form at filesystem boundaries. */
export function resolveSqliteDatabaseFilePath(location: string): string {
  if (!location.startsWith("file:")) {
    return location;
  }
  const [uriFilename = ""] = location.slice("file:".length).split(/[?#]/u, 1);
  return uriFilename.startsWith("/") ? fileURLToPath(location) : decodeURIComponent(uriFilename);
}

/** Read-only identity descriptors must not reopen after a departed agent is fenced. */
export function isDepartedAgentSqliteAdmission(location: string): boolean {
  if (!location || location === ":memory:") {
    return false;
  }
  const filename = location.startsWith("file:")
    ? resolveSqliteDatabaseFilePath(location)
    : location;
  return filename !== ":memory:" && isDeletedAgentDatabasePath(filename);
}
