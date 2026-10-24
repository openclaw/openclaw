import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../../scripts/check-database-dialect-ratchet.mts";
import { changedProductionFiles, inventory } from "../../scripts/database-dialect-inventory.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
function expectConstructs(root: string, expected: Record<string, string>) {
  const rows = inventory(root);
  expect(rows.map(({ file }) => file)).toEqual(Object.keys(expected).toSorted());
  expect(
    Object.fromEntries(
      rows.map(({ file, matches }) => [file, matches.map(({ construct }) => construct).join(" ")]),
    ),
  ).toEqual(expected);
}
function ownerCases(
  file: string,
  cases: readonly (readonly [sql: string, construct: string, result: number])[],
  alwaysOwner = false,
) {
  return cases.map(([sql, construct, result]) => ({
    file,
    sql,
    construct,
    result,
    owner: alwaysOwner || result === 0,
  }));
}
const nonMaintenance = [
  ["INSERT OR IGNORE INTO t VALUES (1)", "insert-conflict", 1],
  ["SELECT json_extract(value, '$') FROM t", "json-projection", 1],
] as const;

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
  expectConstructs(root, {
    "extensions/store/read.mts": "sqlite-catalog",
    "packages/store/schema.sql": "transaction-mode printf",
    "src/infra/kysely-sync.ts": "json-string-set",
    "src/runtime.ts":
      "pragma user-version pragma schema-version data-version pragma json-string-set randomblob json-projection transaction-mode json-string-set json-string-set insert-conflict insert-conflict insert-conflict insert-conflict insert-conflict json-string-set json-string-set randomblob fts5",
  });
  expect(
    inventory(root).find(({ file }) => file === "src/infra/kysely-sync.ts")?.matches[0]?.owner,
  ).toBe(true);
  expect(
    inventory(root).find(({ file }) => file === "packages/store/schema.sql")?.matches,
  ).toMatchObject([{ line: 3 }, { line: 3 }]);
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
  expectConstructs(root, { "src/other.ts": "transaction-mode transaction-mode transaction-mode" });
});

it("retains SQLite JSONB debt without counting PostgreSQL catalog constructors", () => {
  const { root, write } = fixture();
  write(
    "src/postgres.ts",
    'const sql = "SELECT jsonb_build_object(), jsonb_build_array(), jsonb_agg(value), pg_catalog.jsonb_object_agg(key, value) FROM facts";',
  );
  write(
    "src/sqlite.ts",
    'const sql = "SELECT jsonb_object(), jsonb_array(), jsonb_extract(value), jsonb_group_array(value) FROM facts";',
  );
  for (const owner of ["postgres-search-schema", "postgres-vector"]) {
    write(
      `src/infra/database-engine/${owner}.ts`,
      'const sql = "SELECT openclaw_vector(embedding, 3)";',
    );
  }
  expectConstructs(root, {
    "src/sqlite.ts": "json-projection json-projection json-projection json-projection",
  });
});

it("excludes overlapping JSON only in native PostgreSQL branches", () => {
  const { root, write } = fixture();
  write(
    "src/runtime.ts",
    [
      'import { isPostgresSqlConnection as postgres } from "./infra/sql-connection.js";',
      "const read = postgres(db)",
      "  ? sql`SELECT value FROM json_each(body::json)`",
      "  : sql`SELECT value FROM json_each(body)`;",
      "if (postgres(db)) {",
      "  sql`SELECT jsonb_set(body::jsonb, path, value::jsonb), json_tree(body), json_extract(body, '$'), json_set(body, path, value), json_valid(body), rowid FROM facts`;",
      "  const later = () => sql`SELECT json_extract(body, '$') FROM facts`;",
      "} else {",
      "  sql`SELECT json_set(body, path, value) FROM facts`;",
      "}",
      "sql`SELECT jsonb_set(body, path, value) FROM json_each(body)`;",
    ].join("\n"),
  );
  write(
    "src/unrelated.ts",
    [
      'import { isPostgresSqlConnection } from "./unrelated-owner.js";',
      "if (isPostgresSqlConnection(db)) sql`SELECT jsonb_set(body, path, value) FROM json_each(body)`;",
    ].join("\n"),
  );
  expectConstructs(root, {
    "src/runtime.ts":
      "json-string-set json-string-set json-projection json-projection json-projection rowid json-projection json-projection json-projection json-string-set",
    "src/unrelated.ts": "json-projection json-string-set",
  });
});

it("classifies native context projections without hiding SQLite SQL in the same helpers", () => {
  const { root, write } = fixture();
  const native =
    "SELECT jsonb_typeof(body), jsonb_each(body), jsonb_array_elements(body), body -> 'message', body ->> 'type'";
  const source = `function postgresModelNavigationSql() {
    sql\`${native}\`;
    sql\`SELECT json_extract(body, '$'), jsonb_extract(body, '$')\`;
  }
  function other() { sql\`${native}\`; }`;
  write("src/config/sessions/session-model-context-projection.ts", source);
  write("src/other.ts", source);
  expect(inventory(root).map((row) => row.matches.length)).toEqual([7, 12]);
});

it("distinguishes PostgreSQL staging from SQLite temporary schemas", () => {
  const { root, write } = fixture();
  write(
    "extensions/memory-core/src/memory/manager-publication-postgres.ts",
    'db.exec("CREATE TEMP TABLE memory_stage (ordinal BIGINT)"); db.exec("SELECT rowid FROM t");',
  );
  write("src/sqlite.ts", 'db.exec("CREATE TEMP TABLE stage (id INTEGER)");');
  expectConstructs(root, {
    "extensions/memory-core/src/memory/manager-publication-postgres.ts": "rowid",
    "src/sqlite.ts": "temp-schema",
  });
});

