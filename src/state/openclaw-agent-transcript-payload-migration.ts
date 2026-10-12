import type { DatabaseSync } from "node:sqlite";
import {
  MAX_COMPRESSED_EVENT_BYTES,
  prepareTranscriptPayload,
} from "../config/sessions/transcript-payload.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { extractSqliteTableSchema, quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import { resolveZstdCodec } from "../infra/zstd-codec.js";
import { renewAgentDatabaseMaintenanceAuthorityIfPresent } from "./openclaw-agent-db-lease.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { withLegacyAgentStorageSchema } from "./openclaw-agent-storage-schema.js";

const MIGRATION_TABLE = "transcript_events_payload_migration";
const KNOWN_CHILDREN = new Set(["transcript_event_identities", "session_transcript_active_events"]);

function assertTranscriptRebuildInputs(database: DatabaseSync): void {
  assertSqliteSchemaContains(
    database,
    "transcript payload migration",
    extractSqliteTableSchema(
      withLegacyAgentStorageSchema(OPENCLAW_AGENT_SCHEMA_SQL),
      "transcript_events",
    ),
  );
  const columns = database.prepare("PRAGMA table_xinfo(transcript_events)").all();
  const expectedColumns = new Set(["session_id", "seq", "event_json", "created_at"]);
  if (
    columns.length !== expectedColumns.size ||
    columns.some((column) => typeof column.name !== "string" || !expectedColumns.has(column.name))
  ) {
    throw new Error("Transcript payload migration cannot discard unknown columns");
  }
  const dependents = database
    .prepare(`SELECT name FROM sqlite_schema
      WHERE (type IN ('trigger', 'index') AND tbl_name = 'transcript_events' AND sql IS NOT NULL)
         OR (type IN ('view', 'trigger') AND sql LIKE '%transcript_events%')`)
    .all();
  if (dependents.length > 0) {
    throw new Error(
      "Transcript payload migration cannot rebuild unknown indexes, views, or triggers",
    );
  }
  if (database.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(MIGRATION_TABLE)) {
    throw new Error("Transcript payload migration table already exists");
  }
  for (const table of database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
    .all()) {
    if (typeof table.name !== "string") {
      throw new Error("Invalid table name during transcript payload migration");
    }
    if (KNOWN_CHILDREN.has(table.name)) {
      continue;
    }
    const foreignKeys = database
      .prepare(`PRAGMA foreign_key_list(${quoteSqliteIdentifier(table.name)})`)
      .all();
    if (foreignKeys.some((key) => key.table === "transcript_events")) {
      throw new Error("Transcript payload migration cannot rebuild an unknown foreign-key target");
    }
  }
}

/** Convert original bytes under the admitted agent migration; never hydrate oversized identity rows. */
export function migrateTranscriptPayloadStorageInTransaction(database: DatabaseSync): void {
  if (
    !database.isTransaction ||
    database.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 0
  ) {
    throw new Error(
      "Transcript payload migration requires an admitted transaction with foreign keys off",
    );
  }
  assertTranscriptRebuildInputs(database);
  const utf8 = database.prepare("PRAGMA encoding").get()?.encoding === "UTF-8";
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const codec = resolveZstdCodec();
  database.exec(
    extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, "transcript_events").replace(
      "IF NOT EXISTS transcript_events",
      MIGRATION_TABLE,
    ),
  );
  const copyIdentity = database.prepare(`
    INSERT INTO ${MIGRATION_TABLE}
      (rowid, session_id, seq, event_json, created_at, event_zstd, event_utf8_bytes, navigation_json)
    SELECT rowid, session_id, seq, event_json, created_at, NULL,
           CASE WHEN ? THEN octet_length(event_json) ELSE NULL END, ?
    FROM transcript_events WHERE rowid = ?`);
  const copyCompressed = database.prepare(`
    INSERT INTO ${MIGRATION_TABLE}
      (rowid, session_id, seq, event_json, created_at, event_zstd, event_utf8_bytes, navigation_json)
    SELECT rowid, session_id, seq, NULL, created_at, ?, ?, ?
    FROM transcript_events WHERE rowid = ?`);
  copyIdentity.setReadBigInts(true);
  copyCompressed.setReadBigInts(true);
  const readBytes = database.prepare(
    "SELECT CAST(event_json AS BLOB) AS bytes FROM transcript_events WHERE rowid = ?",
  );
  const metadata = database.prepare(
    "SELECT rowid AS storage_rowid, octet_length(event_json) AS bytes FROM transcript_events ORDER BY rowid",
  );
  metadata.setReadBigInts(true);
  let renewedAt = performance.now();
  for (const row of metadata.iterate()) {
    if (performance.now() - renewedAt >= 1_000) {
      renewAgentDatabaseMaintenanceAuthorityIfPresent();
      renewedAt = performance.now();
    }
    if (typeof row.storage_rowid !== "bigint" || typeof row.bytes !== "bigint") {
      throw new Error("Invalid transcript storage identity during migration");
    }
    let navigation: string | null = null;
    let copied = false;
    if (utf8 && row.bytes <= BigInt(MAX_COMPRESSED_EVENT_BYTES)) {
      const bytes = readBytes.get(row.storage_rowid)?.bytes;
      if (!(bytes instanceof Uint8Array)) {
        throw new Error("Transcript payload disappeared during migration");
      }
      let text: string | undefined;
      try {
        text = decoder.decode(bytes);
      } catch {
        // Invalid historical UTF-8 remains native TEXT, preserving its exact stored bytes.
      }
      if (text !== undefined) {
        const payload = prepareTranscriptPayload(database, text);
        navigation = payload.navigation_json;
        if (payload.event_zstd !== null) {
          if (
            !codec ||
            payload.event_utf8_bytes === null ||
            !codec.decompress(payload.event_zstd, payload.event_utf8_bytes).equals(bytes)
          ) {
            throw new Error("Transcript compression did not preserve canonical bytes");
          }
          const result = copyCompressed.run(
            payload.event_zstd,
            payload.event_utf8_bytes,
            navigation,
            row.storage_rowid,
          );
          if (Number(result.changes) !== 1) {
            throw new Error("Transcript payload disappeared before migration publication");
          }
          copied = true;
        }
      }
    }
    if (
      !copied &&
      Number(copyIdentity.run(utf8 ? 1 : 0, navigation, row.storage_rowid).changes) !== 1
    ) {
      throw new Error("Transcript identity payload disappeared before migration publication");
    }
  }
  renewAgentDatabaseMaintenanceAuthorityIfPresent();
  database.exec(`DROP TABLE transcript_events;
    ALTER TABLE ${MIGRATION_TABLE} RENAME TO transcript_events;`);
}
