import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import { hasPendingSqliteNativeExecution } from "./sqlite-native-observer.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const databases: ReturnType<typeof openNodeSqliteDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.isOpen) {
      database.close();
    }
  }
});

function open(location = ":memory:") {
  const db = openNodeSqliteDatabase(location);
  databases.push(db);
  return db;
}

it.each(["exec", "run", "get", "all"] as const)(
  "retains custody across %s callbacks and preserves a native error",
  (method) => {
    const db = open();
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
  },
);

it("binds iterators immediately and holds custody until exhaustion or explicit return", () => {
  const db = open();
  const statement = db.prepare("SELECT ? AS value UNION ALL SELECT 2");
  expect(() => {
    Reflect.apply(statement.iterate.bind(statement), undefined, [Symbol("invalid")]);
  }).toThrow();
  expect(hasPendingSqliteNativeExecution(db)).toBe(false);
  const rows = statement.iterate(1);
  expect(hasPendingSqliteNativeExecution(db)).toBe(false);
  expect(rows.next().value).toEqual({ value: 1 });
  expect(hasPendingSqliteNativeExecution(db)).toBe(true);
  expect(rows.next().value).toEqual({ value: 2 });
  expect(hasPendingSqliteNativeExecution(db)).toBe(true);
  expect(rows.next().done).toBe(true);
  expect(hasPendingSqliteNativeExecution(db)).toBe(false);

  const next = statement.iterate(3);
  expect(next.next().value).toEqual({ value: 3 });
  // A completed cursor's return is inert on Node but can reset a sibling on Bun.
  // Neither runtime permits that stale cursor to certify the newer cursor's settlement.
  rows.return?.();
  expect(hasPendingSqliteNativeExecution(db)).toBe(true);
  next.return?.();
  expect(hasPendingSqliteNativeExecution(db)).toBe(false);
});

it.each(["run", "get", "all", "bind-error", "close"] as const)(
  "settles a retained statement's RETURNING cursor on %s",
  (method) => {
    const db = open();
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
    } else if (method === "bind-error") {
      expect(() => {
        Reflect.apply(statement.get.bind(statement), undefined, [Symbol("invalid")]);
      }).toThrow();
    } else {
      statement[method](0);
    }
    expect(hasPendingSqliteNativeExecution(db)).toBe(false);
    expect(db.prepare("SELECT value FROM entries ORDER BY id").all()).toEqual([
      { value: 1 },
      { value: 1 },
    ]);
  },
);

it("settles a failing step and closes only the connection whose cursor it owns", () => {
  const db = open();
  const sibling = open();
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
  const writer = open(filename);
  writer.exec("PRAGMA journal_mode = WAL; CREATE TABLE entries (id TEXT PRIMARY KEY)");
  const reader = open(filename);
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

it("retains native trigger, cascade, replace, and savepoint behavior through one execution boundary", () => {
  const db = open();
  const observations: boolean[] = [];
  db.function("observe", () => {
    observations.push(hasPendingSqliteNativeExecution(db));
    return 1;
  });
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE parent (id TEXT PRIMARY KEY);
    CREATE TABLE child (id TEXT PRIMARY KEY, parent TEXT REFERENCES parent(id) ON DELETE CASCADE);
    CREATE TRIGGER deleted AFTER DELETE ON child BEGIN SELECT observe(); END;
    INSERT INTO parent VALUES ('a');
    INSERT INTO child VALUES ('child', 'a');
    BEGIN;
    SAVEPOINT nested;
    DELETE FROM parent;
    ROLLBACK TO nested;
    RELEASE nested;
    COMMIT;
  `);
  expect(observations).toEqual([true]);
  expect(db.prepare("SELECT id FROM child").get()).toEqual({ id: "child" });
  db.prepare("REPLACE INTO parent VALUES (?)").run("a");
  expect(observations).toEqual([true, true]);
  expect(db.prepare("SELECT id FROM child").all()).toEqual([]);
  expect(hasPendingSqliteNativeExecution(db)).toBe(false);
});

it.each(["run", "get", "all", "iterate"] as const)(
  "preserves native undefined and trailing bindings in %s",
  (method) => {
    const native = new (requireNodeSqlite().DatabaseSync)(":memory:");
    databases.push(native);
    const exercise = (db: typeof native) => {
      const called: unknown[][] = [];
      db.function("callback", (first, second) => {
        called.push([first, second]);
        return 1;
      });
      const statement = db.prepare("SELECT callback(?, ?) AS value");
      let outcome: unknown;
      try {
        if (method === "iterate") {
          const rows: ReturnType<typeof statement.iterate> = Reflect.apply(
            statement.iterate.bind(statement),
            undefined,
            [undefined, 42],
          );
          outcome = rows.next();
          rows.return?.();
        } else {
          outcome = Reflect.apply(statement[method].bind(statement), undefined, [undefined, 42]);
        }
      } catch (error) {
        outcome = error instanceof Error ? error.message : error;
      }
      return { called, outcome };
    };
    const db = open();
    expect(exercise(db)).toEqual(exercise(native));
    expect(hasPendingSqliteNativeExecution(db)).toBe(false);
  },
);

it("preserves native cursor behavior when an invalidated iterator is stepped", () => {
  const native = new (requireNodeSqlite().DatabaseSync)(":memory:");
  databases.push(native);
  const exercise = (db: typeof native) => {
    const statement = db.prepare("SELECT 1 AS value UNION ALL SELECT 2");
    const first = statement.iterate();
    first.next();
    const second = statement.iterate();
    second.next();
    let stale: unknown;
    try {
      stale = first.next();
    } catch (error) {
      stale = error instanceof Error ? error.message : error;
    }
    const next = second.next();
    first.return?.();
    second.return?.();
    return { stale, next };
  };
  expect(exercise(open())).toEqual(exercise(native));
});

it("preserves a recoverable native row-conversion failure without losing the next row", () => {
  const native = new (requireNodeSqlite().DatabaseSync)(":memory:");
  databases.push(native);
  const exercise = (db: typeof native) => {
    const rows = db.prepare("SELECT 9007199254740992 AS value UNION ALL SELECT 2").iterate();
    const results: unknown[] = [];
    for (let step = 0; step < 2; step++) {
      try {
        results.push(rows.next());
      } catch (error) {
        results.push(error instanceof Error ? error.message : error);
      }
    }
    rows.return?.();
    return results;
  };
  const db = open();
  expect(exercise(db)).toEqual(exercise(native));
  expect(hasPendingSqliteNativeExecution(db)).toBe(false);
});

it("settles a reset cursor when a callback propagates a nested native refusal", () => {
  const db = open();
  let reenter = false;
  db.function("callback", () => {
    if (reenter) {
      statement.get();
    }
    return 1;
  });
  const statement = db.prepare("SELECT callback() AS value UNION ALL SELECT 2");
  const rows = statement.iterate();
  rows.next();
  expect(hasPendingSqliteNativeExecution(db)).toBe(true);
  reenter = true;
  expect(() => statement.get()).toThrow();
  expect(hasPendingSqliteNativeExecution(db)).toBe(false);
  rows.return?.();
});
