import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import {
  ensureSessionTranscriptArchiveSchema,
  SESSION_TRANSCRIPT_ARCHIVES_TABLE,
} from "./openclaw-agent-session-transcript-archive-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("session transcript archive schema", () => {
  it("keeps a current database table-free until first archive use without changing its version", () => {
    const stateDir = tempDirs.make("openclaw-session-archive-schema-");
    const options = { agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } };
    const initial = openOpenClawAgentDatabase(options);
    const databasePath = initial.path;
    closeOpenClawAgentDatabasesForTest();

    const shipped = new DatabaseSync(databasePath);
    shipped.exec(`
      DROP INDEX idx_agent_session_transcript_archives_pending;
      DROP INDEX idx_agent_session_transcript_archives_retention;
      DROP TABLE ${SESSION_TRANSCRIPT_ARCHIVES_TABLE};
    `);
    const versionBefore = shipped.prepare("PRAGMA user_version").get();
    const metadataBefore = shipped
      .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
      .get();
    shipped.close();

    const reopened = openOpenClawAgentDatabase(options);
    expect(
      reopened.db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get(SESSION_TRANSCRIPT_ARCHIVES_TABLE),
    ).toBeUndefined();

    ensureSessionTranscriptArchiveSchema(reopened.db);

    expect(
      reopened.db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get(SESSION_TRANSCRIPT_ARCHIVES_TABLE),
    ).toEqual({ 1: 1 });
    expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual(versionBefore);
    expect(
      reopened.db
        .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual(metadataBefore);
  });

  it("rejects a drifted archive table instead of treating it as an optional absence", () => {
    const stateDir = tempDirs.make("openclaw-session-archive-drift-");
    const options = { agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } };
    const initial = openOpenClawAgentDatabase(options);
    const databasePath = initial.path;
    closeOpenClawAgentDatabasesForTest();

    const drifted = new DatabaseSync(databasePath);
    drifted.exec(`
      DROP INDEX idx_agent_session_transcript_archives_pending;
      DROP INDEX idx_agent_session_transcript_archives_retention;
      DROP TABLE ${SESSION_TRANSCRIPT_ARCHIVES_TABLE};
      CREATE TABLE ${SESSION_TRANSCRIPT_ARCHIVES_TABLE} (
        session_id TEXT NOT NULL PRIMARY KEY,
        archive_blob BLOB NOT NULL
      ) STRICT;
    `);
    drifted.close();

    expect(() => openOpenClawAgentDatabase(options)).toThrow(/session_transcript_archives|schema/u);
  });
});
