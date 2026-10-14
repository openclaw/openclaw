// Covers the compile-only Kysely facade used by sync node:sqlite helpers.
import { spawnSync } from "node:child_process";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { sql, type ColumnType, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { registerNodeSqliteKyselyQueryErrorHandler } from "./kysely-sync-cache-state.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  compileSqliteQueryBindings,
  enableNodeSqliteKyselyStatementCache,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  prepareSqliteQueryIterator,
  prepareSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
  sqliteStringSet,
} from "./kysely-sync.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { assertNoActiveSqliteReaders, withSqliteReaderOwner } from "./sqlite-reader-lifecycle.js";
import { storageProcessTestEntrypoints } from "./storage-process-runtime.test-support.js";

type SyncHelperTestDatabase = {
  items: {
    id: ColumnType<number, number | bigint | undefined, number | bigint>;
    name: string;
  };
};

describe("kysely sync helpers", () => {
  let database: DatabaseSync;
  let db: Kysely<SyncHelperTestDatabase>;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    db = getNodeSqliteKysely<SyncHelperTestDatabase>(database);
  });

  afterEach(() => {
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
  });

  it("stops first-row selects without evaluating later rows and releases the reader", () => {
    database.exec(
      "create table items (id integer primary key, name text not null); insert into items values (1, 'Ada'), (2, 'Grace'), (3, 'Lin')",
    );
    enableNodeSqliteKyselyStatementCache(database);

    const visited: number[] = [];
    database.function("visit", (id) => {
      visited.push(Number(id));
      return id;
    });
    const select = db.selectFrom("items").select(db.fn<number>("visit", ["id"]).as("id"));
    for (let attempt = 0; attempt < 3; attempt++) {
      visited.length = 0;
      expect(executeSqliteQueryTakeFirstSync(database, select)).toEqual({ id: 1 });
      expect(visited).toEqual([1]);
    }
    database.exec("drop table items");
    database.exec("create table items (id integer primary key, name text not null)");
    expect(executeSqliteQueryTakeFirstSync(database, select)).toBeUndefined();
  });

  it("retains 64-bit insert identities without breaking later writes or numeric reads", () => {
    database.exec("create table items (id integer primary key, name text not null)");
    enableNodeSqliteKyselyStatementCache(database);

    const id = 9007199254740993n;
    const inserted = executeSqliteQuerySync(
      database,
      db.insertInto("items").values({ id, name: "original" }),
    );
    expect(inserted).toEqual({ insertId: id, numAffectedRows: 1n, rows: [] });
    for (const name of ["first", "second", "third"]) {
      expect(executeSqliteQuerySync(database, db.updateTable("items").set({ name }))).toEqual({
        numAffectedRows: 1n,
        rows: [],
      });
      expect(
        executeSqliteQueryTakeFirstSync(
          database,
          db.selectFrom("items").select((eb) => eb.fn.countAll<number>().as("count")),
        ),
      ).toEqual({ count: 1 });
    }
    expect(executeSqliteQuerySync(database, db.deleteFrom("items"))).toEqual({
      numAffectedRows: 1n,
      rows: [],
    });
  });

  it("preserves raw readers and distinguishes writes with and without returned rows", () => {
    database.exec(
      "create table items (id integer primary key, name text not null); insert into items (id, name) values (1, 'Ada'); pragma user_version = 42",
    );

    const pragma = { compile: () => sql`pragma user_version`.compile(db) };

    expect(executeSqliteQuerySync(database, pragma).rows).toEqual([{ user_version: 42 }]);
    expect([...iterateSqliteQuerySync(database, pragma)]).toEqual([{ user_version: 42 }]);
    expect(prepareSqliteQueryTakeFirstSync(database, () => pragma)(undefined)).toEqual({
      user_version: 42,
    });

    const update = db.updateTable("items").set({ name: "Grace" }).where("id", "=", 1);
    expect([...iterateSqliteQuerySync(database, update)]).toEqual([]);
    expect(executeSqliteQueryTakeFirstSync(database, db.selectFrom("items").selectAll())).toEqual({
      id: 1,
      name: "Ada",
    });
    expect(executeSqliteQuerySync(database, update)).toEqual({ rows: [], numAffectedRows: 1n });
    expect([...iterateSqliteQuerySync(database, update.returningAll())]).toEqual([
      { id: 1, name: "Grace" },
    ]);
    const visited: number[] = [];
    database.function("visit", (id) => {
      visited.push(Number(id));
      return id;
    });
    database.exec("insert into items (id, name) values (2, 'Lin')");
    const rawRows = {
      // Raw readers share the completion path with writes; selecting a first result must drain them.
      compile: () => sql`select visit(id) as id from items order by id`.compile(db),
    };
    expect(prepareSqliteQueryTakeFirstSync(database, () => rawRows)(undefined)).toEqual({ id: 1 });
    expect(visited).toEqual([1, 2]);
  });

  it("binds changing values without confusing repeated bindings and literal parameters", () => {
    const { compiled, bind } = compileSqliteQueryBindings<{
      name: string | null;
      bytes: Uint8Array;
      count: bigint;
    }>((parameter) => {
      const name = parameter((input) => input.name);
      return db.selectNoFrom([
        name.as("name"),
        name.as("repeated"),
        sql.val("literal").as("literal"),
        parameter((input) => input.bytes).as("bytes"),
        parameter((input) => input.count).as("count"),
      ]);
    });
    const select = database.prepare(compiled.sql);
    for (const name of ["literal", "'); DROP TABLE items; --", null, "λ🦞"]) {
      const bytes = new Uint8Array([1, 2, 255]);
      expect(select.all(...bind({ name, bytes, count: 42n }))).toEqual([
        { name, repeated: name, literal: "literal", bytes, count: 42 },
      ]);
    }
  });

  it.each(["UTF-8", "UTF-16le", "UTF-16be"])(
    "preserves string binding and set semantics (%s)",
    (encoding) => {
      database.exec(`PRAGMA encoding = '${encoding}'`);
      database.exec("create table items (id integer primary key, name text not null unique)");
      const values = [
        "",
        "plain",
        "λ🦞",
        "\uFFFD",
        "nul",
        "nul\0tail",
        "\0",
        "\0\0",
        "\\u0000",
        "\\x00",
        "slash\\\0tail",
        "'); DROP TABLE items; --",
      ];
      for (const name of values) {
        executeSqliteQuerySync(database, db.insertInto("items").values({ name }));
      }
      for (const names of [
        [],
        values,
        ["plain", "plain"],
        ...values.map((value) => [value]),
        ["\uD800"],
        ["\uDC00"],
        ["absent"],
      ]) {
        const query = db.selectFrom("items").selectAll().orderBy("name");
        expect(
          executeSqliteQuerySync(database, query.where("name", "in", sqliteStringSet(names))).rows,
        ).toEqual(executeSqliteQuerySync(database, query.where("name", "in", names)).rows);
      }
    },
  );

  it.each(["eager", "iterator", "first"])(
    "keeps prepared query bindings independent during synchronous callback re-entry (%s)",
    (mode) => {
      enableNodeSqliteKyselyStatementCache(database);
      type Row = { nested: number; input: number };
      const build: Parameters<typeof prepareSqliteQuerySync<number, Row>>[1] = (parameter) => {
        const value = parameter((input) => input);
        return db.selectNoFrom([
          db.fn<number>("nested_value", [value]).as("nested"),
          value.as("input"),
        ]);
      };
      let read: (input: number) => Row[];
      if (mode === "first") {
        const select = prepareSqliteQueryTakeFirstSync<number, Row>(database, build);
        read = (input) => {
          const row = select(input);
          return row ? [row] : [];
        };
      } else if (mode === "eager") {
        const select = prepareSqliteQuerySync<number, Row>(database, build);
        read = (input) => select(input).rows;
      } else {
        const select = prepareSqliteQueryIterator<number, Row>(database, build);
        read = (input) => [...select(input)];
      }
      database.function("nested_value", (value) => {
        const input = Number(value);
        return input === 0 ? 0 : read(input - 1)[0]!.nested + 1;
      });
      for (const input of [2, 3, 4]) {
        expect(read(input)).toEqual([{ nested: input, input }]);
      }
    },
  );

  it.each(["eager", "first"])("completes prepared writes returning rows (%s)", (mode) => {
    database.exec(
      "create table items (id integer primary key, name text not null); insert into items values (1, 'Ada'), (2, 'Grace')",
    );

    const build: Parameters<
      typeof prepareSqliteQuerySync<string, { id: number; name: string }>
    >[1] = (parameter) =>
      db
        .updateTable("items")
        .set({ name: parameter((name) => name) })
        .returningAll();
    const update =
      mode === "first"
        ? prepareSqliteQueryTakeFirstSync(database, build)
        : prepareSqliteQuerySync(database, build);
    for (const name of ["Lin", "Katherine"]) {
      const rows = [
        { id: 1, name },
        { id: 2, name },
      ];
      expect(update(name)).toEqual(mode === "first" ? rows[0] : { rows });
      expect(
        executeSqliteQuerySync(database, db.selectFrom("items").selectAll().orderBy("id")).rows,
      ).toEqual(rows);
    }
  });

  it.each(["eager", "first"])("leaves the database usable after a binding failure (%s)", (mode) => {
    const failure = new Error("binding rejected");
    const observed: unknown[] = [];
    registerNodeSqliteKyselyQueryErrorHandler(database, (error) => observed.push(error));
    const build: Parameters<typeof prepareSqliteQuerySync<string, { value: string }>>[1] = (
      parameter,
    ) =>
      db.selectNoFrom(
        parameter((value) => {
          if (value === "reject") {
            throw failure;
          }
          return value;
        }).as("value"),
      );
    const read =
      mode === "first"
        ? prepareSqliteQueryTakeFirstSync(database, build)
        : prepareSqliteQuerySync(database, build);
    expect(captureError(() => read("reject"))).toBe(failure);
    expect(observed).toEqual([]);
    expect(read("accepted")).toEqual(
      mode === "first" ? { value: "accepted" } : { rows: [{ value: "accepted" }] },
    );
  });

  it("admits only repeated SQL and bounds the prepared statement working set", () => {
    database.exec("create table items (id integer primary key, name text not null)");

    const prepares = countPrepares(database);
    const variableSelect = (parameterCount: number) =>
      db
        .selectFrom("items")
        .selectAll()
        .where(
          "id",
          "not in",
          Array.from({ length: parameterCount }, (_, index) => index + 1),
        );

    for (let parameterCount = 1; parameterCount <= 128; parameterCount += 1) {
      expect(executeSqliteQuerySync(database, variableSelect(parameterCount)).rows).toEqual([]);
      expect(executeSqliteQuerySync(database, variableSelect(parameterCount)).rows).toEqual([]);
    }
    expect(prepares.calls()).toBe(256);

    for (let parameterCount = 65; parameterCount <= 128; parameterCount += 1) {
      expect(executeSqliteQuerySync(database, variableSelect(parameterCount)).rows).toEqual([]);
    }
    expect(prepares.calls()).toBe(256);

    for (let parameterCount = 1; parameterCount <= 64; parameterCount += 1) {
      expect(executeSqliteQuerySync(database, variableSelect(parameterCount)).rows).toEqual([]);
    }
    expect(prepares.calls()).toBe(320);
  });

  it("does not retain one-shot variable-cardinality SQL statements", () => {
    database.exec("create table items (id integer primary key, name text not null)");

    const prepares = countPrepares(database);
    const runVariableSelects = () => {
      for (let parameterCount = 1; parameterCount <= 128; parameterCount += 1) {
        const ids = Array.from({ length: parameterCount }, (_, index) => index + 1);
        const select = db.selectFrom("items").selectAll().where("id", "not in", ids);
        expect(executeSqliteQuerySync(database, select).rows).toEqual([]);
      }
    };

    runVariableSelects();
    runVariableSelects();
    runVariableSelects();
    expect(prepares.calls()).toBe(384);
  });

  it("keeps nested prepared lazy iterations independent", () => {
    database.exec(
      "create table items (id integer primary key autoincrement, name text not null unique)",
    );

    for (const name of ["Ada", "Grace", "Lin"]) {
      executeSqliteQuerySync(database, db.insertInto("items").values({ name }));
    }
    const select = db.selectFrom("items").selectAll().orderBy("id");
    const read = prepareSqliteQueryIterator<{ from: number }, { id: number; name: string }>(
      database,
      (parameter) =>
        select.where(
          "id",
          ">=",
          parameter((input) => input.from),
        ),
    );
    const prepares = countPrepares(database);

    expect([...read({ from: 1 })]).toHaveLength(3);
    expect([...read({ from: 1 })]).toHaveLength(3);

    const input = { from: 2 };
    const outer = read(input);
    input.from = 3;
    const inner = read({ from: 1 });
    read({ from: 4 }).return?.();
    expect(prepares.calls()).toBe(2);
    expect(outer.next()).toEqual({ done: false, value: { id: 2, name: "Grace" } });
    expect(inner.next()).toEqual({ done: false, value: { id: 1, name: "Ada" } });
    outer.return?.();
    expect([...inner]).toEqual([
      { id: 2, name: "Grace" },
      { id: 3, name: "Lin" },
    ]);
    expect(prepares.calls()).toBe(4);
    database.exec("drop table items");
  });

  it("attributes active lazy readers and releases them after early return", () => {
    database.exec(
      "create table items (id integer primary key, name text not null); insert into items values (1, 'Ada'), (2, 'Grace')",
    );

    const iterator = withSqliteReaderOwner(
      { operation: "fixture.rows", ownerKind: "worker", actorId: 7 },
      () => iterateSqliteQuerySync(database, db.selectFrom("items").selectAll().orderBy("id")),
    );

    expect(iterator.next()).toEqual({ done: false, value: { id: 1, name: "Ada" } });
    expect(() => assertNoActiveSqliteReaders(database, "fixture worker")).toThrow(
      "oldest operation=fixture.rows",
    );

    iterator.return?.();
    expect(() => assertNoActiveSqliteReaders(database, "fixture worker")).not.toThrow();
  });

  it("invalidates prepared statements when the SQLite authorizer changes", () => {
    if (typeof database.setAuthorizer !== "function") {
      return;
    }
    database.exec("create table items (id integer primary key, name text not null)");
    database.exec("insert into items (id, name) values (1, 'Ada')");
    const select = db.selectFrom("items").selectAll();
    const prepares = countPrepares(database);

    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(prepares.calls()).toBe(2);

    database.setAuthorizer((actionCode, tableName) =>
      actionCode === constants.SQLITE_READ && tableName === "items"
        ? constants.SQLITE_IGNORE
        : constants.SQLITE_OK,
    );
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: null, name: null }]);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: null, name: null }]);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: null, name: null }]);
    expect(prepares.calls()).toBe(5);

    database.setAuthorizer(null);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(prepares.calls()).toBe(6);
  });

  it("does not cache while a dynamic SQLite authorizer is installed", () => {
    if (typeof database.setAuthorizer !== "function") {
      return;
    }
    database.exec("create table items (id integer primary key, name text not null)");
    database.exec("insert into items (id, name) values (1, 'Ada')");
    const select = db.selectFrom("items").selectAll();
    const prepares = countPrepares(database);
    let allow = true;
    database.setAuthorizer(() => (allow ? constants.SQLITE_OK : constants.SQLITE_DENY));

    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(prepares.calls()).toBe(3);

    allow = false;
    expect(() => executeSqliteQuerySync(database, select)).toThrow(/not authorized/iu);
    expect(prepares.calls()).toBe(4);
  });

  it("does not retain oversized statement parameters", () => {
    const lengthOf = (value: string) =>
      db.selectNoFrom((eb) => eb.fn<number>("length", [eb.val(value)]).as("value"));
    const prepares = countPrepares(database);

    expect(executeSqliteQuerySync(database, lengthOf("small")).rows).toEqual([{ value: 5 }]);
    expect(executeSqliteQuerySync(database, lengthOf("small")).rows).toEqual([{ value: 5 }]);
    expect(executeSqliteQuerySync(database, lengthOf("small")).rows).toEqual([{ value: 5 }]);
    expect(prepares.calls()).toBe(2);

    for (const oversized of ["x".repeat(64 * 1024 + 1), "漢".repeat(24 * 1024)]) {
      const before = prepares.calls();
      expect(executeSqliteQuerySync(database, lengthOf(oversized)).rows).toEqual([
        { value: oversized.length },
      ]);
      expect(prepares.calls()).toBe(before + 1);
      expect(executeSqliteQuerySync(database, lengthOf("small")).rows).toEqual([{ value: 5 }]);
      expect(prepares.calls()).toBe(before + 1);
    }

    const oversizedExpression =
      /* kysely-allow-raw: this fixed generated SQL comment exercises statement-text admission, not parameter size. */ sql.raw<number>(
        `1 /*${"x".repeat(64 * 1024)}*/`,
      );
    const oversizedSql = db.selectNoFrom(oversizedExpression.as("value"));
    expect(executeSqliteQuerySync(database, oversizedSql).rows).toEqual([{ value: 1 }]);
    expect(executeSqliteQuerySync(database, oversizedSql).rows).toEqual([{ value: 1 }]);
    expect(prepares.calls()).toBe(6);
  });

  it("invalidates prepared statements when the database is deserialized", () => {
    database.exec("create table items (id integer primary key, name text not null)");
    database.exec("insert into items (id, name) values (1, 'Ada')");
    let replacementBytes = new Uint8Array();
    if (typeof database.deserialize === "function") {
      const replacement = new DatabaseSync(":memory:");
      replacement.exec("create table items (id integer primary key, name text not null)");
      replacement.exec("insert into items (id, name) values (2, 'Grace')");
      replacementBytes = replacement.serialize();
      replacement.close();
    } else {
      Object.defineProperty(database, "deserialize", {
        configurable: true,
        value(this: DatabaseSync): void {
          this.exec("delete from items");
          this.exec("insert into items (id, name) values (2, 'Grace')");
        },
      });
    }
    const select = db.selectFrom("items").selectAll();
    const prepares = countPrepares(database);

    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(prepares.calls()).toBe(2);

    database.deserialize(replacementBytes);

    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 2, name: "Grace" }]);
    expect(prepares.calls()).toBe(3);
  });

  it.each(["eager", "first"])("reads current columns without allocating metadata (%s)", (mode) => {
    database.exec("create table items (id integer primary key, name text not null)");
    database.exec("insert into items (id, name) values (1, 'Ada')");
    const select = db.selectFrom("items").selectAll();
    const prepares = countPrepares(database);
    const columns = vi.spyOn(StatementSync.prototype, "columns");
    const read = () =>
      mode === "eager"
        ? executeSqliteQuerySync(database, select).rows
        : [executeSqliteQueryTakeFirstSync(database, select)];
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(read()).toEqual([{ id: 1, name: "Ada" }]);
      }
      expect(prepares.calls()).toBe(2);

      database.exec("alter table items add column note text not null default 'new'");

      expect(read()).toEqual([{ id: 1, name: "Ada", note: "new" }]);
      expect(prepares.calls()).toBe(2);
      expect(columns).not.toHaveBeenCalled();
    } finally {
      columns.mockRestore();
    }
  });

  it("resets a cached row statement after a step-time error", () => {
    const jsonValue = (value: string) =>
      db.selectNoFrom((eb) => eb.fn<string>("json", [eb.val(value)]).as("value"));
    const prepares = countPrepares(database);

    expect(executeSqliteQuerySync(database, jsonValue("{}")).rows).toEqual([{ value: "{}" }]);
    expect(executeSqliteQuerySync(database, jsonValue("{}")).rows).toEqual([{ value: "{}" }]);
    expect(executeSqliteQuerySync(database, jsonValue("{}")).rows).toEqual([{ value: "{}" }]);
    expect(prepares.calls()).toBe(2);

    expect(() => executeSqliteQuerySync(database, jsonValue("{"))).toThrow(/malformed JSON/iu);
    expect(executeSqliteQuerySync(database, jsonValue("[]")).rows).toEqual([{ value: "[]" }]);
    expect(prepares.calls()).toBe(2);
  });

  it.each(["eager", "lazy"])(
    "reports query failures without replacing the original database error (%s)",
    (mode) => {
      const malformedJson = db.selectNoFrom((eb) =>
        eb.fn<string>("json", [eb.val("{")]).as("value"),
      );
      const observed: unknown[] = [];
      registerNodeSqliteKyselyQueryErrorHandler(database, (error) => {
        observed.push(error);
        throw new Error("handler failure");
      });

      const thrown = captureError(() => {
        if (mode === "eager") {
          executeSqliteQuerySync(database, malformedJson);
        } else {
          Array.from(iterateSqliteQuerySync(database, malformedJson));
        }
      });

      expect(observed).toEqual([thrown]);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/malformed JSON/iu);
    },
  );

  it.each(["before", "after"] as const)(
    "preserves double-close errors with caching installed %s close",
    (when) => {
      const baseline = new DatabaseSync(":memory:");
      expect(baseline.close()).toBeUndefined();
      const baselineError = captureError(() => baseline.close());
      const cached = new DatabaseSync(":memory:");
      if (when === "before") {
        enableNodeSqliteKyselyStatementCache(cached);
      }
      expect(cached.close()).toBeUndefined();
      if (when === "after") {
        enableNodeSqliteKyselyStatementCache(cached);
      }
      expect(errorShape(captureError(() => cached.close()))).toEqual(errorShape(baselineError));
    },
  );

  it("clears cached statements before propagating a close failure", () => {
    const cached = new DatabaseSync(":memory:");
    cached.exec("create table items (id integer primary key, name text not null)");
    cached.exec("insert into items (id, name) values (1, 'Ada')");
    const closeError = new Error("synthetic close failure");
    Object.defineProperty(cached, "close", {
      configurable: true,
      writable: true,
      value(): never {
        throw closeError;
      },
    });
    const cachedDb = getNodeSqliteKysely<SyncHelperTestDatabase>(cached);
    const select = cachedDb.selectFrom("items").selectAll();
    const prepares = countPrepares(cached);

    try {
      expect(executeSqliteQuerySync(cached, select).rows).toEqual([{ id: 1, name: "Ada" }]);
      expect(executeSqliteQuerySync(cached, select).rows).toEqual([{ id: 1, name: "Ada" }]);
      expect(executeSqliteQuerySync(cached, select).rows).toEqual([{ id: 1, name: "Ada" }]);
      expect(prepares.calls()).toBe(2);

      expect(() => cached.close()).toThrow(closeError);
      expect(executeSqliteQuerySync(cached, select).rows).toEqual([{ id: 1, name: "Ada" }]);
      expect(prepares.calls()).toBe(3);
    } finally {
      clearNodeSqliteKyselyCacheForDatabase(cached);
      delete (cached as { close?: DatabaseSync["close"] }).close;
      cached.close();
    }
  });

  it.each([
    ["clear-and-close", true, 2],
    ["close", true, 2],
    ["drop", false, 1],
  ] as const)(
    "collects only released native resources after %s",
    (cleanup, databaseCollected, statementsCollected) => {
      expect(runRetentionScenario({ cleanup })).toEqual({
        databaseCollected,
        statementsCollected,
        statementCount: 2,
      });
    },
  );

  it.skipIf(typeof DatabaseSync.prototype[Symbol.dispose] !== "function")(
    "allows databases and prepared statements to collect after disposal",
    () => {
      expect(runRetentionScenario({ cleanup: "dispose" })).toEqual({
        databaseCollected: true,
        statementsCollected: 2,
        statementCount: 2,
      });
    },
  );

  it("keeps the builder facade compile-only and fails direct execution", async () => {
    database.exec("create table items (id integer primary key, name text not null)");

    executeSqliteQuerySync(database, db.insertInto("items").values({ id: 1, name: "Ada" }));
    expect(executeSqliteQuerySync(database, db.selectFrom("items").selectAll()).rows).toEqual([
      { id: 1, name: "Ada" },
    ]);

    const compileOnlyError = /compile-only Kysely facade/;
    await expect(db.selectFrom("items").selectAll().execute()).rejects.toThrow(compileOnlyError);
    await expect(db.insertInto("items").values({ id: 2, name: "Grace" }).execute()).rejects.toThrow(
      compileOnlyError,
    );
    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto("items").values({ id: 3, name: "Lin" }).execute();
      }),
    ).rejects.toThrow(compileOnlyError);
    await expectCompileOnlyRejection(db.startTransaction().execute());
    await expectCompileOnlyRejection(consumeStream(db.selectFrom("items").selectAll().stream()));
    await expectCompileOnlyRejection(db.selectFrom("items").selectAll().execute());

    expect(
      executeSqliteQuerySync(database, db.selectFrom("items").select(["id", "name"])).rows,
    ).toEqual([{ id: 1, name: "Ada" }]);
  });
});

