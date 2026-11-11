import { formatSqliteErrorCodeSuffix } from "./sqlite-error-diagnostics.js";

export const SCHEMA_RECOVERY =
  'Stop the Gateway, preserve the database and its SQLite sidecars, resolve the reported cause, then rerun "openclaw doctor --fix" against the same state/config.';

/** Keep the cause before the location: support redaction consumes a pathname's suffix. */
export function formatSchemaMigrationFailure(
  summary: string,
  pathname: string,
  error: unknown,
): string {
  const reason = String(error)
    .replace(`SQLite schema is incomplete or noncanonical for ${pathname}: `, "")
    .replaceAll(pathname, "[redacted-path]")
    .replace(/; run openclaw doctor --fix to repair it\.$/u, ".");
  const sentence = /[.!?]$/u.test(reason) ? reason : `${reason}.`;
  return `${summary}${formatSqliteErrorCodeSuffix(error)}: ${sentence} Database: ${pathname}`;
}
