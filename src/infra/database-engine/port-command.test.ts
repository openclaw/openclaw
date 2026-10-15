import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { runDatabasePortTask as runWorkboardPortTask } from "./port-command.worker.js";
import metadata from "./workboard-port.generated.json" with { type: "json" };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scope = { assertCurrent() {} };
function fixture(sql = "") {
  const directory = tempDirs.make("port-command-");
  const sourcePath = path.join(directory, "workboard.sqlite");
  using db = openNodeSqliteDatabase(sourcePath);
  db.exec(metadata.sqlite);
  db.exec("INSERT INTO workboard_schema_migrations VALUES ('schema-3', 17)");
  db.exec(
    "INSERT INTO workboard_boards (id, name, created_at, updated_at) VALUES ('board', ' {\"a\":1,\"a\":2} ', 1, 2)",
  );
  if (sql) {
    db.exec(sql);
  }
  return { directory, sourcePath };
}
async function hash(file: string) {
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

describe("workboard port worker", () => {
  it("inspects without writing, migrates only a private copy, and verifies canonical SQLite data", async () => {
    const { directory, sourcePath } = fixture();
    const original = await hash(sourcePath);
    const before = await fs.readdir(directory);
    const inspected = await runWorkboardPortTask(
      { operation: "inspect", sourcePath, config: {}, to: "postgres" },
      scope,
    );
    expect(inspected).toMatchObject({ engine: "sqlite", version: 3, migrationRequired: false });
    expect(inspected.verification?.tables.workboard_boards?.rows).toBe(1);
    expect(await fs.readdir(directory)).toEqual(before);
    expect(await hash(sourcePath)).toBe(original);
    const working = path.join(directory, "private.sqlite");
    await fs.copyFile(sourcePath, working);
    const migrated = await runWorkboardPortTask(
      { operation: "migrate", sourcePath: working },
      scope,
    );
    const targetPath = path.join(directory, "staged.sqlite");
    const staged = await runWorkboardPortTask(
      {
        operation: "stage",
        sourcePath: working,
        config: {},
        targetPath,
        to: "sqlite",
        storeId: "00000000-0000-4000-8000-000000000001",
        namespace: "unused",
        sourceVerification: migrated.verification,
      },
      scope,
    );
    expect(staged.verification).toEqual(inspected.verification);
    await runWorkboardPortTask(
      {
        operation: "verify",
        sourcePath: targetPath,
        config: {},
        engine: "sqlite",
        storeId: "00000000-0000-4000-8000-000000000001",
        namespace: "unused",
        verification: staged.verification,
      },
      scope,
    );
    expect(await hash(sourcePath)).toBe(original);
    using changed = openNodeSqliteDatabase(targetPath);
    changed.exec("UPDATE workboard_boards SET name = 'changed'");
    await expect(
      runWorkboardPortTask(
        {
          operation: "verify",
          sourcePath: targetPath,
          config: {},
          engine: "sqlite",
          storeId: "00000000-0000-4000-8000-000000000001",
          namespace: "unused",
          verification: staged.verification,
        },
        scope,
      ),
    ).rejects.toThrow("changed canonical rows");
  });

  it("runs legacy migrations only on a private copy and preserves the untouched original", async () => {
    const { directory, sourcePath } = fixture(
      "DELETE FROM workboard_schema_migrations; INSERT INTO workboard_schema_migrations VALUES ('schema-2', 1); ALTER TABLE workboard_boards DROP COLUMN automation_job_id; ALTER TABLE workboard_boards DROP COLUMN kind; ALTER TABLE workboard_boards DROP COLUMN sessions_spec",
    );
    const original = await hash(sourcePath);
    const facts = await runWorkboardPortTask(
      { operation: "inspect", sourcePath, config: {}, to: "postgres" },
      scope,
    );
    expect(facts).toMatchObject({ version: 2, targetVersion: 3, migrationRequired: true });
    const working = path.join(directory, "private.sqlite");
    await fs.copyFile(sourcePath, working);
    const migrated = await runWorkboardPortTask(
      { operation: "migrate", sourcePath: working },
      scope,
    );
    expect(migrated.verification.tables.workboard_boards?.rows).toBe(1);
    expect(await hash(sourcePath)).toBe(original);
    const after = await runWorkboardPortTask(
      { operation: "inspect", sourcePath: working, config: {}, to: "postgres" },
      scope,
    );
    expect(after).toMatchObject({ version: 3, targetVersion: 3, migrationRequired: false });
  });

  it.each([
    ["future version", "PRAGMA user_version = 99", "schema version 99"],
    [
      "unknown migration",
      "INSERT INTO workboard_schema_migrations VALUES ('future-payload', 1)",
      "unknown schema migration",
    ],
    ["unknown table", "CREATE TABLE private_payload (data TEXT)", "Unknown SQLite table"],
    [
      "unknown trigger",
      "CREATE TRIGGER unexpected AFTER UPDATE ON workboard_boards BEGIN SELECT 1; END",
      "Unknown SQLite table",
    ],
    [
      "unknown view",
      "CREATE VIEW unexpected AS SELECT id FROM workboard_boards",
      "Unknown SQLite table",
    ],
    ["missing table", "DROP TABLE workboard_worker_protocol", "Unknown or missing columns"],
    ["invalid UTF8", "UPDATE workboard_boards SET name = CAST(x'80' AS TEXT)", "invalid UTF-8"],
    [
      "unknown column",
      "ALTER TABLE workboard_boards ADD COLUMN private_payload TEXT",
      "Unknown or missing columns",
    ],
    [
      "literal NUL",
      "UPDATE workboard_boards SET name = 'private-payload' || char(0)",
      "unrepresentable UTF-8",
    ],
    [
      "foreign key violation",
      "PRAGMA foreign_keys = OFF; INSERT INTO workboard_card_labels VALUES ('absent', 1, 'private-payload')",
      "database validation",
    ],
  ])(
    "refuses %s without exposing payloads or changing the source",
    async (_label, sql, message) => {
      const { sourcePath } = fixture(sql);
      const original = await hash(sourcePath);
      const failure = await runWorkboardPortTask(
        { operation: "inspect", sourcePath, config: {}, to: "postgres" },
        scope,
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain(message);
      expect(String(failure)).not.toContain("private-payload");
      expect(await hash(sourcePath)).toBe(original);
    },
  );
});
