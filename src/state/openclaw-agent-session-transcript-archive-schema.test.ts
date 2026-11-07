import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import {
  closeOpenClawAgentDatabasesForTest as closeDatabases,
  openOpenClawAgentDatabase as openDatabase,
} from "./openclaw-agent-db.js";
import {
  ensureSessionTranscriptArchiveSchema as ensureArchives,
  SESSION_TRANSCRIPT_ARCHIVES_TABLE,
} from "./openclaw-agent-session-transcript-archive-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const schemaEntry = (database: Parameters<typeof ensureArchives>[0], type: string, name: string) =>
  database
    .prepare("SELECT name FROM main.sqlite_schema WHERE type = ? AND name = ?")
    .get(type, name);

function withMissingArchiveTable(sql = "") {
  const options = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-session-archive-schema-") },
  };
  const { path: pathname } = openDatabase(options);
  closeDatabases();
  using database = new DatabaseSync(pathname);
  database.exec(`
    DROP INDEX idx_agent_session_transcript_archives_pending;
    DROP INDEX idx_agent_session_transcript_archives_retention;
    DROP TABLE ${SESSION_TRANSCRIPT_ARCHIVES_TABLE};
    ${sql}
  `);
  return { options, before: metadata(database) };
}

function metadata(database: Parameters<typeof ensureArchives>[0]) {
  return {
    version: database.prepare("PRAGMA user_version").get(),
    schema: database
      .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
      .get(),
  };
}

afterEach(() => closeDatabases());

it("keeps a current database table-free until first archive use without changing its version", () => {
  const { options, before } = withMissingArchiveTable();
  const reopened = openDatabase(options).db;
  const archive = () => schemaEntry(reopened, "table", SESSION_TRANSCRIPT_ARCHIVES_TABLE);
  expect(archive()).toBeUndefined();
  ensureArchives(reopened);
  expect(archive()).toEqual({ name: SESSION_TRANSCRIPT_ARCHIVES_TABLE });
  expect(metadata(reopened)).toEqual(before);
});

it("rejects a drifted archive table instead of treating it as an optional absence", () => {
  const { options } = withMissingArchiveTable(`
    CREATE TABLE ${SESSION_TRANSCRIPT_ARCHIVES_TABLE} (
      session_id TEXT NOT NULL PRIMARY KEY,
      archive_blob BLOB NOT NULL
    ) STRICT;
  `);

  expect(() => openDatabase(options)).toThrow(/session_transcript_archives|schema/u);
});

it("repairs a missing index on first admission and local companion-table removal on the next use", () => {
  const filename = path.join(tempDirs.make("archive-schema-refresh-"), "agent.sqlite");
  using peer = new DatabaseSync(filename);
  ensureArchives(peer);
  peer.exec("DROP INDEX idx_agent_session_transcript_archives_pending");
  peer.close();
  using database = openNodeSqliteDatabase(filename);
  admitSqliteSchema(database);
  ensureArchives(database);
  const index = "idx_agent_session_transcript_archives_pending";
  expect(schemaEntry(database, "index", index)).toEqual({ name: index });
  database.exec("DROP TABLE session_transcript_cold_archives");
  ensureArchives(database);
  expect(database.prepare("SELECT session_id FROM session_transcript_cold_archives").all()).toEqual(
    [],
  );
});