function countPrepares(database: DatabaseSync): { calls: () => number } {
  enableNodeSqliteKyselyStatementCache(database);
  const originalPrepare = database.prepare.bind(database);
  let calls = 0;
  database.prepare = (sqlText, options) => {
    calls += 1;
    return originalPrepare(sqlText, options);
  };
  return { calls: () => calls };
}

function captureError(operation: () => void): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to throw");
}

function errorShape(error: unknown): { code: string | undefined; message: string; name: string } {
  expect(error).toBeInstanceOf(Error);
  const sqliteError = error as Error & { code?: string };
  return {
    code: sqliteError.code,
    message: sqliteError.message,
    name: sqliteError.name,
  };
}

function runRetentionScenario(options: {
  cleanup: "clear-and-close" | "close" | "dispose" | "drop";
}): {
  databaseCollected: boolean;
  statementsCollected: number;
  statementCount: number;
} {
  const moduleUrl = resolveRuntimeWorkerUrl(storageProcessTestEntrypoints.kyselySync);
  const cleanup = {
    "clear-and-close": `
        clearNodeSqliteKyselyCacheForDatabase(database);
        database.close();
      `,
    close: "database.close();",
    dispose: "database[Symbol.dispose]();",
    drop: "",
  }[options.cleanup];
  const script = `
    import { DatabaseSync } from "node:sqlite";
    import {
      clearNodeSqliteKyselyCacheForDatabase,
      enableNodeSqliteKyselyStatementCache,
      executeSqliteQuerySync,
      getNodeSqliteKysely,
    } from ${JSON.stringify(moduleUrl.href)};

    const waitForTurn = () => new Promise((resolve) => setImmediate(resolve));
    async function runScenario() {
      let database = new DatabaseSync(":memory:");
      database.exec("create table items (id integer primary key, name text not null)");
      const databaseRef = new WeakRef(database);
      const statementRefs = [];
      const originalPrepare = DatabaseSync.prototype.prepare;
      database.prepare = function (sql, prepareOptions) {
        const statement = originalPrepare.call(this, sql, prepareOptions);
        statementRefs.push(new WeakRef(statement));
        return statement;
      };
      const db = getNodeSqliteKysely(database);
      enableNodeSqliteKyselyStatementCache(database);
      const select = db.selectFrom("items").selectAll().orderBy("id");
      executeSqliteQuerySync(database, select);
      executeSqliteQuerySync(database, select);
      executeSqliteQuerySync(database, select);
      delete database.prepare;
      ${cleanup}
      database = undefined;

      for (let attempt = 0; attempt < 30; attempt += 1) {
        await waitForTurn();
        globalThis.gc();
      }
      return {
        databaseCollected: databaseRef.deref() === undefined,
        statementsCollected: statementRefs.filter((ref) => ref.deref() === undefined).length,
        statementCount: statementRefs.length,
      };
    }

    process.stdout.write(JSON.stringify(await runScenario()), () => process.exit(0));
  `;
  const result = spawnSync(
    // These scenarios lock Node's native statement-to-database retention contract.
    resolveTestNodeExecPath(),
    [
      "--disable-warning=ExperimentalWarning",
      "--expose-gc",
      ...resolveRuntimeWorkerArgv(moduleUrl, resolveTestNodeExecPath()).slice(0, -1),
      "--input-type=module",
      "--eval",
      script,
    ],
    { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 },
  );

  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as {
    databaseCollected: boolean;
    statementsCollected: number;
    statementCount: number;
  };
}

async function expectCompileOnlyRejection(promise: Promise<unknown>): Promise<void> {
  await expect(
    withTestTimeout(promise, 500, "timed out waiting for compile-only rejection"),
  ).rejects.toThrow(/compile-only Kysely facade/);
}

async function consumeStream<Row>(stream: AsyncIterableIterator<Row>): Promise<Row[]> {
  const rows: Row[] = [];
  for await (const row of stream) {
    rows.push(row);
  }
  return rows;
}
