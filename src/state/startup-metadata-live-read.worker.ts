import { configHealthReadOperations } from "../config/io.health-state.kernel.js";
import { StateDatabaseAdmissionPendingError } from "../infra/gateway-state-owner-record.js";
import { assertStateDatabaseAccessAllowed } from "../infra/gateway-state-owner.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { readSqliteDatabaseCleanClose } from "../infra/sqlite-database-admission.js";
import { runWithSqliteCleanup } from "../infra/sqlite-lifecycle-errors.js";
import { hasVerifiedLiveSqliteOwner } from "../infra/sqlite-live-owner.js";
import {
  requiresSqliteRollbackRecoveryInProcess,
  tryInspectSqliteReadOnlyInProcess,
} from "../infra/sqlite-readonly-inspection.js";
import type {
  SqliteReadOnlyOperationContext,
  SqliteReadOnlyOperationExecutionContext,
} from "../infra/sqlite-readonly-operation-types.js";
import {
  StateSchemaMutationConflictError,
  withStateDatabaseSchemaMaintenance,
} from "../infra/state-database-maintenance.js";
import {
  isUpdateRunAdmissionReadCommand,
  type UpdateRunAdmissionReadCommand,
} from "../infra/update-run-admission.types.js";
import { pluginMetadataReadOperations } from "../plugins/plugin-metadata-state.read.worker.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";
import { openDoctorStateSchemaReadAdmission } from "./openclaw-state-db-doctor-schema.js";
import {
  admitStateSchemaFacts,
  assertSupportedStateSchemaVersion,
} from "./openclaw-state-db-schema-version.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";

type StartupMetadataRead =
  | UpdateRunAdmissionReadCommand
  | { type: "config.health.read"; input: undefined }
  | {
      type: "plugins.metadata.read";
      input: Parameters<(typeof pluginMetadataReadOperations)["plugins.metadata.read"]>[0];
    };

export const startupMetadataReadOperations = {
  "startupMetadata.rollbackRecoveryRequired": (
    _input: undefined,
    context: SqliteReadOnlyOperationContext,
  ) => requiresSqliteRollbackRecoveryInProcess(context.path),
  "startupMetadata.readCurrent": async (
    command: StartupMetadataRead,
    context: SqliteReadOnlyOperationExecutionContext,
  ) => {
    // Update policy stays out of ordinary config/plugin reads. Load it before
    // native admission so no SQLite handle or snapshot is held across the await.
    const readMetadata = isUpdateRunAdmissionReadCommand(command)
      ? await import("../infra/update-run-admission.read.js").then(
          ({ readUpdateRunAdmissionCommand }) =>
            (db: EngineConnection) =>
              readUpdateRunAdmissionCommand(db, command),
        )
      : command.type === "config.health.read"
        ? (db: EngineConnection) => configHealthReadOperations[command.type](command.input, db)
        : (db: EngineConnection) => pluginMetadataReadOperations[command.type](command.input, db);
    context.assertCurrent();
    assertStateDatabaseAccessAllowed(context.path);
    const inspect = (db: EngineConnection) => {
      let sourceAdmitted = false;
      try {
        const recoveryAdmission = command.type === "updateRuns.recoveryAdmission";
        const release = recoveryAdmission ? openDoctorStateSchemaReadAdmission(db) : undefined;
        return runWithSqliteCleanup({ release: () => release?.() }, "Current metadata read", () => {
          const schemaContext = recoveryAdmission ? "doctor-maintenance" : "runtime";
          admitStateSchemaFacts(db, context.path, schemaContext);
          assertSupportedStateSchemaVersion(db, context.path, undefined, undefined, schemaContext);
          assertStateDatabaseAccessAllowed(context.path);
          sourceAdmitted = true;
          return {
            ok: true as const,
            result: readMetadata(db),
          };
        });
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
