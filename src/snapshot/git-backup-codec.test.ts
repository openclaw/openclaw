import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { ensureOpenClawAgentSchema } from "../state/openclaw-agent-db-schema.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { dumpGitBackupDatabase, restoreGitBackupDirectory } from "./git-backup-codec.js";
import { withDatabase } from "./local-repository.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
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
    // Build the complete historical representation through its canonical owner,
    // rather than relabeling a current schema with an older PRAGMA.
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
  const keys = ["\0leading", "\nline", " space", "shared\0left", "shared\0right", "雪🦀\0尾"];
  const values = ["text\0suffix", "", null, 9_007_199_254_740_993n, Buffer.from([0, 255]), 1.25];
  const byteQuery =
    'SELECT hex("key") AS key, typeof(value) AS type, hex(value) AS bytes FROM text_values ORDER BY "key"';
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

  await dump({ role: "global" });
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
  const restored = await restore({ role: "global" });
  expect(restored.tables.every((table) => table.ok)).toBe(true);
  withDatabase(targetPath, (database) => {
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
