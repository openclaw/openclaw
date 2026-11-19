import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { findSqlPortabilityViolations, main } from "../../scripts/check-sql-portability.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("rejects SQLite scalar extrema and negative LIMIT expressions without confusing aggregates or SQL data", () => {
  const cases = [
    ['eb.fn<number>("max", [eb.ref("a"), eb.val(0)])', ["multi-argument max"]],
    ['query.fn.agg<number>("min", ["a", "b", "c"])', ["multi-argument min"]],
    ['eb.fn("min", ["a", "b"] as const)', ["multi-argument min"]],
    ['eb.fn(`max`, ["a", "b"])', ["multi-argument max"]],
    ['eb.fn("max", ["a"]).over()', []],
    ['eb.fn.max("a")', []],
    ["rows.limit(-1)", ["negative LIMIT"]],
    ["rows.limit(-1 as number)", ["negative LIMIT"]],
    ["rows.limit(eb.lit(-1))", ["negative LIMIT"]],
    ["rows.limit(eb => eb.val(-1))", ["negative LIMIT"]],
    ["rows.limit((eb) => eb.lit(-1)).offset(10)", ["negative LIMIT"]],
    ["rows.limit((eb) => { return eb.lit(-1); })", ["negative LIMIT"]],
    ["rows.limit(sql`-1`)", ["negative LIMIT"]],
    ["rows.limit(sql`${-1}`)", ["negative LIMIT"]],
    ["rows.limit(sql`(${(-1)})`)", ["negative LIMIT"]],
    ['rows.limit(sql.raw("-1"))', ["negative LIMIT"]],
    ["rows.limit(20).offset(10)", []],
    ["rows.limit(Math.max(0, input - 1))", []],
    ["rows.limit(valid ? depth : -1)", ["negative LIMIT"]],
    ["rows.limit(engineUnboundedRowLimit(db))", []],
    ["sql`SELECT max(a, coalesce(b, 0)) FROM t`", ["multi-argument max"]],
    ["sql`SELECT max(a), min(b) FROM t`", []],
    ["sql`SELECT max(${a}, ${b})`", ["multi-argument max"]],
    ['sql`SELECT ${"SELECT min(a,b)"} AS message`', []],
    ['eb.val("SELECT min(a,b)")', []],
    ['rows.values({ text: "SELECT min(a,b)" })', []],
    ['rows.onConflict(oc => oc.column("id").doUpdateSet({ text: "SELECT max(a,b)" }))', []],
    [
      'rows.onConflict(oc => oc.column("id").doUpdateSet({ n: sql`max(a,b)` }))',
      ["multi-argument max"],
    ],
    ['rows.where("text", "=", "SELECT min(a,b)")', []],
    ["sql`SELECT ${sql`max(a,b)`}`", ["multi-argument max"]],
    ['sql`SELECT ${eb.fn("max", ["a", "b"])}`', ["multi-argument max"]],
    ["sql.raw(`max(${column}, 0)`)", ["multi-argument max"]],
    ["sql.raw(`LIMIT -1 OFFSET ${offset}`)", ["negative LIMIT"]],
    ["db.prepare(`SELECT a FROM t LIMIT -1 OFFSET ${offset}`)", ["negative LIMIT"]],
    [
      'events.on("ready", () => { const query = "SELECT max(a,b)"; db.exec(query); })',
      ["multi-argument max"],
    ],
    ["sql`SELECT a FROM t LIMIT -1 OFFSET 3`", ["negative LIMIT"]],
    ["sql`SELECT a FROM t LIMIT (-1)`", ["negative LIMIT"]],
    ['db.prepare("SELECT id FROM items LIMIT 10, -1")', ["negative LIMIT"]],
    ["sql`SELECT id FROM items LIMIT coalesce(${offset}, 0), (-1)`", ["negative LIMIT"]],
    ["sql`SELECT id FROM items LIMIT 10, 20`", []],
    ["sql`SELECT id FROM items LIMIT 10 OFFSET 0`", []],
    ["sql`(SELECT id FROM items LIMIT 10) UNION SELECT id, -1 FROM other`", []],
    ["sql`SELECT a FROM t LIMIT ${-1}`", ["negative LIMIT"]],
    ["sql`SELECT a FROM t LIMIT ${sql.val(-1)}`", ["negative LIMIT"]],
    ['db.prepare("INSERT INTO messages(body) VALUES (?)").run("SELECT max(a,b)")', []],
    ['db.prepare("SELECT ? AS body").get("SELECT max(a,b)")', []],
    ['db.prepare("SELECT ? AS body").all("SELECT max(a,b)")', []],
    ['db.prepare("SELECT max(a,b)").get()', ["multi-argument max"]],
    ['db.get("SELECT max(a,b)")', ["multi-argument max"]],
    ["const statement = `SELECT min(a, b) FROM t`", ["multi-argument min"]],
    ["const statement = `-- read rows\nSELECT min(a, b) FROM t`", ["multi-argument min"]],
    ['const statement = "/* read rows */ SELECT a FROM t LIMIT -1"', ["negative LIMIT"]],
    [
      'const ddl = "CREATE TABLE t (n INTEGER CHECK (min(n, 10) = n))"; db.exec(ddl);',
      ["multi-argument min"],
    ],
    [
      "const ddl = `create view v as select max(n, 10) from t`; db.exec(ddl);",
      ["multi-argument max"],
    ],
    ['db.prepare("SELECT a FROM t LIMIT -1")', ["negative LIMIT"]],
    ["sql`SELECT max(a), 'min(a,b) LIMIT -1', \"max(a,b)\" FROM t /* max(a,b) */`", []],
    ["sql`SELECT $$max(a,b) LIMIT -1$$ AS message`", []],
    ["sql`SELECT $body$min(a,b) LIMIT -1$body$ AS message`", []],
    ["sql`SELECT $$max(a,b)$$, max(a,b) FROM t`", ["multi-argument max"]],
    ['// eb.fn("max", [a,b])\nconst prose = "max(a,b) LIMIT -1";', []],
  ] as const;
  using parser = createNativeTypeScriptParser();
  const sources = parser.parseSourceFiles(
    cases.map(([text], index) => ({
      fileName: `fixture-${index}.ts`,
      text,
    })),
  );
  for (const [index, [text, expected]] of cases.entries()) {
    const source = sources[index];
    if (!source) {
      throw new Error(`Missing parsed fixture ${index}`);
    }
    expect
      .soft(
        findSqlPortabilityViolations(source).map((issue) => issue.construct),
        text,
      )
      .toEqual(expected);
  }
});

