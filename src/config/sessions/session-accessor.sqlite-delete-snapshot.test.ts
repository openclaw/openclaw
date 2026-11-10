import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { enableNodeSqliteKyselyStatementCache } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { readSessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("reads complete lifecycle fences in one statement and observes foreign commits after snapshots", () => {
  const filename = path.join(tempDirs.make("openclaw-delete-snapshot-"), "agent.sqlite");
  const database = new DatabaseSync(filename);
  const peer = new DatabaseSync(filename);
  try {
    // Orphan children are intentional: deletion must still compare them without an owner window.
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE session_windows (
        session_id TEXT PRIMARY KEY, session_key TEXT, transcript_updated_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE transcript_rewrite_watermarks (session_id TEXT PRIMARY KEY, generation TEXT);
      CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, PRIMARY KEY (session_id, seq));
      CREATE TABLE trajectory_runtime_events (session_id TEXT, seq INTEGER, PRIMARY KEY (session_id, seq));
      CREATE TABLE acp_parent_stream_events (session_id TEXT, seq INTEGER, PRIMARY KEY (session_id, seq));
      INSERT INTO session_windows VALUES ('first', 'agent:main:first', 10, 20);
      INSERT INTO transcript_rewrite_watermarks VALUES ('first', 'generation-one');
      INSERT INTO transcript_events VALUES ('first', 2), ('first', 8), ('other', 999);
      INSERT INTO trajectory_runtime_events VALUES ('first', 3), ('first', 7), ('other', 999);
      INSERT INTO acp_parent_stream_events VALUES ('first', 1), ('first', 2), ('other', 999);
    `);
    enableNodeSqliteKyselyStatementCache(database);
    const queries = trackSqliteStatementExecutions(database, ["snapshot"], () => "snapshot");
    const read = (sessionId: string) => {
      const before = queries.counts.snapshot;
      const snapshot = readSessionStateDeleteSnapshot(database, sessionId);
      expect(queries.counts.snapshot - before).toBe(1);
      return [
        snapshot.acpParentStreamEventCount,
        snapshot.generation,
        snapshot.lastSeq,
        snapshot.sessionKey,
        snapshot.sessionUpdatedAt,
        snapshot.trajectoryLastSeq,
        snapshot.transcriptUpdatedAt,
      ];
    };
    try {
      const original = [2, "generation-one", 8, "agent:main:first", 20, 7, 10];
      expect(read("first")).toEqual(original);
      runSqliteDeferredTransactionSync(database, () => {
        expect(read("first")).toEqual(original);
        peer.exec(`
          BEGIN IMMEDIATE;
          UPDATE session_windows SET session_key = 'agent:main:renamed', transcript_updated_at = 30, updated_at = 40 WHERE session_id = 'first';
          UPDATE transcript_rewrite_watermarks SET generation = 'generation-two' WHERE session_id = 'first';
          INSERT INTO transcript_events VALUES ('first', 12);
          INSERT INTO trajectory_runtime_events VALUES ('first', 13);
          INSERT INTO acp_parent_stream_events VALUES ('first', 3);
          COMMIT;
        `);
        expect(read("first")).toEqual(original);
      });
      const updated = [3, "generation-two", 12, "agent:main:renamed", 40, 13, 30];
      expect(read("first")).toEqual(updated);
      peer.exec("DELETE FROM session_windows WHERE session_id = 'first'");
      expect(read("first")).toEqual([3, "generation-two", 12, null, null, 13, null]);
      expect(read("missing")).toEqual([0, null, null, null, null, null, null]);
      expect(read("other")).toEqual([1, null, 999, null, null, 999, null]);
    } finally {
      queries.restore();
    }
  } finally {
    peer.close();
    database.close();
  }
});
