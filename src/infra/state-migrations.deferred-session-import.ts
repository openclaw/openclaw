import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { sha256Hex } from "./crypto-digest.js";
import { databaseIdentity } from "./deferred-plugin-session-verification.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { MigrationArtifactSchema } from "./session-sqlite-migration-artifact.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationRun,
  type LegacyMigrationReceipt,
} from "./state-migrations.receipts.js";

export const DeferredPluginSessionImportSchema = z.object({
  databaseIdentity: z.string(),
  superseded: z.literal("different-database").optional(),
  pluginIds: z.array(z.string()),
  sources: z.array(
    z.object({ path: z.string(), identity: MigrationArtifactSchema.shape.identity }),
  ),
});
export type DeferredPluginSessionImport = z.infer<typeof DeferredPluginSessionImportSchema>;

export function parseSessionImportReceipt(
  params: { sqlitePath: string },
  receipt: LegacyMigrationReceipt,
) {
  const recorded = DeferredPluginSessionImportSchema.parse(JSON.parse(receipt.reportJson));
  const currentDatabaseIdentity = databaseIdentity(params.sqlitePath);
  const physicalIdentity = databaseIdentity(params.sqlitePath, "physical");
  const stale =
    Boolean(recorded.superseded) ||
    (recorded.databaseIdentity !== currentDatabaseIdentity &&
      recorded.databaseIdentity !== physicalIdentity);
  return { recorded, currentDatabaseIdentity, physicalIdentity, stale };
}

/** Preserve the foreign receipt before releasing its claim on the live database. */
export function supersedeDeferredPluginSessionImport(params: {
  receipt: LegacyMigrationReceipt;
  databaseIdentity: string;
  sqlitePath: string;
  physicalIdentity: string;
  env: NodeJS.ProcessEnv;
}): void {
  const { receipt } = params;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      if (
        !isDeepStrictEqual(
          readLegacyMigrationReceiptFromDatabase(db, receipt.sourceKey),
          receipt,
        ) ||
        databaseIdentity(params.sqlitePath) !== params.databaseIdentity ||
        databaseIdentity(params.sqlitePath, "physical") !== params.physicalIdentity
      ) {
        throw new Error(
          "Deferred session receipt or database changed before supersession; originals retained.",
        );
      }
      const now = Date.now();
      const recorded = JSON.parse(receipt.reportJson);
      recordLegacyMigrationRun(db, {
        runId: `${receipt.sourceKey}:superseded:${sha256Hex(receipt.reportJson + "\0" + params.databaseIdentity)}`,
        startedAt: now,
        finishedAt: now,
        status: "superseded",
        upsert: true,
        reportJson: JSON.stringify({
          receipt: recorded,
          databaseIdentity: params.databaseIdentity,
          reason:
            "Receipt bound to a different database; it cannot certify the live database's history.",
        }),
      });
      // Keep this row visible to 9.9: it ignores the marker but still checks the foreign binding.
      // A verified older recovery may replace the payload; it must not inherit a retirement flag.
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable("migration_sources")
          .set({
            status: "superseded",
            report_json: JSON.stringify({ ...recorded, superseded: "different-database" }),
          })
          .where("source_key", "=", receipt.sourceKey),
      );
    },
    { env: params.env },
    { operationLabel: "state.supersede-plugin-session-source" },
  );
}