it("honors expression-local SQLite markers and checks the selected production tree", () => {
  const root = directories.make("sql-portability-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  fs.mkdirSync(path.join(root, "src"));
  const file = path.join(root, "src", "query.ts");
  fs.writeFileSync(
    file,
    [
      "if (!postgres) {",
      '  const allowed = /* pg-sqlite-only: Guarded native SQLite branch. */ eb.fn("max", ["a", "b"]);',
      "  const bounded = /* pg-sqlite-only: Guarded recursive SQLite CTE. */ rows.limit(-1);",
      "  const raw = /* pg-sqlite-only: Private native SQLite index. */ sql`SELECT min(a, b)`;",
      "}",
      'const unguarded = eb.fn("min", ["a", "b"]);',
      'const nativeRaw = /* pg-sqlite-only: Private native SQLite index. */ sql.raw("max(a,b)");',
    ].join("\n"),
  );
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  expect(main(root)).toBe(1);
  expect(errors.mock.calls.flat()).toEqual([
    "src/query.ts:6: multi-argument min; use the database-engine dialect owner.",
  ]);
  fs.writeFileSync(file, 'const neutral = eb.fn("least", ["a", "b"]);');
  fs.writeFileSync(path.join(root, "src", "query.test.ts"), "rows.limit(-1)");
  expect(main(root)).toBe(0);

  execFileSync("git", ["add", "."], { cwd: root });
  fs.writeFileSync(file, 'const regression = eb.fn("max", ["a", "b"]);');
  expect(main(root)).toBe(1);
  expect(main(root, true)).toBe(0);
  execFileSync("git", ["add", "."], { cwd: root });
  fs.writeFileSync(file, 'const neutral = eb.fn("greatest", ["a", "b"]);');
  expect(main(root)).toBe(0);
  expect(main(root, true)).toBe(1);

  for (const [source, result] of [
    ["sql`SELECT max /* comparison */ (a,b)`", 1],
    ["sql`SELECT a FROM t LIMIT /* unbounded */ -1`", 1],
    ["sql.raw(`max(a,b)`)", 1],
    ["sql.raw(`LIMIT -1`)", 1],
    ['sql`SELECT ${"SELECT min(a,b)"} AS message`', 0],
  ] as const) {
    fs.writeFileSync(file, source);
    expect.soft(main(root), source).toBe(result);
  }

  fs.writeFileSync(file, "");
  const sqlFile = path.join(root, "src", "query.sql");
  fs.writeFileSync(sqlFile, "-- stored query\nSELECT max(a, 0) FROM t LIMIT -1;");
  expect(main(root)).toBe(1);
  execFileSync("git", ["add", "."], { cwd: root });
  fs.writeFileSync(sqlFile, "SELECT max(a) FROM t LIMIT 1;");
  expect(main(root)).toBe(0);
  expect(main(root, true)).toBe(1);
});
