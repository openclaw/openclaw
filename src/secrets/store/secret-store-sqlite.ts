import { hasErrnoCode } from "../../infra/errno.js";

export function withMissingSecretStoreFallback<T>(operation: () => T, missing: T): T {
  try {
    return operation();
  } catch (error) {
    if (
      error instanceof Error &&
      hasErrnoCode(error, "ERR_SQLITE_ERROR") &&
      error.message === "no such table: secret_store_entries"
    ) {
      return missing;
    }
    throw error;
  }
}
