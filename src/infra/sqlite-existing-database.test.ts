import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createExistingSqliteRollbackReader } from "./sqlite-existing-database.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

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
  using reader = createExistingSqliteRollbackReader(file, {
    busyTimeoutMs: 0,
    assertIdentity() {},
  });

  // An observation that reads no rows still took its snapshot in EXCLUSIVE mode.
  // The retained connection stays open; a writer must not wait on that ended snapshot.
  reader(() => undefined);
  commitIndependently(file, 2);
  expect(reader((db) => db.prepare("SELECT count(*) AS n FROM t").get())).toEqual({ n: 2 });
  commitIndependently(file, 3);
});
