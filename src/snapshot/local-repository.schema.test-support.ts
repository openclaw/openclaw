import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { withDatabase } from "./local-repository.test-support.js";

export const TRANSIENT_PLUGIN_BLOB_MARKER = `transient-plugin-blob-${"sensitive".repeat(32)}`;
export const DURABLE_PLUGIN_BLOB_MARKER = "durable-plugin-blob-control";
export const STATE_LEASE_MARKER = "snapshot-must-not-retain-active-lease";

export function createGlobalDatabase(databasePath: string): void {
  withDatabase(databasePath, (database) => {
    database.exec(`
      ${OPENCLAW_STATE_SCHEMA_SQL}
      PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
    `);
    database
      .prepare(
        `
          INSERT INTO schema_meta (
            meta_key,
            role,
            schema_version,
            agent_id,
            app_version,
            created_at,
            updated_at
          ) VALUES ('primary', 'global', ?, NULL, NULL, 1, 1)
        `,
      )
      .run(OPENCLAW_STATE_SCHEMA_VERSION);
    database
      .prepare(
        `
          INSERT INTO delivery_queue_entries (
            queue_name,
            id,
            status,
            entry_json,
            enqueued_at,
            updated_at
          ) VALUES ('delivery', 'queued', 'pending', ?, 1, 1)
        `,
      )
      .run('{"payload":"do-not-restore"}');
  });
}

export function seedGlobalPluginBlobSnapshotFixtures(databasePath: string): void {
  withDatabase(databasePath, (database) => {
    const insertPluginBlob = database.prepare(
      `
        INSERT INTO plugin_blob_entries (
          plugin_id, namespace, entry_key, metadata_json, blob, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    );
    insertPluginBlob.run(
      "diffs",
      "viewer-artifacts",
      "transient",
      JSON.stringify({ marker: TRANSIENT_PLUGIN_BLOB_MARKER }),
      Buffer.from(`<html>${TRANSIENT_PLUGIN_BLOB_MARKER}</html>`),
      1,
      Date.UTC(2099, 0, 1),
    );
    insertPluginBlob.run(
      "durable-plugin",
      "documents",
      "durable",
      JSON.stringify({ kind: "durable" }),
      Buffer.from(DURABLE_PLUGIN_BLOB_MARKER),
      1,
      null,
    );
  });
}

export function createAgentDatabase(databasePath: string, agentId: string): void {
  withDatabase(databasePath, (database) => {
    database.exec(`
      ${OPENCLAW_AGENT_SCHEMA_SQL}
      PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
    `);
    database
      .prepare(
        `
          INSERT INTO schema_meta (
            meta_key,
            role,
            schema_version,
            agent_id,
            app_version,
            created_at,
            updated_at
          ) VALUES ('primary', 'agent', ?, ?, NULL, 1, 1)
        `,
      )
      .run(OPENCLAW_AGENT_SCHEMA_VERSION, agentId);
  });
}

export function seedStateLease(databasePath: string): void {
  withDatabase(databasePath, (database) => {
    database
      .prepare(
        `
          INSERT INTO state_leases (
            scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at
          ) VALUES (?, 'write', 'worker', 9999999999999, 1, NULL, 1, 1)
        `,
      )
      .run(STATE_LEASE_MARKER);
  });
}

export function disableDefensiveModeForSchemaCorruption(database: object): void {
  (
    database as {
      enableDefensive?: (active: boolean) => void;
    }
  ).enableDefensive?.(false);
}

export function createUnsafeIndexDrift(databasePath: string): void {
  withDatabase(databasePath, (database) => {
    disableDefensiveModeForSchemaCorruption(database);
    database.exec(`
      CREATE TABLE records (
        id INTEGER PRIMARY KEY,
        indexed_value TEXT NOT NULL,
        alternate_value TEXT NOT NULL
      );
      CREATE INDEX records_value ON records(indexed_value);
      INSERT INTO records (indexed_value, alternate_value)
      VALUES ('alpha', 'zeta'), ('beta', 'eta'), ('gamma', 'theta');
      PRAGMA writable_schema = ON;
    `);
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX records_value ON records(alternate_value)' WHERE name = 'records_value'",
      )
      .run();
    const schemaVersion = Number(
      Object.values(database.prepare("PRAGMA schema_version").get() as Record<string, unknown>)[0],
    );
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  });
}
