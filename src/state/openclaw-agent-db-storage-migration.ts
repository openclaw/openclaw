import type { DatabaseSync } from "node:sqlite";
import { migrateMemoryIndexStorage } from "../../packages/memory-host-sdk/src/host/memory-schema.js";
import { migrateSessionCostUsageRollupStorage } from "../infra/session-cost-usage-cache-migration.js";
import { TRANSCRIPT_FTS_ROW_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import * as maintenanceAuthority from "./openclaw-agent-db-lease.js";
import { migrateDeployedTranscriptFtsRowsInTransaction } from "./openclaw-agent-transcript-fts-schema.js";
import { migrateTranscriptPayloadStorageInTransaction } from "./openclaw-agent-transcript-payload-migration.js";

export function migrateAgentStorageInTransaction(
  db: DatabaseSync,
  schemaSql: string,
  previousVersion: number,
  warnings: string[],
): void {
  maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent();
  if (previousVersion === TRANSCRIPT_FTS_ROW_SCHEMA_VERSION) {
    migrateDeployedTranscriptFtsRowsInTransaction(db, schemaSql);
  } else if (
    db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get("session_transcript_fts_rows")
  ) {
    throw new Error(
      "Transcript FTS row map already exists before the schema-23 storage migration.",
    );
  }
  maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent();
  migrateTranscriptPayloadStorageInTransaction(db);
  maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent();
  migrateMemoryIndexStorage(db, {
    renewAuthority: maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent,
    onWarning: (warning) => warnings.push(warning),
  });
  maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent();
  migrateSessionCostUsageRollupStorage(
    db,
    maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent,
  );
  maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent();
  db.exec(schemaSql);
  // Keep native 64-bit rowids, duplicate message IDs and FTS tie ordering intact.
  if (previousVersion !== TRANSCRIPT_FTS_ROW_SCHEMA_VERSION) {
    db.exec(`
    INSERT INTO session_transcript_fts_rows (id, session_id, message_id)
    SELECT rowid, session_id, message_id FROM session_transcript_fts;
  `);
  }
}
