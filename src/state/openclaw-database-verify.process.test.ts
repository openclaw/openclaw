import { afterEach, expect, it, vi } from "vitest";
import * as nodeSqlite from "../infra/node-sqlite.js";
import * as sqliteSource from "../infra/sqlite-source-handle.js";
import { verifyOpenClawDatabase } from "./openclaw-database-verify.worker.js";

const target = { path: "synthetic.sqlite", label: "fixture", check: "quick" } as const;
afterEach(() => vi.restoreAllMocks());

function failed(error: string, terminal = false) {
  return { path: target.path, ok: false, error, terminal };
}

function throwOnRead(failure: unknown) {
  vi.spyOn(sqliteSource, "withSqliteSourceReadDatabase").mockImplementationOnce(() => {
    // oxlint-disable-next-line typescript/only-throw-error -- Exercise non-Error native failures.
    throw failure;
  });
}

it.each([
  {
    name: "wrapped I/O error without cause prose or metadata",
    failure: new Error("source read failed", {
      cause: Object.assign(new Error("private cause prose"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 10,
        path: "/private/synthetic.sqlite",
        sql: "SELECT private_data",
        extra: { secret: "synthetic secret" },
        stack: "private stack",
      }),
    }),
    expected: "Error: source read failed (code=ERR_SQLITE_ERROR, errcode=10)",
  },
  {
    name: "plain object with numeric code",
    failure: { code: 10, errcode: 10, extra: "private metadata" },
    expected: "[object Object] (code=10, errcode=10)",
  },
  {
    name: "aggregate members are excluded",
    failure: new AggregateError(
      [Object.assign(new Error("private aggregate prose"), { code: "EIO", errcode: 10 })],
      "aggregate failure",
    ),
    expected: "AggregateError: aggregate failure",
  },
  ...[
    { code: "X".repeat(65), errcode: 0x8000_0000 },
    { code: "private/path", errcode: -1 },
    { code: { secret: "private metadata" }, errcode: "10" },
  ].map((metadata, index) => ({
    name: `invalid code metadata ${index}`,
    failure: Object.assign(
      new Error("source read failed", {
        cause: { code: "EIO", errcode: 10, message: "private cause prose" },
      }),
      metadata,
    ),
    expected: "Error: source read failed (code=EIO, errcode=10)",
  })),
])("preserves $name", async ({ failure, expected }) => {
  throwOnRead(failure);
  await expect(verifyOpenClawDatabase(target)).resolves.toEqual(failed(expected));
});

it("bounds cyclic and deep causes without serializing their prose", async () => {
  const cycle = Object.assign(new Error("cyclic failure"), { code: "EIO", errcode: 10 });
  cycle.cause = { code: "EIO", errcode: 10, cause: cycle };
  let deep: unknown = { code: "BEYOND_LIMIT", errcode: 99, message: "private cause prose" };
  for (let index = 7; index >= 0; index -= 1) {
    deep = Object.assign(new Error("deep failure", { cause: deep }), { errcode: index });
  }
  throwOnRead(cycle);
  throwOnRead(deep);

  const results = [await verifyOpenClawDatabase(target), await verifyOpenClawDatabase(target)];
  expect(results).toEqual([
    failed("Error: cyclic failure (code=EIO, errcode=10)"),
    failed(
      "Error: deep failure (errcode=0, errcode=1, errcode=2, errcode=3, errcode=4, errcode=5, errcode=6, errcode=7)",
    ),
  ]);
});

it.each([
  { name: "original I/O failure before close failure", errcode: 10, terminal: false },
  { name: "original corruption before close failure", errcode: 779, terminal: true },
])("preserves $name and classification", async ({ errcode, terminal }) => {
  const database = nodeSqlite.openNodeSqliteDatabase(":memory:");
  vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockReturnValueOnce(database);
  vi.spyOn(database, "prepare").mockImplementationOnce(() => {
    throw Object.assign(new Error("scan failed"), { code: "ERR_SQLITE_ERROR", errcode });
  });
  const close = database.close.bind(database);
  vi.spyOn(database, "close").mockImplementationOnce(() => {
    close();
    throw Object.assign(new Error("close failed"), { code: "EIO", errcode: 10 });
  });
  const expected = `SqliteIntegrityError: SQLite quick_check failed for fixture: scan failed (code=ERR_SQLITE_ERROR, errcode=${errcode})`;
  try {
    expect(await verifyOpenClawDatabase(target)).toEqual(failed(expected, terminal));
    expect(database.isOpen).toBe(false);
  } finally {
    if (database.isOpen) {
      close();
    }
  }
});
