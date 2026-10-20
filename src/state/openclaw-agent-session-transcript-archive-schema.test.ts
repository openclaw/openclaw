import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import {
  ensureSessionTranscriptArchiveSchema,
  SESSION_TRANSCRIPT_ARCHIVES_TABLE,
} from "./openclaw-agent-session-transcript-archive-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function withMissingArchiveTable(sql = "") {
  const options = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-session-archive-schema-") },
  };
  const { path: pathname } = openOpenClawAgentDatabase(options);
  closeOpenClawAgentDatabasesForTest();
  using database = new DatabaseSync(pathname);
  database.exec(`
    DROP INDEX idx_agent_session_transcript_archives_pending;
    DROP INDEX idx_agent_session_transcript_archives_retention;
    DROP TABLE ${SESSION_TRANSCRIPT_ARCHIVES_TABLE};
    ${sql}
  `);
  return { options, before: metadata(database) };
}

function metadata(database: DatabaseSync) {
  return {
    version: database.prepare("PRAGMA user_version").get(),
    schema: database
      .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
      .get(),
  };
}

function openArchiveDatabase(filename = ":memory:", admitted = true) {
  const database = admitted ? openNodeSqliteDatabase(filename) : new DatabaseSync(filename);
  if (admitted) {
    admitSqliteSchema(database);
  }
  return database;
}

afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("session transcript archive schema", () => {
  it("keeps a current database table-free until first archive use without changing its version", () => {
    const { options, before } = withMissingArchiveTable();
    const reopened = openOpenClawAgentDatabase(options).db;
    const archive = () =>
      reopened
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get(SESSION_TRANSCRIPT_ARCHIVES_TABLE);
    expect(archive()).toBeUndefined();
    ensureSessionTranscriptArchiveSchema(reopened);
    expect(archive()).toEqual({ 1: 1 });
    expect(metadata(reopened)).toEqual(before);
  });

  it("rejects a drifted archive table instead of treating it as an optional absence", () => {
    const { options } = withMissingArchiveTable(`
      CREATE TABLE ${SESSION_TRANSCRIPT_ARCHIVES_TABLE} (
        session_id TEXT NOT NULL PRIMARY KEY,
        archive_blob BLOB NOT NULL
      ) STRICT;
    `);

    expect(() => openOpenClawAgentDatabase(options)).toThrow(/session_transcript_archives|schema/u);
  });

  it.each([false, true])(
    "reinstalls rolled-back first use and reopened storage with admitted=%s",
    (admitted) => {
      using database = openArchiveDatabase(":memory:", admitted);
      expect(() =>
        runSqliteImmediateTransactionSync(database, () => {
          ensureSessionTranscriptArchiveSchema(database);
          database.prepare("SELECT session_id FROM session_transcript_archives").all();
          throw new Error("rollback archive installation");
        }),
      ).toThrow("rollback archive installation");
      expect(() => database.prepare("SELECT session_id FROM session_transcript_archives")).toThrow(
        /no such table/u,
      );
      ensureSessionTranscriptArchiveSchema(database);
      expect(database.prepare("SELECT session_id FROM session_transcript_archives").all()).toEqual(
        [],
      );
      database.close();
      database.open();
      ensureSessionTranscriptArchiveSchema(database);
      expect(database.prepare("SELECT session_id FROM session_transcript_archives").all()).toEqual(
        [],
      );
    },
  );

  it("repairs a missing index on first admission and local companion-table removal on the next use", () => {
    const filename = path.join(tempDirs.make("archive-schema-refresh-"), "agent.sqlite");
    using peer = openArchiveDatabase(filename, false);
    ensureSessionTranscriptArchiveSchema(peer);
    peer.exec("DROP INDEX idx_agent_session_transcript_archives_pending");
    peer.close();
    using database = openArchiveDatabase(filename);
    ensureSessionTranscriptArchiveSchema(database);
    expect(
      database
        .prepare(
          "SELECT name FROM main.sqlite_schema WHERE type = 'index' AND name = 'idx_agent_session_transcript_archives_pending'",
        )
        .get(),
    ).toEqual({ name: "idx_agent_session_transcript_archives_pending" });
    database.exec("DROP TABLE session_transcript_cold_archives");
    ensureSessionTranscriptArchiveSchema(database);
    expect(
      database.prepare("SELECT session_id FROM session_transcript_cold_archives").all(),
    ).toEqual([]);
  });

  it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
    "does not reuse schema presence across dynamic authorizer decisions",
    () => {
      using database = openArchiveDatabase();
      ensureSessionTranscriptArchiveSchema(database);
      let allowed = true;
      database.setAuthorizer(() => (allowed ? constants.SQLITE_OK : constants.SQLITE_DENY));
      try {
        ensureSessionTranscriptArchiveSchema(database);
        allowed = false;
        expect(() => ensureSessionTranscriptArchiveSchema(database)).toThrow(/not authorized/iu);
      } finally {
        database.setAuthorizer(null);
      }
    },
  );
});
