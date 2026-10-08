import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { dumpGitBackupDatabase, restoreGitBackupDirectory } from "./git-backup-codec.js";

it("preserves TEXT, storage classes, key order, quoted DDL, and CASE triggers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "git-backup-text-"));
  const sourcePath = path.join(root, "source.sqlite");
  const outputPath = path.join(root, "dump");
  const targetPath = path.join(root, "restored.sqlite");
  const keys = ["\0leading", "\nline", " space", "shared\0left", "shared\0right", "雪🦀\0尾"];
  const values = ["text\0suffix", "", null, 9_007_199_254_740_993n, Buffer.from([0, 255]), 1.25];
  const byteQuery =
    'SELECT hex("key") AS key, typeof(value) AS type, hex(value) AS bytes FROM text_values ORDER BY "key"';
  try {
    const source = openOpenClawStateDatabase({ path: sourcePath });
    source.db.exec('CREATE TABLE text_values ("key" TEXT PRIMARY KEY, value ANY) STRICT');
    source.db.exec(`
      CREATE TABLE quoted_ddl (
        "double;quote" TEXT PRIMARY KEY DEFAULT 'semi;''colon',
        [bracket;quote] TEXT /* ; not a statement boundary */ DEFAULT 'bracket',
        \`backtick;quote\` TEXT -- ; not a statement boundary
          DEFAULT 'backtick'
      ) STRICT;
      INSERT INTO quoted_ddl DEFAULT VALUES;
      CREATE TABLE trigger_values (value INTEGER NOT NULL) STRICT;
      CREATE TRIGGER zz_case_trigger AFTER INSERT ON trigger_values BEGIN
        UPDATE trigger_values SET value = CASE WHEN value = 1 THEN 2 ELSE value END;
        /* The trigger has its own END after the CASE expression. */
      END;
      INSERT INTO trigger_values VALUES (1);
    `);
    const insert = source.db.prepare('INSERT INTO text_values ("key", value) VALUES (?, ?)');
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      insert.run(keys[index]!, values[index]!);
    }
    const expectedBytes = source.db.prepare(byteQuery).all();
    closeOpenClawStateDatabaseForTest();

    await dumpGitBackupDatabase({
      snapshotPath: sourcePath,
      outputPath,
      identity: { role: "global" },
    });
    const content = await fs.readFile(path.join(outputPath, "tables/text_values.jsonl"), "utf8");
    expect(
      content
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { key: keys[0], value: "text\0suffix" },
      { key: keys[1], value: "" },
      { key: keys[2], value: null },
      { key: keys[3], value: { $int: "9007199254740993" } },
      { key: keys[4], value: { $hex: "00ff" } },
      { key: keys[5], value: 1.25 },
    ]);
    const restored = await restoreGitBackupDirectory({
      sourcePath: outputPath,
      targetPath,
      expectedIdentity: { role: "global" },
    });
    expect(restored.tables.every((table) => table.ok)).toBe(true);
    const database = new DatabaseSync(targetPath);
    try {
      expect(database.prepare(byteQuery).all()).toEqual(expectedBytes);
      expect(database.prepare("SELECT * FROM quoted_ddl").all()).toEqual([
        {
          "double;quote": "semi;'colon",
          "bracket;quote": "bracket",
          "backtick;quote": "backtick",
        },
      ]);
      database.exec("INSERT INTO trigger_values VALUES (1)");
      expect(database.prepare("SELECT value FROM trigger_values ORDER BY rowid").all()).toEqual([
        { value: 2 },
        { value: 2 },
      ]);
    } finally {
      database.close();
    }
    const schemaPath = path.join(outputPath, "schema.sql");
    const schema = await fs.readFile(schemaPath, "utf8");
    const incompleteTrigger = schema.replace(
      /CREATE TRIGGER zz_case_trigger[\s\S]*?\n\s*END;/u,
      (trigger) => trigger.replace(/\n\s*END;$/u, ""),
    );
    expect(incompleteTrigger).not.toBe(schema);
    await fs.writeFile(schemaPath, incompleteTrigger);
    const refusedTarget = path.join(root, "incomplete-trigger.sqlite");
    await expect(
      restoreGitBackupDirectory({ sourcePath: outputPath, targetPath: refusedTarget }),
    ).rejects.toThrow(/incomplete input/iu);
    await expect(fs.stat(refusedTarget)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  }
});
