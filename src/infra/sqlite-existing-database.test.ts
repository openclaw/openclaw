import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createExistingSqliteRollbackReader,
  withExistingSqliteRollbackDatabase,
} from "./sqlite-existing-database.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function commitIndependently(file: string, value: number) {
  const writer = new DatabaseSync(file);
  try {
    writer.exec("PRAGMA busy_timeout = 0");
    writer.exec(`BEGIN IMMEDIATE; INSERT INTO t VALUES (${value}); COMMIT;`);
  } finally {
    writer.close();
  }
}

it("releases a retained reader's snapshot lock while its connection stays open", () => {
  const file = path.join(dirs.make("existing-sqlite-"), "store.sqlite");
  const seed = new DatabaseSync(file);
  seed.exec("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1);");
  seed.close();
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  const options = { busyTimeoutMs: 37, assertIdentity() {} };
  using reader = createExistingSqliteRollbackReader(file, options);

  // An observation that reads no table rows still took its snapshot in EXCLUSIVE mode.
  // The retained connection stays open; a writer must not wait on that ended snapshot.
  reader((db) => {
    expect(prepare.mock.calls.filter(([sql]) => /PRAGMA busy_timeout/iu.test(sql))).toEqual([]);
    expect(exec.mock.calls.filter(([sql]) => /PRAGMA busy_timeout/iu.test(sql))).toEqual([]);
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 37 });
  });
  commitIndependently(file, 2);
  expect(reader((db) => db.prepare("SELECT count(*) AS n FROM t").get())).toEqual({ n: 2 });
  commitIndependently(file, 3);

  prepare.mockClear();
  exec.mockClear();
  withExistingSqliteRollbackDatabase(file, { ...options, write: true }, (db, transact) => {
    expect(prepare.mock.calls.filter(([sql]) => /PRAGMA busy_timeout/iu.test(sql))).toEqual([]);
    expect(exec.mock.calls.filter(([sql]) => /PRAGMA busy_timeout/iu.test(sql))).toEqual([]);
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 37 });
    prepare.mockClear();
    transact(() => {
      // Constructor policy is already known; lock admission restores it before the write.
      expect(prepare.mock.calls.filter(([sql]) => /PRAGMA busy_timeout/iu.test(sql))).toEqual([]);
      expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 37 });
      db.exec("INSERT INTO t VALUES (4)");
    });
  });
  expect(exec.mock.calls.filter(([sql]) => /PRAGMA busy_timeout/iu.test(sql))).toEqual([
    ["PRAGMA busy_timeout = 0"],
    ["PRAGMA busy_timeout = 37"],
  ]);
  expect(reader((db) => db.prepare("SELECT count(*) AS n FROM t").get())).toEqual({ n: 4 });
});
