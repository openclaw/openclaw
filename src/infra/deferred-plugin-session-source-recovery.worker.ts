import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";
import { databaseIdentity } from "./deferred-plugin-session-verification.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import type { DeferredPluginSessionImport } from "./state-migrations.deferred-session-import.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  type LegacyMigrationReceipt,
} from "./state-migrations.receipts.js";

type RebuiltSessionSources = {
  receipt: LegacyMigrationReceipt;
  rebuilt: DeferredPluginSessionImport;
  storePath: string;
  sqlitePath: string;
  physicalIdentity: string;
};

export const deferredSessionImportOperations = {
  "deferredSessionImport.rebuildSources": (
    input: RebuiltSessionSources,
    { writeAdmitted }: WorkerWriteOperationContext,
  ) =>
    writeAdmitted(
      ({ db }) => {
        if (
          !isDeepStrictEqual(
            readLegacyMigrationReceiptFromDatabase(db, input.receipt.sourceKey),
            input.receipt,
          ) ||
          databaseIdentity(input.sqlitePath, "physical") !== input.physicalIdentity ||
          databaseIdentity(input.sqlitePath) !== input.rebuilt.databaseIdentity
        ) {
          throw new Error(
            "Deferred session import changed before its source index was rebuilt. Run openclaw doctor --fix against the same state/config to retry; sources remain protected.",
          );
        }
        const reportJson = JSON.stringify(input.rebuilt);
        const index = input.rebuilt.sources.find(
          (source) => source.path === path.resolve(input.storePath),
        );
        const query = getNodeSqliteKysely<DB>(db);
        executeSqliteQuerySync(
          db,
          query
            .updateTable("migration_sources")
            .set({
              report_json: reportJson,
              ...(index
                ? { source_sha256: index.identity.sha256, source_size_bytes: index.identity.size }
                : {}),
            })
            .where("source_key", "=", input.receipt.sourceKey),
        );
        // Session-import source keys use deferred-plugin-session-import:, never deferred-plugin-migration:.
        executeSqliteQuerySync(
          db,
          query
            .updateTable("migration_runs")
            .set({ report_json: reportJson })
            .where("id", "=", input.receipt.sourceKey),
        );
      },
      { operationLabel: "state.rebuild-plugin-session-source-index" },
    ),
};
