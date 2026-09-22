import { hasErrnoCode } from "../../infra/errno.js";

export function isMissingSecretStoreTableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    hasErrnoCode(error, "ERR_SQLITE_ERROR") &&
    error.message === "no such table: secret_store_entries"
  );
}
