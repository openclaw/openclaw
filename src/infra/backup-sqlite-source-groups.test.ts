import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  captureBackupSqliteSourceGroup,
  planBackupSqliteSourceGroups,
} from "./backup-sqlite-source-groups.js";
import { backupNodeSqliteDatabase } from "./sqlite-backup.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("refuses an alias checkpoint that truncates its WAL during capture", async () => {
  const directory = await fs.realpath(tempDirs.make("backup-journal-generation-"));
  const ownerPath = path.join(directory, "owner.sqlite");
  const aliasPath = path.join(directory, "alias.sqlite");
  const writer = new DatabaseSync(ownerPath);
  try {
    writer.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0;
      CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT);
      INSERT INTO records VALUES(1, 'base');
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
    await fs.link(ownerPath, aliasPath);
    writer.exec("INSERT INTO records VALUES(2, 'owner-wal')");
    const groups = await planBackupSqliteSourceGroups([
      { path: ownerPath, identity: await fs.stat(ownerPath) },
      { path: aliasPath, identity: await fs.stat(aliasPath) },
    ]);
    const group = groups.get(ownerPath);
    if (!group) {
      throw new Error("Missing owner source group");
    }
    await expect(
      captureBackupSqliteSourceGroup(group, async () => {
        const reader = new DatabaseSync(ownerPath, { readOnly: true });
        try {
          reader.exec("BEGIN; PRAGMA schema_version;");
          // Separate processes have separate WAL-index mappings for the two pathnames.
          const output = execFileSync(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `
          import { DatabaseSync } from 'node:sqlite';
          const database = new DatabaseSync(process.argv[1]);
          database.exec("PRAGMA journal_mode=WAL; INSERT INTO records VALUES(3, 'alias-wal')");
          console.log(JSON.stringify(database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()));
          database.close();
        `,
              aliasPath,
            ],
            { encoding: "utf8" },
          );
          expect(JSON.parse(output)).toEqual({ busy: 0, log: 0, checkpointed: 0 });
          expect((await fs.stat(`${aliasPath}-wal`)).size).toBe(0);
          await backupNodeSqliteDatabase(reader, path.join(directory, "snapshot.sqlite"));
        } finally {
          reader.close();
        }
      }),
    ).rejects.toThrow(/SQLite hardlink database changed during backup/iu);
  } finally {
    writer.close();
  }
});
