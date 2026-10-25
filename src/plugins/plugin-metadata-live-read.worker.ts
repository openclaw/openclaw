import { assertStateDatabaseAccessAllowed } from "../infra/gateway-state-owner.js";
import { hasVerifiedLiveSqliteOwner } from "../infra/sqlite-live-owner.js";
import { tryInspectSqliteReadOnlyInProcess } from "../infra/sqlite-readonly-inspection.js";
import type { SqliteReadOnlyOperationContext } from "../infra/sqlite-readonly-operation-types.js";
import {
  admitStateSchemaFacts,
  assertSupportedStateSchemaVersion,
} from "../state/openclaw-state-db-schema-version.js";
import { encodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import { pluginMetadataReadOperations } from "./plugin-metadata-state.read.worker.js";

export const pluginMetadataLiveReadOperations = {
  "pluginMetadata.readLive": (
    input: Parameters<(typeof pluginMetadataReadOperations)["plugins.metadata.read"]>[0],
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
          rows: pluginMetadataReadOperations["plugins.metadata.read"](input, db).rows,
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
