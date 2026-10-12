import { expect, expectTypeOf, it, vi } from "vitest";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  openNodeSqliteDatabase,
  prepareSqliteQuerySync,
  runSqliteImmediateTransaction,
  runSqliteImmediateTransactionSync,
} from "./sqlite-runtime.js";

// Released v2026.9.9 callers retain native callback visibility and result inference.
it("keeps the released raw SDK transaction synchronous through its deprecation window", async () => {
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const database = openNodeSqliteDatabase(":memory:");
  try {
    database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    const query = getNodeSqliteKysely<{ items: { id: number; value: string } }>(database);
    const lookup = prepareSqliteQuerySync<{ id: number }, { value: string }>(
      database,
      (parameter) =>
        query
          .selectFrom("items")
          .select("value")
          .where(
            "id",
            "=",
            parameter((input) => input.id),
          ),
    );
    const returned = runSqliteImmediateTransactionSync(database, () => {
      executeSqliteQuerySync(database, query.insertInto("items").values({ id: 1, value: "first" }));
      const inside = executeSqliteQueryTakeFirstSync(
        database,
        query.selectFrom("items").selectAll(),
      );
      expectTypeOf(inside).toEqualTypeOf<{ id: number; value: string } | undefined>();
      expect(inside?.value).toBe("first");
      return 42;
    });
    expectTypeOf(returned).toEqualTypeOf<number>();
    expect(returned).toBe(42);
    expect(database.isTransaction).toBe(false);
    expect(lookup({ id: 1 }).rows).toEqual([{ value: "first" }]);
    expect(() =>
      runSqliteImmediateTransactionSync(database, () => {
        database.prepare("UPDATE items SET value = ?").run("rolled back");
        throw new Error("refused");
      }),
    ).toThrow("refused");
    const prepared = await runSqliteImmediateTransaction(database, async () => () => {
      database.prepare("UPDATE items SET value = ?").run("prepared");
      return "committed";
    });
    expect(prepared).toBe("committed");
    expect([...iterateSqliteQuerySync(database, query.selectFrom("items").selectAll())]).toEqual([
      { id: 1, value: "prepared" },
    ]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("removed in the next Plugin SDK major"),
      { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
    );
  } finally {
    database.close();
    warning.mockRestore();
  }
});
