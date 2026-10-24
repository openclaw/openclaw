import fs from "node:fs/promises";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { ensureOpenClawAgentSchema } from "../state/openclaw-agent-db-schema.js";
import { dumpGitBackupDatabase, restoreGitBackupDirectory } from "./git-backup-codec.js";
import { expectDatabaseRows } from "./git-backup.test-support.js";
import { createGlobalDatabase } from "./local-repository.schema.test-support.js";
import { withDatabase } from "./local-repository.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string, sourcePath: string, outputPath: string, targetPath: string;
beforeEach(() => {
  root = tempDirs.make("git-backup-codec-");
  sourcePath = path.join(root, "source.sqlite");
  outputPath = path.join(root, "dump");
  targetPath = path.join(root, "restored.sqlite");
});
const dump = (identity: Parameters<typeof dumpGitBackupDatabase>[0]["identity"]) =>
  dumpGitBackupDatabase({ snapshotPath: sourcePath, outputPath, identity });
const restore = (
  expectedIdentity: Parameters<typeof restoreGitBackupDirectory>[0]["expectedIdentity"],
  target = targetPath,
) => restoreGitBackupDirectory({ sourcePath: outputPath, targetPath: target, expectedIdentity });

it("restores historical agent data without migration and rejects incompatible version manifests", async () => {
  // Latest stable 2026.10.2 persisted schema 24; pin the shipped data contract.
  const version = 24;
  const expected = { value: 9_223_372_036_854_775_806n, bytes: "000102FF" };
  withDatabase(sourcePath, (source) => {
    ensureOpenClawAgentSchema(source, "main", sourcePath, version);
    // Deployed schema-24 backups used this older index order (2026.10.2).
    source.exec(`
        DROP INDEX idx_agent_trajectory_runtime_run;
        CREATE INDEX idx_agent_trajectory_runtime_run
          ON trajectory_runtime_events(session_id, run_id, seq)
          WHERE run_id IS NOT NULL;
      `);
    source.exec("CREATE TABLE compatibility_probe (value INTEGER, bytes BLOB) STRICT");
    source
      .prepare("INSERT INTO compatibility_probe VALUES (?, ?)")
      .run(expected.value, Buffer.from([0, 1, 2, 255]));
  });
  const identity = { role: "agent", agentId: "main" } as const;
  const manifest = await dump(identity);
  const restored = await restore(identity);
  expect(restored.manifest.userVersion).toBe(version);
  expect(restored.tables.every((table) => table.ok)).toBe(true);
  withDatabase(
    targetPath,
    (database) => {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
      const statement = database.prepare(
        "SELECT value, hex(bytes) AS bytes FROM compatibility_probe",
      );
      statement.setReadBigInts(true);
      expect(statement.get()).toEqual(expected);
      expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    },
    { readOnly: true },
  );

  for (const invalidVersion of [OPENCLAW_AGENT_SCHEMA_VERSION, OPENCLAW_AGENT_SCHEMA_VERSION + 1]) {
    await fs.writeFile(
      path.join(outputPath, "manifest.json"),
      JSON.stringify({ ...manifest, userVersion: invalidVersion }),
    );
    const refusedTarget = path.join(root, `invalid-${invalidVersion}.sqlite`);
    await expect(restore(identity, refusedTarget)).rejects.toThrow();
    await expect(fs.stat(refusedTarget)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it("preserves TEXT, storage classes, key order, quoted DDL, and CASE triggers", async () => {
  const rows = [
    ["\0leading", "text\0suffix", "text\0suffix"],
    ["\nline", "", ""],
    [" space", null, null],
    ["shared\0left", 9_007_199_254_740_993n, { $int: "9007199254740993" }],
    ["shared\0right", Buffer.from([0, 255]), { $hex: "00ff" }],
    ["雪🦀\0尾", 1.25, 1.25],
  ] satisfies [string, SQLInputValue, unknown][];
  const byteQuery =
    'SELECT hex("key") AS key, typeof(value) AS type, hex(value) AS bytes FROM text_values ORDER BY "key"';
  createGlobalDatabase(sourcePath);
  const expectedBytes = withDatabase(sourcePath, (source) => {
    source.exec('CREATE TABLE text_values ("key" TEXT PRIMARY KEY, value ANY) STRICT');
    source.exec(`
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
    const insert = source.prepare('INSERT INTO text_values ("key", value) VALUES (?, ?)');
    for (const [key, value] of rows.toReversed()) {
      insert.run(key, value);
    }
    return source.prepare(byteQuery).all();
  });

  await dump({ role: "global" });
  const content = await fs.readFile(path.join(outputPath, "tables/text_values.jsonl"), "utf8");
  const records = content
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records).toEqual(rows.map(([key, , value]) => ({ key, value })));
  const restored = await restore({ role: "global" });
  expect(restored.tables.every((table) => table.ok)).toBe(true);
  withDatabase(targetPath, (database) => {
    database.exec("INSERT INTO trigger_values VALUES (1)");
  });
  expectDatabaseRows(targetPath, {
    [byteQuery]: expectedBytes,
    "SELECT * FROM quoted_ddl": [
      {
        "double;quote": "semi;'colon",
        "bracket;quote": "bracket",
        "backtick;quote": "backtick",
      },
    ],
    "SELECT value FROM trigger_values ORDER BY rowid": [{ value: 2 }, { value: 2 }],
  });
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
});
