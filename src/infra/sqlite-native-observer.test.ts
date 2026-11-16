import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import { hasPendingSqliteNativeExecution } from "./sqlite-native-observer.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const open = (location = ":memory:") => openNodeSqliteDatabase(location);

function outcome(operation: () => unknown) {
  try {
    return operation();
  } catch (error) {
    return error instanceof Error ? error.message : error;
  }
}

function expectNativeBehavior(
  exercise: (db: ReturnType<typeof open>, observed: boolean) => unknown,
) {
  using native = new (requireNodeSqlite().DatabaseSync)(":memory:");
  using db = open();
  expect(exercise(db, true)).toEqual(exercise(native, false));
  expect(hasPendingSqliteNativeExecution(db)).toBe(false);
}

it.each(["exec", "all"] as const)("retains custody across failing %s callbacks", (method) => {
  using db = open();
  const failure = new Error("synthetic native callback failure");
  const observations: boolean[] = [];
  db.function("callback", () => {
    observations.push(hasPendingSqliteNativeExecution(db));
    // Nested native work cannot settle its enclosing operation.
    db.prepare("SELECT 1").get();
    observations.push(hasPendingSqliteNativeExecution(db));
    throw failure;
  });
  expect(() =>
    method === "exec" ? db.exec("SELECT callback()") : db.prepare("SELECT callback()")[method](),
  ).toThrow("synthetic native callback failure");
  expect(observations).toEqual([true, true]);
  expect(hasPendingSqliteNativeExecution(db)).toBe(false);
  expect(db.prepare("SELECT 42 AS value").get()).toEqual({ value: 42 });
});

it("binds iterators immediately and holds custody until exhaustion or explicit return", () => {
  using db = open();
  const statement = db.prepare("SELECT ? AS value UNION ALL SELECT 2");
  expect(() => {
    Reflect.apply(statement.iterate.bind(statement), undefined, [Symbol("invalid")]);
  }).toThrow();
  expect(hasPendingSqliteNativeExecution(db)).toBe(false);
  const rows = statement.iterate(1);
  expect(hasPendingSqliteNativeExecution(db)).toBe(false);
  for (const value of [1, 2, undefined]) {
    const step = rows.next();
    expect(value === undefined ? step.done : step.value).toEqual(
      value === undefined ? true : { value },
    );
    expect(hasPendingSqliteNativeExecution(db)).toBe(value !== undefined);
  }

  const next = statement.iterate(3);
  expect(next.next().value).toEqual({ value: 3 });
  // Completed and explicitly returned cursors cannot settle their successor.
  rows.return?.();
  expect(hasPendingSqliteNativeExecution(db)).toBe(true);
  next.return?.();
  expect(hasPendingSqliteNativeExecution(db)).toBe(false);

  const last = statement.iterate(4);
  expect(last.next().value).toEqual({ value: 4 });
  next.return?.();
  expect(hasPendingSqliteNativeExecution(db)).toBe(true);
  last.return?.();
  expect(hasPendingSqliteNativeExecution(db)).toBe(false);
});