it("excludes generated PostgreSQL SQL and captured catalogs while retaining SQLite JSON debt", () => {
  const { root, write, git } = fixture();
  write("src/sqlite.ts", "export {};\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  for (const file of ["agent.postgres.sql", "fragment-cache.postgres.sql"]) {
    write(
      `src/state/postgres-schema.generated/${file}`,
      "SELECT value ->> 'id' FROM json_each('{}'::json);",
    );
  }
  for (const store of ["state", "agent"]) {
    write(
      `src/state/postgres-schema.generated/sqlite-${store}-catalogs.ts`,
      "export const catalog = { sql: \"CREATE TABLE events AS SELECT json_extract(body, '$') FROM payloads\" };",
    );
  }
  expect(changedProductionFiles(root, base, false)).toEqual([]);
  expect(inventory(root)).toEqual([]);
  expect(main(root, ["--base", base])).toBe(0);
  expect(main(root, ["--base", base, "--full-tree"])).toBe(0);
  write("src/sqlite.ts", "const sql = \"SELECT value ->> 'id' FROM json_each(?)\";");
  expect(main(root, ["--base", base])).toBe(1);
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
  expectConstructs(root, { "packages/store/schema.sql": "custom-function custom-function" });
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

it.each([
  ...ownerCases(
    "src/infra/sqlite-strict.ts",
    [["PRAGMA foreign_keys = OFF", "pragma", 0], ...nonMaintenance],
    true,
  ),
  ...ownerCases(
    "src/infra/sqlite-snapshot.ts",
    [["PRAGMA auto_vacuum", "pragma", 0], ...nonMaintenance],
    true,
  ),
  ...ownerCases("src/consumer.ts", [
    ["PRAGMA foreign_keys = OFF", "pragma", 1],
    ["PRAGMA auto_vacuum", "pragma", 1],
    ["BEGIN EXCLUSIVE", "transaction-mode", 1],
    ["SELECT * FROM archive ORDER BY rowid", "rowid", 1],
  ]),
  ...ownerCases("src/infra/update-doctor-migration-attribution.ts", [
    ["BEGIN EXCLUSIVE", "transaction-mode", 0],
    ["PRAGMA locking_mode=EXCLUSIVE", "pragma", 0],
    ["PRAGMA schema_version", "schema-version", 0],
    ["VACUUM", "vacuum", 1],
    ...nonMaintenance,
  ]),
  ...ownerCases(
    "src/infra/sqlite-migration-scoped-snapshot.ts",
    [["SELECT * FROM archive ORDER BY rowid", "rowid", 0], ...nonMaintenance],
    true,
  ),
  ...ownerCases("src/state/openclaw-state-db-schema-v31-workspace-manifests.ts", [
    ["SELECT rowid FROM previous", "rowid", 0],
    ...nonMaintenance,
  ]),
])(
  "ratchets $sql in $file with only primitive maintenance excluded",
  ({ file, sql, result, owner, construct }) => {
    const { root, write, git } = fixture();
    write(file, "export {};\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    write(file, `db.exec(${JSON.stringify(sql)});`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main(root, ["--base", base])).toBe(result);
    const constructs = construct === "schema-version" ? ["pragma", construct] : [construct];
    expect(inventory(root)).toMatchObject([
      {
        file,
        matches: constructs.map((matchedConstruct) => ({ owner, construct: matchedConstruct })),
      },
    ]);
    if (result === 0) {
      expect(logs).toHaveBeenCalledWith(
        `SQLite primitive owners: ${constructs.length} engine-maintenance matches in changed files (excluded from comparison).`,
      );
      expect(logs).toHaveBeenCalledWith(expect.stringContaining(`${construct} (owner)`));
    }
  },
);

it("excludes owned physical layouts while retaining runtime rowid and non-owner layout debt", () => {
  const { root, write, git } = fixture();
  const owners = [
    "src/state/openclaw-agent-schema.sql",
    "src/state/openclaw-state-schema.sql",
    "packages/memory-host-sdk/src/memory-entry-origins.ts",
    "src/state/sqlite-table-layout-migration.ts",
  ];
  const ddl = "CREATE TABLE items (id TEXT PRIMARY KEY) STRICT, WITHOUT ROWID;";
  const source = (file: string, sql: string) =>
    file.endsWith(".sql") ? sql : `db.exec(${JSON.stringify(sql)});`;
  for (const file of owners) {
    write(file, "");
  }
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  for (const file of owners) {
    write(file, source(file, ddl));
  }
  expect(main(root, ["--base", base])).toBe(0);
  expect(inventory(root)).toMatchObject(
    owners.toSorted().map((file) => ({
      file,
      matches: [
        { construct: "without-rowid", group: "engine-maintenance", owner: true },
        { construct: "rowid", group: "engine-maintenance", owner: true },
      ],
    })),
  );
  const owner = "src/state/sqlite-table-layout-migration.ts";
  write(owner, source(owner, `${ddl} SELECT rowid FROM items;`));
  expect(main(root, ["--base", base])).toBe(1);
  expect(
    inventory(root)
      .find((row) => row.file === owner)
      ?.matches.at(-1),
  ).toMatchObject({
    construct: "rowid",
    group: "design",
    owner: false,
  });
  write("src/consumer.ts", source("src/consumer.ts", ddl));
  expect(inventory(root).find((row) => row.file === "src/consumer.ts")?.matches).toMatchObject([
    { construct: "without-rowid", group: "mechanical", owner: false },
    { construct: "rowid", group: "design", owner: false },
  ]);
});
