import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createNodeEvalArgs } from "../test-utils/node-process.js";

describe("node SQLite backup completion", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);

  it("settles idle native backups and releases completion work after success or failure", async ({
    signal,
  }) => {
    const root = dirs.make("sqlite-backup-completion-");
    const target = path.join(root, "backup.sqlite");
    const owner = path.join(root, "sqlite-backup.mjs");
    // Loader/cache I/O would supply the unrelated callback this regression must exclude.
    await build({
      entryPoints: [fileURLToPath(new URL("./sqlite-backup.ts", import.meta.url))],
      outfile: owner,
      bundle: true,
      format: "esm",
      platform: "node",
      logLevel: "silent",
    });
    const result = await runNodeScript(
      createNodeEvalArgs(
        `import assert from "node:assert/strict";
         import fs from "node:fs";
         import { createRequire } from "node:module";
         import { backupNodeSqliteDatabase } from ${JSON.stringify(pathToFileURL(owner).href)};
         const sqlite = createRequire(import.meta.url)("node:sqlite");
         const nativeBackup = sqlite.backup;
         const writer = new sqlite.DatabaseSync(${JSON.stringify(path.join(root, "source.sqlite"))});
         writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records(value TEXT, payload BLOB); WITH RECURSIVE rows(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM rows WHERE id<32) INSERT INTO records SELECT 'retained', zeroblob(32768) FROM rows;");
         const database = new sqlite.DatabaseSync(${JSON.stringify(path.join(root, "source.sqlite"))}, { readOnly: true });
         database.exec("BEGIN;");
         database.prepare("PRAGMA schema_version;").get();
         await new Promise(setImmediate);
         let unrelatedWake = false;
         const wake = setTimeout(() => { unrelatedWake = true; }, 5000);
         try {
           const pages = await backupNodeSqliteDatabase(database, ${JSON.stringify(target)});
           assert.equal(unrelatedWake, false, "native backup waited for an unrelated callback");
           assert.ok(pages > 0);
           const copy = new sqlite.DatabaseSync(${JSON.stringify(target)}, { readOnly: true });
           try {
             assert.equal(copy.prepare("SELECT COUNT(*) AS count FROM records WHERE value='retained'").get().count, 32);
             assert.equal(copy.prepare("SELECT SUM(length(payload)) AS bytes FROM records").get().bytes, 1048576);
           }
           finally { copy.close(); }
           database.exec("ROLLBACK;");
           database.close();
           await assert.rejects(backupNodeSqliteDatabase(database, ${JSON.stringify(target)}), { code: "ERR_INVALID_STATE" });

           let nativeFailure;
           sqlite.backup = async (...args) => {
             try { return await nativeBackup(...args); }
             catch (error) { nativeFailure = error; throw error; }
           };
           await assert.rejects(backupNodeSqliteDatabase(database, ${JSON.stringify(target)}), error => error === nativeFailure);

           let resolveBackup;
           let calls = 0;
           sqlite.backup = () => { calls++; return new Promise(resolve => { resolveBackup = resolve; }); };
           let settled = false;
           const pending = backupNodeSqliteDatabase(database, ${JSON.stringify(target)}).then(value => { settled = true; return value; });
           await new Promise(resolve => setTimeout(resolve, 350));
           assert.equal(calls, 1);
           assert.equal(settled, false);
           resolveBackup(42);
           assert.equal(await pending, 42);
           fs.writeSync(1, "complete");
         } finally {
           sqlite.backup = nativeBackup;
           clearTimeout(wake);
           if (database.isOpen) database.close();
           writer.close();
         }`,
      ),
      process.env,
      20_000,
      { signal, maxBuffer: 16_384 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("complete");
  });
});
