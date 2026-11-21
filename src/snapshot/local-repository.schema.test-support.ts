import type { DatabaseSync } from "node:sqlite";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { withDatabase } from "./local-repository.test-support.js";
export { createUnsafeIndexDrift } from "../state/sqlite-index-drift.test-support.js";

export const TRANSIENT_PLUGIN_BLOB_MARKER = `transient-plugin-blob-${"sensitive".repeat(32)}`;
export const DURABLE_PLUGIN_BLOB_MARKER = "durable-plugin-blob-control";
export const STATE_LEASE_MARKER = "snapshot-must-not-retain-active-lease";

function initializeDatabase(
  database: DatabaseSync,
  role: "global" | "agent",
  agentId: string | null = null,
) {
  const version = role === "global" ? OPENCLAW_STATE_SCHEMA_VERSION : OPENCLAW_AGENT_SCHEMA_VERSION;
  database.exec(`${role === "global" ? OPENCLAW_STATE_SCHEMA_SQL : OPENCLAW_AGENT_SCHEMA_SQL}
    PRAGMA user_version = ${version};`);
  database
    .prepare(`INSERT INTO schema_meta
    (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
    VALUES ('primary', ?, ?, ?, NULL, 1, 1)`)
    .run(role, version, agentId);
}

export function createGlobalDatabase(databasePath: string): void {
  withDatabase(databasePath, (database) => {
    initializeDatabase(database, "global");
    database.exec(`INSERT INTO delivery_queue_entries
      (queue_name, id, status, entry_json, enqueued_at, updated_at)
      VALUES ('delivery', 'queued', 'pending', '{"payload":"do-not-restore"}', 1, 1)`);
  });
}

export function seedGlobalPluginBlobSnapshotFixtures(databasePath: string): void {
  withDatabase(databasePath, (database) => {
    database
      .prepare(
        `INSERT INTO plugin_blob_entries
        (plugin_id, namespace, entry_key, metadata_json, blob, created_at, expires_at)
        VALUES ('diffs', 'viewer-artifacts', 'transient', ?, ?, 1, ?),
               ('durable-plugin', 'documents', 'durable', ?, ?, 1, NULL)`,
      )
      .run(
        JSON.stringify({ marker: TRANSIENT_PLUGIN_BLOB_MARKER }),
        Buffer.from(`<html>${TRANSIENT_PLUGIN_BLOB_MARKER}</html>`),
        Date.UTC(2099, 0, 1),
        JSON.stringify({ kind: "durable" }),
        Buffer.from(DURABLE_PLUGIN_BLOB_MARKER),
      );
  });
}

export function createAgentDatabase(databasePath: string, agentId: string): void {
  withDatabase(databasePath, (database) => initializeDatabase(database, "agent", agentId));
}

export function seedStateLease(databasePath: string): void {
  withDatabase(databasePath, (database) =>
    database.exec(`INSERT INTO state_leases
          (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
          VALUES ('${STATE_LEASE_MARKER}', 'write', 'worker', 9999999999999, 1, NULL, 1, 1)`),
  );
}

export function readGlobalRows(file: string) {
  return withDatabase(
    file,
    (database) => ({
      queue: database.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
      leases: database.prepare("SELECT COUNT(*) AS count FROM state_leases").get(),
      blobs: database
        .prepare(
          "SELECT plugin_id, entry_key FROM plugin_blob_entries ORDER BY plugin_id, entry_key",
        )
        .all(),
    }),
    { readOnly: true },
  );
}
