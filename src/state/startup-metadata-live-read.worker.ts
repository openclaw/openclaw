import { configHealthReadOperations } from "../config/io.health-state.kernel.js";
import { StateDatabaseAdmissionPendingError } from "../infra/gateway-state-owner-record.js";
import { assertStateDatabaseAccessAllowed } from "../infra/gateway-state-owner.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { readSqliteDatabaseCleanClose } from "../infra/sqlite-database-admission.js";
import { runWithSqliteCleanup } from "../infra/sqlite-lifecycle-errors.js";
import { hasVerifiedLiveSqliteOwner } from "../infra/sqlite-live-owner.js";
import { tryInspectSqliteReadOnlyInProcess } from "../infra/sqlite-readonly-inspection.js";
import type { SqliteReadOnlyOperationContext } from "../infra/sqlite-readonly-operation-types.js";
import {
  StateSchemaMutationConflictError,
  withStateDatabaseSchemaMaintenance,
} from "../infra/state-database-maintenance.js";
import { pluginMetadataReadOperations } from "../plugins/plugin-metadata-state.read.worker.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";
import {
  admitStateSchemaFacts,
  assertSupportedStateSchemaVersion,
} from "./openclaw-state-db-schema-version.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";

type StartupMetadataRead =
  | { type: "config.health.read"; input: undefined }
  | {
      type: "plugins.metadata.read";
      input: Parameters<(typeof pluginMetadataReadOperations)["plugins.metadata.read"]>[0];
    };

export const startupMetadataReadOperations = {
  "startupMetadata.readCurrent": (
    command: StartupMetadataRead,
    context: SqliteReadOnlyOperationContext,
  ) => {
    assertStateDatabaseAccessAllowed(context.path);
    const inspect = (db: EngineConnection) => {
      let sourceAdmitted = false;
      try {
        admitStateSchemaFacts(db, context.path);
        assertSupportedStateSchemaVersion(db, context.path);
        assertStateDatabaseAccessAllowed(context.path);
        sourceAdmitted = true;
        return {
          ok: true as const,
          result:
            command.type === "config.health.read"
              ? configHealthReadOperations[command.type](command.input, db)
              : pluginMetadataReadOperations[command.type](command.input, db),
        };
      } catch (error) {
        // Keep domain refusals typed; native rollback/close failures still retire the child.
        const failure = encodeOpenClawStateWorkerError(error, { includeOrdinary: true });
        if (!failure) {
          throw error;
        }
        return { ok: false as const, error: failure, sourceAdmitted };
      }
    };
    if (hasVerifiedLiveSqliteOwner(context.path)) {
      // Only a verified live owner permits SQLite to touch the source WAL index.
      return tryInspectSqliteReadOnlyInProcess(context.path, inspect);
    }
    try {
      return withStateDatabaseSchemaMaintenance(
        { databasePath: context.path, busyTimeoutMs: 0 },
        () => {
          // The parent seal is only a hint. Custody keeps this checkpoint immutable
          // through native close, including while another Gateway starts.
          if (!readSqliteDatabaseCleanClose(context.path)) {
            return undefined;
          }
          const database = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(context.path), {
            readOnly: true,
            timeout: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          });
          return runWithSqliteCleanup(
            {
              release: () => {
                database.close();
              },
            },
            "Sealed startup metadata inspection",
            () => ({ value: inspect(database) }),
          );
        },
      );
    } catch (error) {
      if (
        error instanceof StateSchemaMutationConflictError ||
        error instanceof StateDatabaseAdmissionPendingError
      ) {
        return undefined;
      }
      throw error;
    }
  },
};
