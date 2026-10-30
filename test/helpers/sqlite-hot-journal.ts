import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { assertReliabilityForcedExit } from "../../scripts/lib/sqlite-reliability-process.js";

/** Spill an actual uncommitted transaction, then join its killed writer without polling. */
export function createHotSqliteRollbackJournal(params: {
  path: string;
  mutationSql: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const crashed = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--input-type=module",
      "--eval",
      `
        import { DatabaseSync } from "node:sqlite";
        const database = new DatabaseSync(process.argv[1]);
        database.exec(
          "PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; " +
          "PRAGMA cache_size = 2; PRAGMA cache_spill = ON; BEGIN IMMEDIATE; " +
          process.argv[2] + "; " +
          "CREATE TABLE openclaw_hot_journal_pressure (id INTEGER PRIMARY KEY, payload BLOB NOT NULL) STRICT; " +
          "WITH RECURSIVE rows(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM rows WHERE id < 256) " +
          "INSERT INTO openclaw_hot_journal_pressure SELECT id, zeroblob(8192) FROM rows;"
        );
        process.kill(process.pid, "SIGKILL");
      `,
      params.path,
      params.mutationSql,
    ],
    { env: params.env ?? {}, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
  );
  assert.equal(crashed.error, undefined, crashed.stderr);
  assertReliabilityForcedExit(
    { code: crashed.status, signal: crashed.signal },
    "SQLite hot-journal fixture",
  );
  const journal = fs.readFileSync(`${params.path}-journal`);
  assert.ok(journal.length > 512, "Killed transaction did not leave a rollback journal");
  assert.deepEqual(
    journal.subarray(0, 8),
    Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]),
    "Killed transaction did not publish a native hot-journal header",
  );
}
