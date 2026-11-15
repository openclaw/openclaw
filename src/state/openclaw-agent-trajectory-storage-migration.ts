import type { DatabaseSync } from "node:sqlite";

/** Historical readers retain the exact text-only table and retention index. */
export function withoutTrajectoryPayloadColumns(schema: string): string {
  return schema
    .replace("  event_utf8_bytes INTEGER,\n  event_payload BLOB,\n  event_codec TEXT,\n", "")
    .replace("COALESCE(event_utf8_bytes, octet_length(event_json))", "octet_length(event_json)");
}

export function withLegacyAgentPostgresTrajectoryStorage(schema: string): string {
  return schema
    .replace(
      '  "event_utf8_bytes" bigint,\n  "event_payload" bytea,\n  "event_codec" text COLLATE "C",\n',
      "",
    )
    .replaceAll(
      'coalesce("event_utf8_bytes", octet_length("event_json"))',
      'octet_length("event_json")',
    );
}

export const AGENT_TRAJECTORY_STORAGE_POSTGRES_MIGRATION_SQL = `
  ALTER TABLE "trajectory_runtime_events" ADD COLUMN "event_utf8_bytes" bigint;
  ALTER TABLE "trajectory_runtime_events" ADD COLUMN "event_payload" bytea;
  ALTER TABLE "trajectory_runtime_events" ADD COLUMN "event_codec" text COLLATE "C";
  DROP INDEX "idx_agent_trajectory_runtime_run";
  CREATE INDEX "idx_agent_trajectory_runtime_run"
    ON "trajectory_runtime_events" (("session_id") ASC NULLS FIRST,
      ("run_id") ASC NULLS FIRST, ("created_at") ASC NULLS FIRST,
      (COALESCE("event_utf8_bytes", octet_length("event_json"))) ASC NULLS FIRST);
`;

/** Leave old payloads untouched; retained rows age out under the existing logical-byte budget. */
export function migrateAgentTrajectoryStorageInTransaction(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE trajectory_runtime_events ADD COLUMN event_utf8_bytes INTEGER;
    ALTER TABLE trajectory_runtime_events ADD COLUMN event_payload BLOB;
    ALTER TABLE trajectory_runtime_events ADD COLUMN event_codec TEXT;
    DROP INDEX idx_agent_trajectory_runtime_run;
    CREATE INDEX idx_agent_trajectory_runtime_run
      ON trajectory_runtime_events(session_id, run_id, created_at,
        COALESCE(event_utf8_bytes, octet_length(event_json)));
  `);
}
