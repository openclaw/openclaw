import { assertStateDatabaseAccessAllowed } from "../infra/gateway-state-owner.js";
import { hasVerifiedLiveSqliteOwner } from "../infra/sqlite-live-owner.js";
import { tryInspectSqliteReadOnlyInProcess } from "../infra/sqlite-readonly-inspection.js";
import type { SqliteReadOnlyOperationContext } from "../infra/sqlite-readonly-operation-types.js";
import {
  admitStateSchemaFacts,
  assertSupportedStateSchemaVersion,
} from "../state/openclaw-state-db-schema-version.js";
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
      admitStateSchemaFacts(db, context.path);
      assertSupportedStateSchemaVersion(db, context.path);
      assertStateDatabaseAccessAllowed(context.path);
      return pluginMetadataReadOperations["plugins.metadata.read"](input, db).rows;
    });
  },
};
