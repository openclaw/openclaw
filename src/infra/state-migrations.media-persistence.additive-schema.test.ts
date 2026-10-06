import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import { createLegacyDatabaseFixture } from "./state-migrations.media-persistence.test-support.js";

const tempDirs: string[] = [];

function createV17AdditiveFixture(
  options: { schemaDrift?: "missing-cache-table" | "missing-memory-trigger" } = {},
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
  } else if (options.schemaDrift === "missing-memory-trigger") {
    database.exec("DROP TRIGGER memory_index_sources_revision_after_update;");
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
    openOpenClawAgentDatabase({ agentId: "main", env });
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

  it.each(["missing-cache-table", "missing-memory-trigger"] as const)(
    "keeps non-additive v17 schema drift rejected during index repair: %s",
    async (schemaDrift) => {
      const { databasePath, env } = createV17AdditiveFixture({
        schemaDrift,
      });
      const { DatabaseSync } = requireNodeSqlite();
      const result = await migrateLegacyMediaPersistence({ env });
      expect(() => openOpenClawAgentDatabase({ agentId: "main", env })).toThrow(
        /uses schema version 17/,
      );
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(
        schemaDrift === "missing-cache-table"
          ? /missing table cache_entries/
          : /missing or drifted trigger memory_index_sources_revision_after_update/,
      );
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
