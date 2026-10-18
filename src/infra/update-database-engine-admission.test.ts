import "../snapshot/database-backup.js";
import "./backup-sqlite-snapshot.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { assertUpdateDatabaseEngineContexts } from "./update-database-engine-admission.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

async function store(engine: "sqlite" | "postgres", enabled = true) {
  const stateDir = directories.make("update-engine-admission-");
  const file = path.join(stateDir, "plugins", "workboard", "workboard.sqlite");
  await fs.mkdir(path.dirname(file), { recursive: true });
  using db = openNodeSqliteDatabase(file);
  if (engine === "postgres") {
    db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
    db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, ?, ?)").run(
      "e3b4e990-c0f1-4ec7-a5d1-4e1c6824f80f",
      "postgres",
      "retained_workboard",
    );
  } else {
    db.exec("CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('retained')");
  }
  return {
    file,
    context: {
      config: { plugins: { entries: { workboard: { enabled } } } },
      env: { OPENCLAW_STATE_DIR: stateDir },
    },
  };
}

it.each([{ declaration: undefined }, { declaration: ["sqlite"] }, { declaration: [] }])(
  "refuses an unsupported PostgreSQL target before mutation: $declaration",
  async ({ declaration }) => {
    const { file, context } = await store("postgres");
    const before = await fs.readFile(file);
    const activate = vi.fn();
    await expect(
      assertUpdateDatabaseEngineContexts([context], async () => declaration).then(activate),
    ).rejects.toThrow(/Reverse-port to SQLite with the current binary/);
    expect(activate).not.toHaveBeenCalled();
    expect(await fs.readFile(file)).toEqual(before);
    expect(await fs.readdir(path.dirname(file))).toEqual(["workboard.sqlite"]);
  },
);

it("admits a matching PostgreSQL target without changing its anchor", async () => {
  const { file, context } = await store("postgres");
  const before = await fs.readFile(file);
  await assertUpdateDatabaseEngineContexts([context], async () => ["sqlite", "postgres"]);
  expect(await fs.readFile(file)).toEqual(before);
});

it("leaves a SQLite install unchanged and never consumes the optional target declaration", async () => {
  const { file, context } = await store("sqlite");
  const before = await fs.readFile(file);
  const target = vi.fn(async () => undefined);
  await assertUpdateDatabaseEngineContexts([context], target);
  expect(target).not.toHaveBeenCalled();
  expect(await fs.readFile(file)).toEqual(before);
});

it("protects a retained PostgreSQL anchor when Workboard is disabled", async () => {
  const { file, context } = await store("postgres", false);
  const before = await fs.readFile(file);
  await expect(
    assertUpdateDatabaseEngineContexts([context], async () => undefined),
  ).rejects.toThrow(/target does not support the PostgreSQL store/);
  expect(await fs.readFile(file)).toEqual(before);
});
