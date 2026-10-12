import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../../scripts/check-database-dialect-ratchet.mts";
import { changedProductionFiles, inventory } from "../../scripts/database-dialect-inventory.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const root = tempDirs.make("openclaw-dialect-ratchet-");
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: "pipe" },
    ).trim();
  git("init", "-q");
  return { root, write, git };
}

it("counts SQL-looking static text and conflict methods while ignoring prose and fragments", () => {
  const { root, write } = fixture();
  write(
    "src/prose.ts",
    [
      'const messages = ["does not match", "a -> b", "Pragma", "failed to attach", "use glob patterns"];',
      'const fragments = ["json_each(?)", "WHERE t MATCH ?", "select json_each(?)"];',
      "const otherTag = label`SELECT json_each(?)`;",
    ].join("\n"),
  );
  expect(inventory(root)).toEqual([]);
  write(
    "src/runtime.ts",
    [
      "// VACUUM; const ignored = /PRAGMA data_version/;",
      'const bare = "data_version schema_version user_version json_each randomblob";',
      'const quoted = \'SELECT "VACUUM", "json_each(" FROM "rowid"\';',
      'db.prepare("PRAGMA user_version; pragma_schema_version(); PRAGMA data_version");',
      'const functions = " (SELECT json_each (?) randomblob(2) json_extract(x)";',
      'const parts = `BEGIN IMMEDIATE ${"VACUUM"} json_tree(${sql`PRAGMA data_version`})`;',
      'const split = "json_" + "each(?)";',
      'const escaped = "SELECT json_\\u0065ach(?)";',
      "builder.orReplace(); builder.orIgnore /* comment */ (); builder.orAbort(); builder.orFail(); builder.orRollback();",
      'const prose = "Please VACUUM this database";',
      "sql`... json_each(${x}) ...`; kyselySql`json_tree(${x})`; db.SQL`randomblob(2)`;",
      'const fts = "SELECT * FROM t WHERE t MATCH ?";',
    ].join("\n"),
  );
  write("src/infra/kysely-sync.ts", "function sqliteStringSet() { return sql`json_each(?)`; }");
  write(
    "packages/store/schema.sql",
    '-- VACUUM\n/* PRAGMA data_version */\nBEGIN DEFERRED; SELECT "rowid", printf(1);',
  );
  write("extensions/store/read.mts", "const sql = `SELECT sqlite_master`;");
  for (const file of [
    "src/store.test.ts",
    "src/test-support/store.ts",
    "src/__fixtures__/store.ts",
    "src/test-runtime.ts",
    "packages/store/fixtures/schema.sql",
    "scripts/store.ts",
  ]) {
    write(file, 'const sql = "VACUUM";');
  }
  const rows = inventory(root);
  expect(rows).toMatchObject([
    { file: "extensions/store/read.mts", matches: [{ construct: "sqlite-catalog" }] },
    {
      file: "packages/store/schema.sql",
      matches: [
        { construct: "transaction-mode", line: 3 },
        { construct: "printf", line: 3 },
      ],
    },
    {
      file: "src/infra/kysely-sync.ts",
      matches: [{ construct: "json-string-set", owner: true }],
    },
    {
      file: "src/runtime.ts",
      matches: [
        { construct: "pragma", line: 4 },
        { construct: "user-version", line: 4 },
        { construct: "pragma", line: 4 },
        { construct: "schema-version", line: 4 },
        { construct: "data-version", line: 4 },
        { construct: "pragma", line: 4 },
        { construct: "json-string-set", line: 5 },
        { construct: "randomblob", line: 5 },
        { construct: "json-projection", line: 5 },
        { construct: "transaction-mode", line: 6 },
        { construct: "json-string-set", line: 6 },
        { construct: "json-string-set", line: 8 },
        { construct: "insert-conflict", line: 9 },
        { construct: "insert-conflict", line: 9 },
        { construct: "insert-conflict", line: 9 },
        { construct: "insert-conflict", line: 9 },
        { construct: "insert-conflict", line: 9 },
        { construct: "json-string-set", line: 11 },
        { construct: "json-string-set", line: 11 },
        { construct: "randomblob", line: 11 },
        { construct: "fts5", line: 12 },
      ],
    },
  ]);
  expect(inventory(root)).toEqual(rows);
});

it("preserves SQL quotation state across substitutions and reports the original span", () => {
  const { root, write } = fixture();
  write("src/quoted.ts", 'sql`SELECT "prefix${sql.raw(suffix)}rowid" FROM t`;');
  expect(inventory(root)).toEqual([]);
  write(
    "src/quoted.ts",
    "sql`SELECT '\"prefix${sql.raw(suffix)}closed',\n  ${sql.raw(other)}rowid FROM t`;",
  );
  expect(inventory(root)).toMatchObject([
    {
      file: "src/quoted.ts",
      matches: [{ construct: "rowid", line: 2, column: 19, index: 0 }],
    },
  ]);
});

