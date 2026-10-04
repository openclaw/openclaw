import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import { createLegacyDatabaseFixture } from "./state-migrations.media-persistence.test-support.js";

const tempDirs: string[] = [];

function createV17AdditiveFixture(
  options: { schemaDrift?: "missing-cache-table"; legacyRecallMetadata?: boolean } = {},
) {
  const stateDir = makeTempDir(tempDirs, "media-persistence-v17-additive-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const databasePath = createLegacyDatabaseFixture({ env, eventsBySession: {}, schemaVersion: 17 });
  closeOpenClawStateDatabaseForTest();

  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  database.exec(`
    DROP TRIGGER session_conversations_route_context_invalidate_after_update;
    ALTER TABLE session_conversations DROP COLUMN route_context_json;
    DROP INDEX idx_agent_transcript_event_identity_sequence;
  `);
  if (options.schemaDrift === "missing-cache-table") {
    database.exec("DROP TABLE cache_entries;");
  }
  if (options.legacyRecallMetadata) {
    database.exec(`
      DROP TABLE memory_index_chunk_recall_metadata;
      ALTER TABLE memory_index_chunks ADD COLUMN importance INTEGER
        CHECK (importance IS NULL OR importance BETWEEN 1 AND 10);
      INSERT INTO memory_index_chunks (
        id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, importance
      ) VALUES ('legacy', 'MEMORY.md', 'memory', 1, 2, 'hash', 'model', 'retained memory', '[1,0]', 1, 7);
    `);
  }
  database.close();
  return { databasePath, env };
}

describe("legacy media persistence additive schema repair", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanupTempDirs(tempDirs);
  });

  it("repairs v17 additive session schema before canonical index validation", async () => {
    const { databasePath, env } = createV17AdditiveFixture();
    const { DatabaseSync } = requireNodeSqlite();
    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toEqual([]);
    const repaired = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(repaired.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(
        repaired
          .prepare(
            "SELECT name FROM pragma_table_info('session_conversations') WHERE name = 'route_context_json'",
          )
          .get(),
      ).toEqual({ name: "route_context_json" });
      expect(
        repaired
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'session_conversations_route_context_invalidate_after_update'",
          )
          .get(),
      ).toEqual({ name: "session_conversations_route_context_invalidate_after_update" });
      expect(
        repaired
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_transcript_event_identity_sequence'",
          )
          .get(),
      ).toEqual({ name: "idx_agent_transcript_event_identity_sequence" });
    } finally {
      repaired.close();
    }
  });

  it.each([false, true])(
    "keeps non-additive v17 schema drift rejected during index repair (legacy recall metadata: %s)",
    async (legacyRecallMetadata) => {
      const { databasePath, env } = createV17AdditiveFixture({
        schemaDrift: "missing-cache-table",
        legacyRecallMetadata,
      });
      const { DatabaseSync } = requireNodeSqlite();
      const result = await migrateLegacyMediaPersistence({ env });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/missing table cache_entries/);
      const rejected = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(rejected.prepare("PRAGMA user_version").get()).toEqual({ user_version: 17 });
        expect(
          rejected
            .prepare(
              "SELECT name FROM pragma_table_info('session_conversations') WHERE name = 'route_context_json'",
            )
            .get(),
        ).toBeUndefined();
        if (legacyRecallMetadata) {
          expect(
            rejected
              .prepare(
                "SELECT text, embedding, importance FROM memory_index_chunks WHERE id = 'legacy'",
              )
              .get(),
          ).toEqual({ text: "retained memory", embedding: "[1,0]", importance: 7 });
          expect(
            rejected
              .prepare(
                "SELECT name FROM sqlite_schema WHERE name = 'memory_index_chunk_recall_metadata'",
              )
              .get(),
          ).toBeUndefined();
        }
        expect(
          rejected
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_transcript_event_identity_sequence'",
            )
            .get(),
        ).toBeUndefined();
      } finally {
        rejected.close();
      }
    },
  );
});
