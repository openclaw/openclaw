// Per-agent database target for the generic copy-and-swap fallback.
import type { DatabaseSync } from "node:sqlite";
import { VERSION } from "../version.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-schema-versions.js";
import type { SqliteSwapTarget } from "./sqlite-copy-swap.js";

export function createAgentSwapTarget(agentId: string): SqliteSwapTarget {
  return {
    label: `agent:${agentId}`,
    version: OPENCLAW_AGENT_SCHEMA_VERSION,
    createSchema: (db) => db.exec(OPENCLAW_AGENT_SCHEMA_SQL),
    stamp: (db: DatabaseSync) => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
         VALUES ('primary', 'agent', ?, ?, ?, ?, ?)
         ON CONFLICT(meta_key) DO UPDATE SET role = 'agent', schema_version = excluded.schema_version,
           agent_id = excluded.agent_id, app_version = excluded.app_version, updated_at = excluded.updated_at`,
      ).run(OPENCLAW_AGENT_SCHEMA_VERSION, agentId, VERSION, now, now);
    },
    // Full-text indexes rebuild from their content tables.
    rebuild: (db) => {
      for (const table of ["standing_intents_fts", "session_transcript_fts"]) {
        try {
          db.exec(`INSERT INTO ${table}(${table}) VALUES ('rebuild')`);
        } catch {
          // Contentless or absent indexes are refilled by their owner on first use.
        }
      }
    },
    map: {},
  };
}
