import { describe, expect, it } from "vitest";
import {
  decodePostgresError,
  decodePostgresRows,
  isPostgresConnectionError,
  preparePostgresQuery,
  validatePostgresBindings,
} from "./protocol.js";

describe("PostgreSQL SQL boundary", () => {
  it.each([
    ["SELECT E'it\\'s ?', ?", "SELECT E'it\\'s ?', $1"],
    ["SELECT /* outer /* ? */ ? */ ?", "SELECT /* outer /* ? */ ? */ $1"],
    ["SELECT $$?$$, $tag$?$tag$, ?", "SELECT $$?$$, $tag$?$tag$, $1"],
    ["SELECT data ?? ?, data ??| ?", "SELECT data ? $1, data ?| $2"],
  ])("rewrites only anonymous placeholders: %s", (input, expected) => {
    expect(preparePostgresQuery(input).sql).toBe(expected);
  });

  it("refuses unsupported PRAGMA commands after a statement and comment", () => {
    expect(() => preparePostgresQuery("SELECT 1; /* x */ pragma foreign_keys")).toThrow(
      "The PostgreSQL engine does not support PRAGMA statements",
    );
  });

  it.each([
    ["WITH c AS (UPDATE t SET value = ? RETURNING *) SELECT * FROM c", "scoped"],
    ["WITH c AS (WITH i AS (SELECT 1) DELETE FROM t RETURNING *) SELECT * FROM c", "scoped"],
    ["WITH c AS (INSERT INTO t VALUES (?) RETURNING *) SELECT * FROM c", "scoped"],
    ["MERGE INTO t USING s ON false WHEN NOT MATCHED THEN INSERT VALUES (?)", "scoped"],
    ["SELECT * INTO copied FROM t", "unscoped"],
    ['SELECT t."id" INTO copied FROM t', "unscoped"],
    ['SELECT 1 AS "id" INTO copied', "unscoped"],
    ["SELECT 1. INTO copied", "unscoped"],
    ["SELECT * INTO copied FROM t; INSERT INTO copied VALUES (?)", "unscoped"],
    ["SELECT * FROM t FOR UPDATE", undefined],
    ["SELECT * FROM t FOR NO KEY UPDATE", undefined],
    ["SELECT t.update, t . /* column */ into FROM t", undefined],
    ["SELECT 1 AS update, 'DELETE', $$INSERT$$, E'UPDATE\\\' INTO' /* MERGE */", undefined],
  ] as const)("retains mutation evidence while preparing %s", (input, expected) => {
    expect(preparePostgresQuery(input).mutation).toBe(expected);
  });

  it("accepts SQLite scalar and binary bindings", () => {
    const views = [new Uint8Array([1, 2]), new DataView(new ArrayBuffer(2)), new Int32Array([7])];
    expect(() =>
      validatePostgresBindings([null, 1, Number.NaN, Infinity, 1n, "text", ...views]),
    ).not.toThrow();
  });

  it("refuses non-scalar bindings before transport", () => {
    expect(() => validatePostgresBindings([new Date(0)])).toThrow(TypeError);
  });

  it("decodes safe int8, bytea, nulls, and scalar results", () => {
    const fields = { count: 20, bytes: 17, empty: 20, text: 25, truth: 16 };
    const bytes = () => new Uint8Array([0, 255]);
    const result = {
      rows: [{ bytes: bytes(), empty: null, text: "hi", count: "9007199254740991", truth: true }],
      fields: Object.entries(fields).map(([name, dataTypeID]) => ({ name, dataTypeID })),
    };
    expect(decodePostgresRows(result, false)).toEqual([
      { bytes: bytes(), empty: null, text: "hi", count: Number.MAX_SAFE_INTEGER, truth: 1 },
    ]);
  });

  it("rejects unsafe int8 numbers unless the statement opts into bigints", () => {
    const result = {
      rows: [{ count: "9007199254740992" }],
      fields: [{ name: "count", dataTypeID: 20 }],
    };
    expect(() => decodePostgresRows(result, false)).toThrow(RangeError);
    expect(decodePostgresRows(result, true)).toEqual([{ count: 9007199254740992n }]);
  });

  it("preserves SQLite CHECK constraint handling for SQLSTATE 23514", () => {
    const cause = { message: "original pg failure", code: "23514", constraint: "cards_key" };
    expect(decodePostgresError({ name: "error", ...cause })).toMatchObject({
      message: "CHECK constraint failed: cards_key",
      code: "ERR_SQLITE_ERROR",
      errcode: 275,
      cause,
    });
  });

  it("identifies cancellation independently of connection loss", () => {
    const error = decodePostgresError({ name: "error", message: "canceled", code: "57014" });
    expect(error).toMatchObject({ name: "PostgresQueryCanceledError", code: "57014" });
    expect(isPostgresConnectionError("57014")).toBe(false);
  });

  it("retains unrelated PostgreSQL errors and their SQLSTATE", () => {
    expect(
      decodePostgresError({ name: "error", message: "syntax error", code: "42601" }),
    ).toMatchObject({ message: "syntax error", code: "42601" });
  });
});
