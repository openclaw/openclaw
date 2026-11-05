import { expect, it } from "vitest";
import {
  extractSqliteTableSchema,
  findSqlCharacter,
  findSqlClosingParenthesis,
  hasUnquotedSqlKeyword,
  splitSqlList,
} from "./sqlite-schema-sql.js";

it.each(["STRICT", "STRICT, WITHOUT ROWID"])(
  "extracts a %s table without consuming its neighboring table",
  (options) => {
    const table = `CREATE TABLE IF NOT EXISTS selected (\n  id TEXT PRIMARY KEY\n) ${options};`;
    const schema = `${table}\nCREATE TABLE IF NOT EXISTS neighbor (\n  id INTEGER PRIMARY KEY\n) STRICT;`;
    expect(extractSqliteTableSchema(schema, "selected")).toBe(table);
    expect(extractSqliteTableSchema(schema, "selected", { includeEndMarker: false })).toBe(
      "CREATE TABLE IF NOT EXISTS selected (\n  id TEXT PRIMARY KEY",
    );
  },
);

it.each(["'a'';b'", '"a"";b"', "`a``;b`", "[a;b]", "-- a;b\n", "/* a;b */"])(
  "skips a quoted or commented delimiter in %s",
  (span) => {
    expect(findSqlCharacter(`${span};tail;`, ";")).toBe(span.length);
    expect(findSqlCharacter(`😀${span};`, ";")).toBe(span.length + 2);
  },
);

it.each(["'tail;", '"tail;', "`tail;", "[tail;", "-- tail;\r", "/* tail;"])(
  "consumes an unterminated quoted or commented tail in %s",
  (span) => {
    expect(findSqlCharacter(span, ";")).toBe(-1);
    expect(splitSqlList(`first,${span}`)).toEqual(["first", span]);
    expect(() => findSqlClosingParenthesis(`(${span})`, 0)).toThrow("unterminated");
  },
);

it("preserves nested lists and inclusive parenthesis matching across adjacent spans", () => {
  const sql = "(first, fn('a,b)', (second)), /* ,) */-- ,)\n[third,]) tail";
  const close = sql.indexOf(") tail");
  expect(findSqlClosingParenthesis(sql, 0)).toBe(close);
  expect(splitSqlList(sql.slice(1, close))).toEqual([
    "first",
    " fn('a,b)', (second))",
    " /* ,) */-- ,)\n[third,]",
  ]);
  const adjacent = "'x'/* ; */-- ;\n;";
  expect(findSqlCharacter(adjacent, ";")).toBe(adjacent.length - 1);
});

it("matches only unquoted keyword starts without changing the caller's regex cursor", () => {
  const keywords = /\bINSERT\b/giu;
  keywords.lastIndex = 7;
  expect(hasUnquotedSqlKeyword("INSERT 'INSERT' /* INSERT */", keywords)).toBe(false);
  expect(hasUnquotedSqlKeyword("INSERT 'INSERT' /* INSERT */ INSERT", keywords)).toBe(true);
  expect(keywords.lastIndex).toBe(7);
});
