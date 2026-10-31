import path from "node:path";
import { openExistingStatePostgresConnectionFromAnchor } from "../state/openclaw-state-db-engine.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import { isNativeClientCredentialBootstrap } from "./client-credential-native-bootstrap.js";
import { runEngineStoreReadSnapshot } from "./database-engine/adapters.js";
import { getDatabaseEngineSelection } from "./database-engine/context.js";
import { getPostgresPhysicalFacts } from "./database-engine/physical-facts.js";
import { readBackupEngine } from "./database-engine/physical-store.js";
import { withPostgresStoreMetadata } from "./database-engine/postgres-store-metadata.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "./sqlite-readonly-location.js";
import { getAdmittedSqliteSchemaFacts } from "./sqlite-schema-facts.js";
import { readUpdateCandidatePluginIndex } from "./update-candidate-plugins.js";
import type {
  UpdatePostgresStateReply,
  UpdatePostgresStateTask,
} from "./update-candidate-state.postgres.types.js";
import { readUpdateHeldAgentPaths } from "./update-candidate-state.retained.js";
import { collectRegisteredPaths } from "./update-candidate-state.shared.js";
import { serveWorkerTasks } from "./worker-task-server.js";

serveWorkerTasks<UpdatePostgresStateReply, UpdatePostgresStateTask>(
  async ({ input, files: entries, sourcePath }) => {
    if (sourcePath) {
      const anchor = readBackupEngine(sourcePath);
      if (anchor.engine !== "postgres") {
        throw new Error("PostgreSQL update inspection requires a PostgreSQL anchor.");
      }
      const postgres = getDatabaseEngineSelection()?.postgres;
      if (!postgres) {
        throw new Error("PostgreSQL update inspection requires the captured connection.");
      }
      return withPostgresStoreMetadata(postgres, anchor, async (_client, metadata) => ({
        files: entries,
        version: { userVersion: metadata.version },
      }));
    }
    const shared = path.resolve(input.stateDir, "state", "openclaw.sqlite");
    const identity = readBackupEngine(shared);
    if (identity.engine !== "postgres") {
      const snapshot = prepareSqliteReadOnlyLocationSyncInProcess(shared);
      try {
        using source = openNodeSqliteDatabase(snapshot.location, { readOnly: true });
        const credentials = isNativeClientCredentialBootstrap(source);
        const facts = getAdmittedSqliteSchemaFacts(source)!;
        const empty =
          facts.userVersion === 0 &&
          !facts.tables.size &&
          !facts.indexes.size &&
          !facts.views.size &&
          !facts.triggers.size;
        if (credentials) {
          throw new Error(
            "Native credential bootstrap cannot become a PostgreSQL anchor. Start the Gateway once on SQLite and run openclaw doctor --fix, then use openclaw database port before selecting PostgreSQL.",
          );
        }
        if (!empty) {
          throw new Error("PostgreSQL update preflight requires the matching state anchor.");
        }
        return {
          files: entries,
          version: { userVersion: 0, contentVersion: 0 },
          pluginIndex: { value: { index: { installRecords: {} } }, records: {} },
        };
      } finally {
        snapshot.cleanup();
      }
    }
    // Capture already holds maintenance custody; inspection retains its read-only anchor.
    const connection = openExistingStatePostgresConnectionFromAnchor(
      openNodeSqliteDatabase(shared, { readOnly: true }),
      shared,
    );
    const { db } = connection.database;
    try {
      // The existing owner admits the installed version without migrating or resealing it.
      return runEngineStoreReadSnapshot(db, () => {
        const files = new Map(entries);
        const registered = collectRegisteredPaths(db, shared, files);
        const held = input.includeRetainedAgentPaths
          ? readUpdateHeldAgentPaths(db, shared, files.values(), registered, input)
          : [];
        return {
          version: {
            userVersion: getPostgresPhysicalFacts(db)!.version,
            contentVersion: readStateSchemaContentVersion(db),
            ...(held.length ? { retainedAgentPaths: held } : {}),
          },
          pluginIndex: readUpdateCandidatePluginIndex(db),
          files: [...files],
        };
      });
    } finally {
      connection.close();
    }
  },
);
