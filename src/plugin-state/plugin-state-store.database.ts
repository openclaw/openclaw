import { hasErrnoCode } from "../infra/errno.js";
import { isTerminalSqliteIntegrityError } from "../infra/sqlite-integrity.js";
import { isSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { resolveDatabasePath } from "../state/openclaw-state-db-maintenance.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { hasOpenClawStateTablesBeyondStartupCheckpoint } from "../state/openclaw-state-db-schema-helpers.js";
import {
  isOpenClawStateDatabaseOpen,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createPluginStateError, type PluginStateDatabase } from "./plugin-state-store.kernel.js";
import {
  PluginStateStoreError,
  type PluginStateStoreErrorCode,
  type PluginStateStoreOperation,
} from "./plugin-state-store.types.js";
export function wrapPluginStateError(
  error: unknown,
  operation: PluginStateStoreOperation,
  fallbackCode: PluginStateStoreErrorCode,
  message: string,
  pathname = resolveOpenClawStateSqlitePath(process.env),
): PluginStateStoreError {
  if (error instanceof PluginStateStoreError) {
    return error;
  }
  let publicMessage = message;
  // Only owner-classified failures get public hints. Cause messages can contain
  // database paths, SQL, or stored values and must stay out of this message.
  if (fallbackCode === "PLUGIN_STATE_OPEN_FAILED") {
    if (isSqliteSchemaVersionError(error)) {
      publicMessage +=
        "\nThe state database uses a newer schema. Run an OpenClaw build that supports it.";
    } else if (error instanceof Error && isTerminalSqliteIntegrityError(error)) {
      publicMessage +=
        "\nDatabase integrity verification failed. Restore or repair the state database, then run openclaw doctor --fix.";
    }
  }
  return createPluginStateError({
    code: fallbackCode,
    operation,
    message: publicMessage,
    path: pathname,
    cause: error,
  });
}

function openPluginStateDatabase(
  operation: PluginStateStoreOperation = "open",
  options: OpenClawStateDatabaseOptions = {},
): PluginStateDatabase {
  const env = options.env ?? process.env;
  const pathname = resolveOpenClawStateSqlitePath(env);
  try {
    return openOpenClawStateDatabase(options);
  } catch (error) {
    throw wrapPluginStateError(
      error,
      operation,
      "PLUGIN_STATE_OPEN_FAILED",
      "Failed to open the plugin state database.",
      pathname,
    );
  }
}

function isMissingPluginStateTableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    hasErrnoCode(error, "ERR_SQLITE_ERROR") &&
    error.message === "no such table: plugin_state_entries"
  );
}

/** Read plugin state without joining the shared writable database lifecycle. */
export function withPluginStateDatabaseReadOnly<T>(
  operationName: PluginStateStoreOperation,
  operation: (store: PluginStateDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T | undefined {
  const pathname = resolveDatabasePath(options);
  let operationStarted = false;
  try {
    return withExistingOpenClawStateDatabaseReadOnly(({ db, path }) => {
      operationStarted = true;
      try {
        return operation({ db, path });
      } catch (error) {
        if (isMissingPluginStateTableError(error)) {
          // The lease bootstrap creates exactly schema_meta + state_leases before the first write;
          // any other table means the missing plugin-state table is damage, not fresh state.
          if (!hasOpenClawStateTablesBeyondStartupCheckpoint(db)) {
            return undefined;
          }
        }
        throw error;
      }
    }, options);
  } catch (error) {
    if (!operationStarted) {
      throw wrapPluginStateError(
        error,
        operationName,
        "PLUGIN_STATE_OPEN_FAILED",
        "Failed to open the plugin state database.",
        pathname,
      );
    }
    throw error;
  }
}
export function runWriteTransaction<T>(
  operation: PluginStateStoreOperation,
  write: (store: PluginStateDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T {
  // Only cold acquisition failures are open errors. A held owner's ownership or
  // transaction failure must remain a write error, with its callback supplying the handle.
  if (!isOpenClawStateDatabaseOpen(resolveOpenClawStateSqlitePath(options.env ?? process.env))) {
    openPluginStateDatabase(operation, options);
  }
  return runOpenClawStateWriteTransaction(write, options);
}
