import { configHealthReadOperations } from "../config/io.health-state.kernel.js";
import { assertStateDatabaseAccessAllowed } from "../infra/gateway-state-owner.js";
import { hasVerifiedLiveSqliteOwner } from "../infra/sqlite-live-owner.js";
import { tryInspectSqliteReadOnlyInProcess } from "../infra/sqlite-readonly-inspection.js";
import type { SqliteReadOnlyOperationContext } from "../infra/sqlite-readonly-operation-types.js";
import { pluginMetadataReadOperations } from "../plugins/plugin-metadata-state.read.worker.js";
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

export const startupMetadataLiveReadOperations = {
  "startupMetadata.readLive": (
    command: StartupMetadataRead,
    context: SqliteReadOnlyOperationContext,
  ) => {
    assertStateDatabaseAccessAllowed(context.path);
    if (!hasVerifiedLiveSqliteOwner(context.path)) {
      return undefined;
    }
    // Only a verified live owner permits SQLite to touch the source WAL index.
    // The isolated child closes its own read transaction, never a caller's handles.
    return tryInspectSqliteReadOnlyInProcess(context.path, (db) => {
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
    });
  },
};
