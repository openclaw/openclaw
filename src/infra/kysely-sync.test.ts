import { spawnSync } from "node:child_process";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { sql, type ColumnType, type Kysely, type Compilable } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureThrown } from "../../test/helpers/capture-thrown.js";
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
  prepareSqliteTerminalWrite,
  sqliteStringSet,
} from "./kysely-sync.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { withSqlitePostCommitPublications } from "./sqlite-post-commit.js";
import { assertNoActiveSqliteReaders, withSqliteReaderOwner } from "./sqlite-reader-lifecycle.js";
import { storageProcessTestEntrypoints } from "./storage-process-runtime.test-support.js";

type SyncHelperTestDatabase = {
  items: {
    id: ColumnType<number, number | bigint | undefined, number | bigint>;
    name: string;
  };
};
type Item = { id: number; name: string };
type RetentionResult = {
  databaseCollected: boolean;
  statementsCollected: number;
  statementCount: number;
};

describe("kysely sync helpers", () => {
  let database: DatabaseSync;
  let db: Kysely<SyncHelperTestDatabase>;

  const run = <Row>(query: Compilable<Row>) => executeSqliteQuerySync(database, query);
  const first = <Row>(query: Compilable<Row>) => executeSqliteQueryTakeFirstSync(database, query);
  const selectItems = () => db.selectFrom("items").selectAll();
  function createItems(names: string[] = [], connection = database, constraint = "") {
    connection.exec(
      `create table items (id integer primary key, name text not null ${constraint})`,
    );
    names.forEach((name, index) => {
      connection.prepare("insert into items values (?, ?)").run(index + 1, name);
    });
  }
  function trackVisits() {
    const visited: number[] = [];
    database.function("visit", (id) => {
      visited.push(Number(id));
      return id;
    });
    return visited;
  }
  const itemRows = (...names: string[]) => names.map((name, index) => ({ id: index + 1, name }));
  function expectRows<Row>(query: Compilable<Row>, rows: unknown, times = 1) {
    for (let attempt = 0; attempt < times; attempt++) {
      expect(run(query).rows).toEqual(rows);
    }
  }
  function cachedRows() {
    const prepares = countPrepares(database);
    const query = selectItems();
    return (rows: unknown, calls: number, times = 1) => {
      expectRows(query, rows, times);
      expect(prepares()).toBe(calls);
    };
  }
  const scalar = <Value>(name: string, value: string) =>
    db.selectNoFrom((eb) => eb.fn<Value>(name, [eb.val(value)]).as("value"));
  function variableSelect(parameterCount: number) {
    return selectItems().where(
      "id",
      "not in",
      Array.from({ length: parameterCount }, (_, index) => index + 1),
    );
  }
  function prepare<Params, Row>(
    mode: string,
    build: Parameters<typeof prepareSqliteQuerySync<Params, Row>>[1],
  ) {
    return mode === "first"
      ? prepareSqliteQueryTakeFirstSync(database, build)
      : prepareSqliteQuerySync(database, build);
  }

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    db = getNodeSqliteKysely<SyncHelperTestDatabase>(database);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
  });

  it("stops first-row selects without evaluating later rows and releases the reader", () => {
    createItems(["Ada", "Grace", "Lin"]);
    enableNodeSqliteKyselyStatementCache(database);

    const visited = trackVisits();
    const select = db.selectFrom("items").select(db.fn<number>("visit", ["id"]).as("id"));
    for (let attempt = 0; attempt < 3; attempt++) {
      visited.length = 0;
      expect(first(select)).toEqual({ id: 1 });
      expect(visited).toEqual([1]);
    }
    database.exec("drop table items");
    createItems();
    expect(first(select)).toBeUndefined();
  });

  it("retains 64-bit insert identities without breaking later writes or numeric reads", () => {
    createItems();
    enableNodeSqliteKyselyStatementCache(database);

    const id = 9007199254740993n;
    expect(run(db.insertInto("items").values({ id, name: "original" }))).toEqual({
      insertId: id,
      numAffectedRows: 1n,
      rows: [],
    });
    for (const name of ["first", "second", "third"]) {
      expect(run(db.updateTable("items").set({ name }))).toEqual({ numAffectedRows: 1n, rows: [] });
      expect(
        first(db.selectFrom("items").select((eb) => eb.fn.countAll<number>().as("count"))),
      ).toEqual({ count: 1 });
    }
    expect(run(db.deleteFrom("items"))).toEqual({ numAffectedRows: 1n, rows: [] });
  });

  it("settles terminal writes before fallible native statement cleanup", () => {
    createItems();
    const nativePrepare = database.prepare.bind(database);
    let cleanupCalls = 0;
    vi.spyOn(database, "prepare").mockImplementation((query) => {
      const statement = nativePrepare(query);
      const dispose = statement[Symbol.dispose]?.bind(statement);
      Object.defineProperty(statement, Symbol.dispose, {
        configurable: true,
        value() {
          dispose?.();
          cleanupCalls += 1;
          throw new Error("synthetic statement cleanup failure");
        },
      });
      return statement;
    });
    const write = prepareSqliteTerminalWrite<{ id: bigint; name: string }>(database, (parameter) =>
      db.insertInto("items").values({
        id: parameter((row) => row.id),
        name: parameter((row) => row.name),
      }),
    );
    expect(() =>
      withSqlitePostCommitPublications(database, () => {
        write({ id: 9007199254740993n, name: "committed" });
        expect(cleanupCalls).toBe(0);
      }),
    ).not.toThrow();
    expect(cleanupCalls).toBe(1);
    expect(nativePrepare("select name from items").get()).toEqual({ name: "committed" });
  });

  it("preserves raw readers and distinguishes writes with and without returned rows", () => {
    createItems(["Ada"]);
    database.exec("pragma user_version = 42");

    const pragma = { compile: () => sql`pragma user_version`.compile(db) };

    expectRows(pragma, [{ user_version: 42 }]);
    expect([...iterateSqliteQuerySync(database, pragma)]).toEqual([{ user_version: 42 }]);
    expect(prepareSqliteQueryTakeFirstSync(database, () => pragma)(undefined)).toEqual({
      user_version: 42,
    });

    const update = db.updateTable("items").set({ name: "Grace" }).where("id", "=", 1);
    expect([...iterateSqliteQuerySync(database, update)]).toEqual([]);
    expect(first(selectItems())).toEqual(itemRows("Ada")[0]);
    expect(run(update)).toEqual({ rows: [], numAffectedRows: 1n });
    expect([...iterateSqliteQuerySync(database, update.returningAll())]).toEqual(itemRows("Grace"));
    const visited = trackVisits();
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
      createItems([], database, "unique");
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
        run(db.insertInto("items").values({ name }));
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
        const query = selectItems().orderBy("name");
        expectRows(
          query.where("name", "in", sqliteStringSet(names)),
          run(query.where("name", "in", names)).rows,
        );
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
        const select = prepareSqliteQueryTakeFirstSync(database, build);
        read = (input) => {
          const row = select(input);
          return row ? [row] : [];
        };
      } else if (mode === "eager") {
        const select = prepareSqliteQuerySync(database, build);
        read = (input) => select(input).rows;
      } else {
        const select = prepareSqliteQueryIterator(database, build);
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
    createItems(["Ada", "Grace"]);

    const build: Parameters<typeof prepareSqliteQuerySync<string, Item>>[1] = (parameter) =>
      db
        .updateTable("items")
        .set({ name: parameter((name) => name) })
        .returningAll();
    const update = prepare(mode, build);
    for (const name of ["Lin", "Katherine"]) {
      const rows = itemRows(name, name);
      expect(update(name)).toEqual(mode === "first" ? rows[0] : { rows });
      expectRows(selectItems().orderBy("id"), rows);
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
    const read = prepare(mode, build);
    expect(captureError(() => read("reject"))).toBe(failure);
    expect(observed).toEqual([]);
    expect(read("accepted")).toEqual(
      mode === "first" ? { value: "accepted" } : { rows: [{ value: "accepted" }] },
    );
  });

  it.each(["repeated SQL", "one-shot SQL"])("bounds the statement cache for %s", (mode) => {
    const passes: [number, number, number, number | null][] =
      mode === "repeated SQL"
        ? [
            [1, 128, 2, 256],
            [65, 128, 1, 256],
            [1, 64, 1, 320],
          ]
        : [
            [1, 128, 1, null],
            [1, 128, 1, null],
            [1, 128, 1, 384],
          ];
    createItems();
    const prepares = countPrepares(database);
    for (const [from, to, repeats, expected] of passes) {
      for (let count = from; count <= to; count++) {
        expectRows(variableSelect(count), [], repeats);
      }
      if (expected !== null) {
        expect(prepares()).toBe(expected);
      }
    }
  });

  it("keeps nested prepared lazy iterations independent", () => {
    createItems(["Ada", "Grace", "Lin"], database, "unique");
    const select = selectItems().orderBy("id");
    const read = prepareSqliteQueryIterator<{ from: number }, Item>(database, (parameter) =>
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
    expect(prepares()).toBe(2);
    expect(outer.next()).toEqual({ done: false, value: { id: 2, name: "Grace" } });
    expect(inner.next()).toEqual({ done: false, value: { id: 1, name: "Ada" } });
    outer.return?.();
    expect([...inner]).toEqual([
      { id: 2, name: "Grace" },
      { id: 3, name: "Lin" },
    ]);
    expect(prepares()).toBe(4);
    database.exec("drop table items");
  });

  it("attributes active lazy readers and releases them after early return", () => {
    createItems(["Ada", "Grace"]);

    const iterator = withSqliteReaderOwner(
      { operation: "fixture.rows", ownerKind: "worker", actorId: 7 },
      () => iterateSqliteQuerySync(database, selectItems().orderBy("id")),
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
    createItems(["Ada"]);
    const checkRows = cachedRows();
    checkRows(itemRows("Ada"), 2, 3);

    database.setAuthorizer((actionCode, tableName) =>
      actionCode === constants.SQLITE_READ && tableName === "items"
        ? constants.SQLITE_IGNORE
        : constants.SQLITE_OK,
    );
    checkRows([{ id: null, name: null }], 5, 3);

    database.setAuthorizer(null);
    checkRows(itemRows("Ada"), 6);
  });

  it("does not cache while a dynamic SQLite authorizer is installed", () => {
    if (typeof database.setAuthorizer !== "function") {
      return;
    }
    createItems(["Ada"]);
    const select = selectItems();
    const prepares = countPrepares(database);
    let allow = true;
    database.setAuthorizer(() => (allow ? constants.SQLITE_OK : constants.SQLITE_DENY));

    expectRows(select, itemRows("Ada"), 3);
    expect(prepares()).toBe(3);

    allow = false;
    expect(() => executeSqliteQuerySync(database, select)).toThrow(/not authorized/iu);
    expect(prepares()).toBe(4);
  });

  it("does not retain oversized statement parameters", () => {
    const lengthOf = (value: string) => scalar<number>("length", value);
    const prepares = countPrepares(database);

    expectRows(lengthOf("small"), [{ value: 5 }], 3);
    expect(prepares()).toBe(2);

    for (const oversized of ["x".repeat(64 * 1024 + 1), "漢".repeat(24 * 1024)]) {
      const before = prepares();
      expectRows(lengthOf(oversized), [{ value: oversized.length }]);
      expect(prepares()).toBe(before + 1);
      expectRows(lengthOf("small"), [{ value: 5 }]);
      expect(prepares()).toBe(before + 1);
    }

    const oversizedExpression =
      /* kysely-allow-raw: this fixed generated SQL comment exercises statement-text admission, not parameter size. */ sql.raw<number>(
        `1 /*${"x".repeat(64 * 1024)}*/`,
      );
    const oversizedSql = db.selectNoFrom(oversizedExpression.as("value"));
    expectRows(oversizedSql, [{ value: 1 }], 2);
    expect(prepares()).toBe(6);
  });

  // Explicit statement disposal is a public Node API starting in 26.8.
  it
    .skipIf(!Object.getOwnPropertyDescriptor(StatementSync.prototype, Symbol.dispose))
    .each(["uncached", "candidate", "oversized", "first", "iterator", "iterator-return", "error"])(
    "releases native bindings when a %s query settles",
    (mode) => {
      if (mode !== "uncached") {
        enableNodeSqliteKyselyStatementCache(database);
      }
      const prepareSpy = vi.spyOn(database, "prepare");
      const value = "x".repeat(mode === "oversized" ? 128 * 1024 : 1024);
      const query = scalar<number>(mode === "error" ? "json" : "length", value);
      if (mode === "error") {
        expect(() => run(query)).toThrow(/malformed JSON/iu);
      } else if (mode === "first") {
        expect(first(query)).toEqual({ value: value.length });
      } else if (mode.startsWith("iterator")) {
        const iterator = iterateSqliteQuerySync(database, query);
        expect(iterator.next().value).toEqual({ value: value.length });
        if (mode === "iterator-return") {
          iterator.return?.();
        } else {
          expect(iterator.next().done).toBe(true);
        }
      } else {
        expectRows(query, [{ value: value.length }]);
      }
      const statement = prepareSpy.mock.results[0]!.value as StatementSync;
      expect(() => statement.get(value)).toThrow(/finalized/iu);
    },
  );

  it.skipIf(!Object.getOwnPropertyDescriptor(StatementSync.prototype, Symbol.dispose))(
    "finalizes evicted and cleared statements while retaining reusable queries",
    () => {
      enableNodeSqliteKyselyStatementCache(database);
      const prepareSpy = vi.spyOn(database, "prepare");
      createItems(["Ada"]);
      prepareSpy.mockClear();
      const select = selectItems();
      expectRows(select, itemRows("Ada"), 3);
      const retained = prepareSpy.mock.results[1]!.value as StatementSync;
      expect(retained.all()).toEqual(itemRows("Ada"));
      for (let count = 1; count <= 64; count++) {
        expectRows(variableSelect(count), [], 2);
      }
      expect(() => retained.all()).toThrow(/finalized/iu);
      const last = prepareSpy.mock.results.at(-1)!.value as StatementSync;
      expect(last.all(...Array.from({ length: 64 }, (_, index) => index + 1))).toEqual([]);
      clearNodeSqliteKyselyCacheForDatabase(database);
      expect(() => last.all()).toThrow(/finalized/iu);
    },
  );

  it("invalidates prepared statements when the database is deserialized", () => {
    createItems(["Ada"]);
    let replacementBytes = new Uint8Array();
    if (typeof database.deserialize === "function") {
      const replacement = new DatabaseSync(":memory:");
      createItems([], replacement);
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
    const checkRows = cachedRows();
    checkRows(itemRows("Ada"), 2, 3);
    database.deserialize(replacementBytes);
    checkRows([{ id: 2, name: "Grace" }], 3);
  });

  it.each(["eager", "first"])("reads current columns without allocating metadata (%s)", (mode) => {
    createItems(["Ada"]);
    const select = selectItems();
    const prepares = countPrepares(database);
    const columns = vi.spyOn(StatementSync.prototype, "columns");
    const read = () => (mode === "eager" ? run(select).rows : [first(select)]);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(read()).toEqual(itemRows("Ada"));
    }
    expect(prepares()).toBe(2);
    database.exec("alter table items add column note text not null default 'new'");
    expect(read()).toEqual([{ id: 1, name: "Ada", note: "new" }]);
    expect(prepares()).toBe(2);
    expect(columns).not.toHaveBeenCalled();
  });

  it("resets a cached row statement after a step-time error", () => {
    const jsonValue = (value: string) => scalar<string>("json", value);
    const prepares = countPrepares(database);

    expectRows(jsonValue("{}"), [{ value: "{}" }], 3);
    expect(prepares()).toBe(2);

    expect(() => run(jsonValue("{"))).toThrow(/malformed JSON/iu);
    expectRows(jsonValue("[]"), [{ value: "[]" }]);
    expect(prepares()).toBe(2);
  });

  it.each(["eager", "lazy"])(
    "reports query failures without replacing the original database error (%s)",
    (mode) => {
      const malformedJson = scalar<string>("json", "{");
      const observed: unknown[] = [];
      registerNodeSqliteKyselyQueryErrorHandler(database, (error) => {
        observed.push(error);
        throw new Error("handler failure");
      });

      const thrown = captureError(() => {
        if (mode === "eager") {
          run(malformedJson);
        } else {
          Array.from(iterateSqliteQuerySync(database, malformedJson));
        }
      });

      expect(observed).toEqual([thrown]);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/malformed JSON/iu);
    },
  );

  it("clears cached statements before propagating a close failure", () => {
    createItems(["Ada"]);
    const closeError = new Error("synthetic close failure");
    vi.spyOn(database, "close").mockImplementation(() => {
      throw closeError;
    });
    const checkRows = cachedRows();
    checkRows(itemRows("Ada"), 2, 3);
    expect(() => database.close()).toThrow(closeError);
    checkRows(itemRows("Ada"), 3);
  });

  it.each([
    ["clear-and-close", true, 2],
    ["close", true, 2],
    ["drop", false, 1],
  ] as const)(
    "collects only released native resources after %s",
    (cleanup, databaseCollected, statementsCollected) => {
      expect(runRetentionScenario(cleanup)).toEqual({
        databaseCollected,
        statementsCollected,
        statementCount: 2,
      });
    },
  );

  it.skipIf(typeof DatabaseSync.prototype[Symbol.dispose] !== "function")(
    "allows databases and prepared statements to collect after disposal",
    () => {
      expect(runRetentionScenario("dispose")).toEqual({
        databaseCollected: true,
        statementsCollected: 2,
        statementCount: 2,
      });
    },
  );

  it("keeps the builder facade compile-only and fails direct execution", async () => {
    createItems();

    run(db.insertInto("items").values({ id: 1, name: "Ada" }));
    expectRows(selectItems(), [{ id: 1, name: "Ada" }]);

    for (const execute of [
      () => selectItems().execute(),
      () => db.insertInto("items").values({ id: 2, name: "Grace" }).execute(),
      () =>
        db.transaction().execute(async (trx) => {
          await trx.insertInto("items").values({ id: 3, name: "Lin" }).execute();
        }),
    ]) {
      await expect(execute()).rejects.toThrow(/compile-only Kysely facade/);
    }
    for (const execute of [
      () => db.startTransaction().execute(),
      () => consumeStream(selectItems().stream()),
    ]) {
      await expectCompileOnlyRejection(execute());
    }

    expectRows(db.selectFrom("items").select(["id", "name"]), [{ id: 1, name: "Ada" }]);
  });
});

function countPrepares(database: DatabaseSync): () => number {
  enableNodeSqliteKyselyStatementCache(database);
  const prepare = vi.spyOn(database, "prepare");
  return () => prepare.mock.calls.length;
}

function captureError(operation: () => void): unknown {
  return captureThrown(operation, "expected operation to throw");
}

function runRetentionScenario(
  cleanupMode: "clear-and-close" | "close" | "dispose" | "drop",
): RetentionResult {
  const moduleUrl = resolveRuntimeWorkerUrl(storageProcessTestEntrypoints.kyselySync);
  const cleanup = {
    "clear-and-close": `
        clearNodeSqliteKyselyCacheForDatabase(database);
        database.close();
      `,
    close: "database.close();",
    dispose: "database[Symbol.dispose]();",
    drop: "",
  }[cleanupMode];
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

  expect(result).toMatchObject({ stderr: "", status: 0 });
  return JSON.parse(result.stdout) as RetentionResult;
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