it("counts only SQLite-specific transaction modes across owners", () => {
  const { root, write } = fixture();
  const standardSql = [
    "SAVEPOINT openclaw_tx_nested;",
    "SAVEPOINT another;",
    "RELEASE SAVEPOINT another;",
    "ROLLBACK TO SAVEPOINT another;",
    "BEGIN;",
    "BEGIN ISOLATION LEVEL READ COMMITTED;",
  ].join("\n");
  write("packages/store/transaction.sql", standardSql);
  write("src/infra/postgres-sync/transaction.ts", `db.exec(${JSON.stringify(standardSql)});`);
  write("src/other.ts", 'db.exec("BEGIN IMMEDIATE; BEGIN DEFERRED; BEGIN EXCLUSIVE;");');
  expect(inventory(root)).toMatchObject([
    {
      file: "src/other.ts",
      matches: [
        { construct: "transaction-mode" },
        { construct: "transaction-mode" },
        { construct: "transaction-mode" },
      ],
    },
  ]);
  expect(inventory(root).map((row) => row.matches.length)).toEqual([3]);
});

it("distinguishes table column lists from custom function calls", () => {
  const { root, write } = fixture();
  write(
    "packages/store/schema.sql",
    [
      "CREATE TABLE openclaw_items (id TEXT);",
      "create table if not exists openclaw_new_items (id TEXT);",
      "INSERT INTO openclaw_items (id) VALUES ('id');",
      "create table children (parent TEXT references openclaw_items (id));",
      "CREATE INDEX item_index ON openclaw_items (id);",
      "SELECT openclaw_transform(id) FROM openclaw_items;",
      "SELECT exists(openclaw_check(id)) FROM openclaw_items;",
    ].join("\n"),
  );
  expect(inventory(root)).toMatchObject([
    {
      file: "packages/store/schema.sql",
      matches: [
        { construct: "custom-function", line: 6 },
        { construct: "custom-function", line: 7 },
      ],
    },
  ]);
  expect(inventory(root).map((row) => row.matches.length)).toEqual([2]);
});

it("compares base to working tree or index using only changed files, and permits shrinkage and moves", () => {
  const { root, write, git } = fixture();
  write(
    "src/store.ts",
    'const sql = "INSERT OR IGNORE INTO t VALUES (?)";\nconst maintenance = "VACUUM";',
  );
  write("src/unchanged.ts", 'const sql = "BEGIN IMMEDIATE";');
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  const check = (...args: string[]) => main(root, ["--base", base, ...args]);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(changedProductionFiles(root, base, false)).toEqual([]);
  expect(check()).toBe(0);
  write("src/store.ts", 'const sql = "INSERT OR IGNORE INTO t VALUES (?)";');
  write("extensions/plugin/store.mts", 'const sql = "SELECT value FROM json_each(?)";');
  expect(changedProductionFiles(root, base, false)).toEqual([
    "extensions/plugin/store.mts",
    "src/store.ts",
  ]);
  expect(check()).toBe(1);
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("mechanical total grew by 1: 1 -> 2 in changed files"),
  );
  expect(check("--full-tree")).toBe(1);
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("mechanical total grew by 1: 2 -> 3 in full tree"),
  );
  git("add", ".");
  write("src/store.ts", "export {};\n");
  expect(check("--staged")).toBe(1);
  expect(check()).toBe(0);
  expect(logs).toHaveBeenCalledWith(
    "SQLite dialect engine-maintenance (changed files): 1 -> 0 (reduced by 1).",
  );
  write("extensions/plugin/store.mts", 'const sql = "SELECT json_extract(value) FROM t";');
  git("add", ".");
  git("commit", "-qm", "branch change");
  expect(check()).toBe(1);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining("design total grew by 1: 0 -> 1"));
  git("mv", "extensions/plugin/store.mts", "src/moved.mts");
  expect(changedProductionFiles(root, base, false)).toEqual(["src/moved.mts", "src/store.ts"]);
  expect(check()).toBe(1);
  fs.unlinkSync(path.join(root, "src/moved.mts"));
  expect(check()).toBe(0);
  expect(check("--full-tree")).toBe(0);
  expect(check("--staged")).toBe(1);
  expect(main(root, ["--prune"])).toBe(1);
  expect(errors).toHaveBeenCalledWith("SQLite dialect ratchet has no baseline to prune.");
});