it.each(["exhaustion", "return"] as const)(
  "releases the WAL reader after %s and keeps completed iterators terminal",
  (completion) => {
    const filename = path.join(tempDirs.make("sqlite-finished-reader-"), "state.sqlite");
    using writer = open(filename);
    writer.exec(
      "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; " +
        "CREATE TABLE entries (value); INSERT INTO entries VALUES (1), (2)",
    );
    using reader = open(filename);
    const statement = reader.prepare("SELECT value FROM entries");
    const rows = statement.iterate();
    expect(rows.next().value).toEqual({ value: 1 });
    if (completion === "return") {
      rows.return?.();
    } else {
      expect([...rows]).toEqual([{ value: 2 }]);
    }
    const afterDone = rows.next();
    writer.exec("INSERT INTO entries VALUES (3)");
    const checkpoint = writer.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
    expect(checkpoint?.checkpointed).toBe(checkpoint?.log);
    expect(afterDone.done).toBe(true);
    expect(reader.isTransaction).toBe(false);
    expect(hasPendingSqliteNativeExecution(reader)).toBe(false);
    const successor = statement.iterate();
    expect(successor.next().value).toEqual({ value: 1 });
    rows.return?.();
    expect(rows.next().done).toBe(true);
    expect([...successor]).toEqual([{ value: 2 }, { value: 3 }]);
    expect(writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({
      busy: 0,
      log: 0,
    });
  },
);

it.each(["all", "close"] as const)("settles RETURNING cursors on %s", (method) => {
  using db = open();
  db.exec(
    "CREATE TABLE entries (id INTEGER PRIMARY KEY, value INTEGER); INSERT INTO entries VALUES (1, 0), (2, 0)",
  );
  const statement = db.prepare("UPDATE entries SET value = value + ? RETURNING id, value");
  const rows = statement.iterate(1);
  expect(rows.next().done).toBe(false);
  expect(hasPendingSqliteNativeExecution(db)).toBe(true);
  if (method === "close") {
    // Statement finalization is optional on older supported Node versions.
    if (statement.close) {
      statement.close();
    } else {
      rows.return?.();
    }
  } else {
    statement[method](0);
  }
  expect(hasPendingSqliteNativeExecution(db)).toBe(false);
  expect(db.prepare("SELECT value FROM entries ORDER BY id").all()).toEqual([
    { value: 1 },
    { value: 1 },
  ]);
});

it("settles a failing step and closes only the connection whose cursor it owns", () => {
  using db = open();
  using sibling = open();
  const cursor = sibling.prepare("SELECT 1 UNION ALL SELECT 2").iterate();
  cursor.next();
  db.function("fail", () => {
    expect(hasPendingSqliteNativeExecution(db)).toBe(true);
    throw new Error("synthetic step failure");
  });
  const failed = db.prepare("SELECT fail()").iterate();
  expect(() => failed.next()).toThrow("synthetic step failure");
  expect(hasPendingSqliteNativeExecution(db)).toBe(true);
  failed.return?.();
  expect(hasPendingSqliteNativeExecution(db)).toBe(false);
  expect(hasPendingSqliteNativeExecution(sibling)).toBe(true);
  sibling.close();
  expect(hasPendingSqliteNativeExecution(sibling)).toBe(false);
});

it("keeps an opaque batch fenced without treating its tentative tail as committed coverage", () => {
  const filename = path.join(tempDirs.make("openclaw-raw-settlement-"), "state.sqlite");
  using writer = open(filename);
  writer.exec("PRAGMA journal_mode = WAL; CREATE TABLE entries (id TEXT PRIMARY KEY)");
  using reader = open(filename);
  const seen: boolean[] = [];
  writer.function("observe", () => {
    seen.push(hasPendingSqliteNativeExecution(writer));
    return 1;
  });
  expect(() =>
    writer.exec(`
    BEGIN;
    INSERT INTO entries VALUES ('committed');
    COMMIT;
    SELECT observe();
    BEGIN;
    INSERT INTO entries VALUES ('tentative');
    SELECT observe();
    SELECT missing_column FROM entries;
  `),
  ).toThrow("missing_column");
  expect(seen).toEqual([true, true]);
  expect(hasPendingSqliteNativeExecution(writer)).toBe(false);
  expect(writer.isTransaction).toBe(true);
  expect(writer.prepare("SELECT id FROM entries ORDER BY id").all()).toEqual([
    { id: "committed" },
    { id: "tentative" },
  ]);
  expect(reader.prepare("SELECT id FROM entries").all()).toEqual([{ id: "committed" }]);
  writer.exec("ROLLBACK");
  expect(writer.prepare("SELECT id FROM entries").all()).toEqual([{ id: "committed" }]);
});

it.each(["get", "iterate"] as const)("preserves native undefined/trailing %s bindings", (method) =>
  expectNativeBehavior((db) => {
    db.function("callback", (first, second) =>
      JSON.stringify([typeof first, first, typeof second, second]),
    );
    const statement = db.prepare("SELECT callback(?, ?) AS value");
    return outcome(() => {
      if (method === "iterate") {
        const rows: ReturnType<typeof statement.iterate> = Reflect.apply(
          statement.iterate.bind(statement),
          undefined,
          [undefined, 42],
        );
        const step = rows.next();
        rows.return?.();
        return step;
      }
      return Reflect.apply(statement[method].bind(statement), undefined, [undefined, 42]);
    });
  }),
);

it("preserves native cursor behavior when an invalidated iterator is stepped", () => {
  expectNativeBehavior((db, observed) => {
    const statement = db.prepare("SELECT 1 AS value UNION ALL SELECT 2");
    const first = statement.iterate();
    first.next();
    const second = statement.iterate();
    second.next();
    const stale = outcome(() => first.next());
    if (observed) {
      expect(hasPendingSqliteNativeExecution(db)).toBe(true);
    }
    const next = second.next();
    first.return?.();
    if (observed) {
      expect(hasPendingSqliteNativeExecution(db)).toBe(true);
    }
    second.return?.();
    return { stale, next };
  });
});

it("preserves a recoverable native row-conversion failure without losing the next row", () => {
  expectNativeBehavior((db) => {
    const rows = db.prepare("SELECT 9007199254740992 AS value UNION ALL SELECT 2").iterate();
    const results = Array.from({ length: 2 }, () => outcome(() => rows.next()));
    rows.return?.();
    return results;
  });
});
