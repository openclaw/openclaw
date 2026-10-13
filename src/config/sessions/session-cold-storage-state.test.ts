import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import {
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
} from "../../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import { readHotSessionTranscriptSnapshot } from "./session-cold-storage-read.js";
import {
  assertSessionTranscriptHot,
  SessionTranscriptColdError,
} from "./session-cold-storage-state.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0).toReversed()) {
    db.close();
  }
});

function fixture() {
  const filename = path.join(tempDirs.make("cold-transcript-facts-"), "agent.sqlite");
  const db = openNodeSqliteDatabase(filename);
  databases.push(db);
  db.exec(`PRAGMA journal_mode = WAL;
    ${OPENCLAW_AGENT_SCHEMA_SQL}
    INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
    VALUES ('agent:main:cold-facts', 'cold-facts', '{}', 1);
    INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
    VALUES ('cold-facts', 'agent:main:cold-facts', 1, 1);`);
  admitSqliteSchema(db);
  const peer = openNodeSqliteDatabase(filename);
  databases.push(peer);
  admitSqliteSchema(peer);
  const read = () =>
    readHotSessionTranscriptSnapshot({ db }, "cold-facts", "raw rows", () =>
      db.prepare("SELECT updated_at FROM session_windows WHERE session_id = 'cold-facts'").get(),
    );
  const archive = (writer = peer) =>
    withSqliteDatabaseWriteScope(writer, [sqliteSessionIdWriteScope("cold-facts")], () =>
      writer
        .prepare(`INSERT INTO session_transcript_cold_archives
        (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes,
         archive_bytes, last_seq, archived_at, storage, archive_blob)
        VALUES ('cold-facts', 'generation', 'archive.zst', ?, 1, 1, 1, 0, 1, 'file', NULL)`)
        .run("0".repeat(64)),
    );
  return { db, peer, read, archive };
}

it("reuses hot facts only within a snapshot and invalidates them after writes and rollback", () => {
  const { db, peer, read, archive } = fixture();
  const observed = trackSqliteStatementExecutions(db, ["cold"], (sql) =>
    /^select\b.*\bfrom "session_transcript_cold_archives"/iu.test(sql) ? "cold" : null,
  );
  try {
    runSqliteDeferredTransactionSync(db, () => {
      expect(read()).toEqual({ updated_at: 1 });
      expect(read()).toEqual({ updated_at: 1 });
      expect(observed.counts.cold).toBe(1);
    });
    expect(read()).toEqual({ updated_at: 1 });
    expect(observed.counts.cold).toBe(2);

    expect(() =>
      runSqliteImmediateTransactionSync(db, () => {
        archive(db);
        expect(() => assertSessionTranscriptHot(db, "cold-facts")).toThrow(
          SessionTranscriptColdError,
        );
        throw new Error("rollback archive");
      }),
    ).toThrow("rollback archive");
    expect(read()).toEqual({ updated_at: 1 });

    runSqliteImmediateTransactionSync(peer, () => archive());
    expect(read).toThrow(SessionTranscriptColdError);
    runSqliteImmediateTransactionSync(peer, () => {
      peer.exec("DELETE FROM session_transcript_cold_archives WHERE session_id = 'cold-facts'");
    });
    expect(read()).toEqual({ updated_at: 1 });
  } finally {
    observed.restore();
  }
});

it("keeps an already-open read snapshot local when another owner archives its transcript", () => {
  const { db, peer, read, archive } = fixture();
  expect(read()).toEqual({ updated_at: 1 });
  runSqliteDeferredTransactionSync(db, () => {
    db.prepare("SELECT updated_at FROM session_windows").all();
    runSqliteImmediateTransactionSync(peer, () => archive());
    expect(read()).toEqual({ updated_at: 1 });
  });
  expect(read).toThrow(SessionTranscriptColdError);
});

it("invalidates a retained cold fact when the owning session window is deleted", () => {
  const { db, peer, archive } = fixture();
  runSqliteImmediateTransactionSync(peer, () => archive());
  expect(() => assertSessionTranscriptHot(db, "cold-facts")).toThrow(SessionTranscriptColdError);
  peer.exec("PRAGMA foreign_keys = ON");
  runSqliteImmediateTransactionSync(peer, () => {
    withSqliteDatabaseWriteScope(peer, [sqliteSessionIdWriteScope("cold-facts")], () => {
      peer.exec("DELETE FROM session_windows WHERE session_id = 'cold-facts'");
    });
  });
  expect(() => assertSessionTranscriptHot(db, "cold-facts")).not.toThrow();
});
