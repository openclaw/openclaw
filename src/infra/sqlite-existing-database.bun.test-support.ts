import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  createExistingSqliteRollbackReader,
  withExistingSqliteRollbackDatabase,
} from "./sqlite-existing-database.js";

assert.ok(process.versions.bun, "this regression must execute in Bun");
const home = process.argv[2];
assert.ok(home, "the fixture requires its private home directory");

// Bun defers close_v2 while statements remain, so a snapshot lock that only
// close released blocked this process's own writer until its busy timeout.
const file = path.join(home, "store.sqlite");
const seed = openNodeSqliteDatabase(file);
seed.exec("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1);");
seed.close();
const options = { busyTimeoutMs: 1_000, assertIdentity() {} };
const write = (value: number) =>
  withExistingSqliteRollbackDatabase(file, { ...options, write: true }, (db, transact) =>
    transact(() => db.exec(`INSERT INTO t VALUES (${value})`)),
  );
write(2);
write(3);
{
  using reader = createExistingSqliteRollbackReader(file, options);
  reader(() => undefined);
  write(4);
  assert.deepEqual(
    { ...reader((db) => db.prepare("SELECT count(*) AS n FROM t").get()) },
    { n: 4 },
  );
}

// The real update executor admits, retains its reader, and releases its lease.
const installRoot = path.join(home, "install");
fs.mkdirSync(installRoot);
fs.writeFileSync(path.join(installRoot, "package.json"), '{"name":"openclaw","version":"0.0.0"}');
assert.equal(
  await withUpdateCommandExecutor(randomUUID(), async (executor) => {
    await executor.enter(installRoot);
    return "released";
  }),
  "released",
);
