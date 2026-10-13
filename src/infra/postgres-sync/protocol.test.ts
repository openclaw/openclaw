import type { DatabaseSync } from "node:sqlite";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { SqlConnection } from "../sql-connection.js";
import {
  decodePostgresError,
  decodePostgresRows,
  isPostgresConnectionError,
  rewritePostgresPlaceholders,
  validatePostgresBindings,
} from "./protocol.js";

describe("experimental PostgreSQL SQL boundary", () => {
  it.each([
    [undefined, true],
    ["08000", true],
    ["08003", true],
    ["08006", true],
    ["08P01", true],
    ["57P01", true],
    ["57P02", true],
    ["57P03", true],
    ["23505", false],
    ["23503", false],
    ["23502", false],
    ["23514", false],
    ["42601", false],
    ["57014", false],
    ["XX000", false],
  ] as const)("classifies server SQLSTATE %s as connection-level: %s", (code, expected) => {
    expect(isPostgresConnectionError(code)).toBe(expected);
  });

  it("keeps the native SQLite handle assignable to the shared contract", () => {
    expectTypeOf<DatabaseSync>().toExtend<SqlConnection>();
  });

  it.each([
    ["SELECT ?, ?", "SELECT $1, $2"],
    ["SELECT '?', 'it''s ?', \"?\", ?", "SELECT '?', 'it''s ?', \"?\", $1"],
    ["SELECT E'it\\'s ?', ?", "SELECT E'it\\'s ?', $1"],
    ["SELECT `?`, [?], ?", "SELECT `?`, [?], $1"],
    ["SELECT ? -- ?\n, ? /* ? */", "SELECT $1 -- ?\n, $2 /* ? */"],
    ["SELECT /* outer /* ? */ ? */ ?", "SELECT /* outer /* ? */ ? */ $1"],
    ["SELECT $$?$$, $tag$?$tag$, ?", "SELECT $$?$$, $tag$?$tag$, $1"],
    ["SELECT data ?? ?, data ??| ?", "SELECT data ? $1, data ?| $2"],
  ])("rewrites only anonymous placeholders: %s", (input, expected) => {
    expect(rewritePostgresPlaceholders(input)).toBe(expected);
  });

  it.each([
    "PRAGMA journal_mode",
    "-- policy\n PRAGMA busy_timeout",
    "SELECT 1; /* x */ pragma foreign_keys",
  ])("refuses unsupported PRAGMA commands: %s", (input) => {
    expect(() => rewritePostgresPlaceholders(input)).toThrow(
      "The experimental PostgreSQL engine does not support PRAGMA statements",
    );
  });

  it("does not mistake quoted PRAGMA text for a command", () => {
    expect(rewritePostgresPlaceholders("SELECT 'PRAGMA ?', ?")).toBe("SELECT 'PRAGMA ?', $1");
  });

  it("accepts SQLite scalar and binary bindings", () => {
    expect(() =>
      validatePostgresBindings([
        null,
        1,
        Number.NaN,
        Infinity,
        1n,
        "text",
        new Uint8Array([1, 2]),
        new DataView(new ArrayBuffer(2)),
        new Int32Array([7]),
      ]),
    ).not.toThrow();
  });

  it.each([undefined, false, {}, [], new Date(0), new ArrayBuffer(2), Symbol("binding"), () => 1])(
    "refuses non-scalar bindings before transport: %s",
    (value) => {
      expect(() => validatePostgresBindings([value])).toThrow(TypeError);
    },
  );

  it("decodes safe int8, bytea, nulls, and scalar results", () => {
    expect(
      decodePostgresRows(
        {
          rows: [
            {
              count: "9007199254740991",
              bytes: new Uint8Array([0, 255]),
              empty: null,
              text: "hi",
              truth: true,
            },
          ],
          rowCount: 1,
          fields: [
            { name: "count", dataTypeID: 20 },
            { name: "bytes", dataTypeID: 17 },
            { name: "empty", dataTypeID: 20 },
            { name: "text", dataTypeID: 25 },
            { name: "truth", dataTypeID: 16 },
          ],
        },
        false,
      ),
    ).toEqual([
      {
        count: Number.MAX_SAFE_INTEGER,
        bytes: new Uint8Array([0, 255]),
        empty: null,
        text: "hi",
        truth: 1,
      },
    ]);
  });

  it("rejects unsafe int8 numbers unless the statement opts into bigints", () => {
    const result = {
      rows: [{ count: "9007199254740992" }],
      rowCount: 1,
      fields: [{ name: "count", dataTypeID: 20 }],
    };
    expect(() => decodePostgresRows(result, false)).toThrow(RangeError);
    expect(decodePostgresRows(result, true)).toEqual([{ count: 9007199254740992n }]);
    expect(decodePostgresRows({ ...result, rows: [{ count: "1" }] }, true)).toEqual([
      { count: 1n },
    ]);
  });

  it.each([
    ["23505", 2067, "UNIQUE"],
    ["23503", 787, "FOREIGN KEY"],
    ["23502", 1299, "NOT NULL"],
    ["23514", 275, "CHECK"],
  ])("preserves SQLite constraint handling for SQLSTATE %s", (code, errcode, kind) => {
    const error = decodePostgresError({
      name: "error",
      message: "original pg failure",
      code,
      constraint: "cards_key",
    });
    expect(error).toMatchObject({
      message: `${kind} constraint failed: cards_key`,
      code: "ERR_SQLITE_ERROR",
      errcode,
      cause: { message: "original pg failure", code, constraint: "cards_key" },
    });
  });

  it("retains unrelated PostgreSQL errors and their SQLSTATE", () => {
    expect(
      decodePostgresError({ name: "error", message: "syntax error", code: "42601" }),
    ).toMatchObject({ message: "syntax error", code: "42601" });
  });
});
