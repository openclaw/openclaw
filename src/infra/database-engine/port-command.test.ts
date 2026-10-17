import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import "./database-suite-workers.test-support.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { runDatabasePortTask } from "./port-command.worker.js";
import { loadDatabasePortDescriptor } from "./port-provider-descriptor.js";
import { inspectDatabasePort, type PortDescriptor } from "./port.worker.js";
import { loadStatePortDescriptor } from "./state-port-descriptor.js";
import metadata from "./workboard-port.generated.json" with { type: "json" };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scope = { assertCurrent() {} };
let descriptor: PortDescriptor;
beforeAll(async () => {
  descriptor = await loadDatabasePortDescriptor("workboard");
});
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

it("preserves Doctor guidance when the port worker inspects an older shared-state schema", async () => {
  const directory = tempDirs.make("state-port-legacy-");
  const sourcePath = path.join(directory, "openclaw.sqlite");
  const legacy = await loadStatePortDescriptor(25);
  {
    using db = openNodeSqliteDatabase(sourcePath);
    db.exec(legacy.sqlite);
    for (const fragment of legacy.fragments ?? []) {
      db.exec(fragment.sqlite);
    }
    db.exec("PRAGMA user_version = 25");
  }
  const original = await hash(sourcePath);
  await expect(
    runDatabasePortTask({ operation: "inspect", sourcePath, config: {}, to: "postgres" }, scope),
  ).rejects.toThrow("run openclaw doctor --fix with the matching version first");
  expect(await hash(sourcePath)).toBe(original);
});

describe("workboard port worker", () => {
  it("inspects without writing and refuses changed canonical SQLite data", async () => {
    const { directory, sourcePath } = fixture();
    const original = await hash(sourcePath);
    const before = await fs.readdir(directory);
    const inspected = await runDatabasePortTask(
      { operation: "inspect", sourcePath, config: {}, to: "postgres" },
      scope,
    );
    expect(inspected).toMatchObject({ engine: "sqlite", version: 3, migrationRequired: false });
    expect(inspected.verification?.tables.workboard_boards?.rows).toBe(1);
    expect(await fs.readdir(directory)).toEqual(before);
    expect(await hash(sourcePath)).toBe(original);
    const targetPath = path.join(directory, "staged.sqlite");
    await fs.copyFile(sourcePath, targetPath);
    assert(inspected.verification);
    using changed = openNodeSqliteDatabase(targetPath);
    changed.exec("UPDATE workboard_boards SET name = 'changed'");
    await expect(
      runDatabasePortTask(
        {
          operation: "verify",
          sourcePath: targetPath,
          config: {},
          engine: "sqlite",
          storeId: "00000000-0000-4000-8000-000000000001",
          namespace: "unused",
          verification: inspected.verification,
        },
        scope,
      ),
    ).rejects.toThrow("changed canonical rows");
    expect(await hash(sourcePath)).toBe(original);
  });

  it.each([
    ["future version", "PRAGMA user_version = 99", "schema version 99"],
    [
      "unknown migration",
      "INSERT INTO workboard_schema_migrations VALUES ('future-payload', 1)",
      "unknown schema migration",
    ],
    ["unknown table", "CREATE TABLE private_payload (data TEXT)", "Unknown SQLite table"],
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
  ])(
    "refuses %s without exposing payloads or changing the source",
    async (_label, sql, message) => {
      const { sourcePath } = fixture(sql);
      const original = await hash(sourcePath);
      using source = openNodeSqliteDatabase(sourcePath, { readOnly: true, readBigInts: true });
      const failure = await Promise.resolve()
        .then(() => {
          descriptor.inspectSqliteSource?.(source);
          return inspectDatabasePort({ engine: "sqlite", db: source }, descriptor);
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain(message);
      expect(String(failure)).not.toContain("private-payload");
      expect(await hash(sourcePath)).toBe(original);
    },
  );

  it("maps foreign-key failure without exposing payloads or changing the source", async () => {
    const { sourcePath } = fixture(
      "PRAGMA foreign_keys = OFF; INSERT INTO workboard_card_labels VALUES ('absent', 1, 'private-payload')",
    );
    const original = await hash(sourcePath);
    const failure = await runDatabasePortTask(
      { operation: "inspect", sourcePath, config: {}, to: "postgres" },
      scope,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("database validation");
    expect(String(failure)).not.toContain("private-payload");
    expect(await hash(sourcePath)).toBe(original);
  });
});
