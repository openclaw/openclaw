import { channel } from "node:diagnostics_channel";
import { DatabaseSync } from "node:sqlite";
import { threadId } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  observeConnection,
  observeDatabaseOperation,
  observeDatabaseRequest,
} from "./observation.js";

const statementChannel = channel("openclaw.database.statement");
const requestChannel = channel("openclaw.database.request");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  vi.restoreAllMocks();
});

function database() {
  const db = observeConnection(new DatabaseSync(":memory:"));
  cleanups.push(() => db.close());
  return db;
}

function capture(target: typeof statementChannel) {
  const events: unknown[] = [];
  const subscriber = (event: unknown) => events.push(event);
  target.subscribe(subscriber);
  cleanups.push(() => target.unsubscribe(subscriber));
  return events;
}
const completion = (engine: string, outcome = "ok") => ({
  engine,
  threadId,
  outcome,
  durationMs: expect.any(Number),
});

describe("database engine observation", () => {
  it("observes pre-subscription statements, redacts trailing-backslash literals and never publishes bindings", () => {
    const db = database();
    const statement = db.prepare("SELECT ? AS v, 'C:\\' AS p, 'literal-secret' AS t, 42 AS n");
    const events = capture(statementChannel);
    expect(statement.get("binding-secret")).toEqual({
      v: "binding-secret",
      p: "C:\\",
      t: "literal-secret",
      n: 42,
    });
    expect(events).toEqual([
      { ...completion("sqlite"), sql: "SELECT ? AS v, ? AS p, ? AS t, ? AS n" },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("counts exec, run, all and lazy iteration once each, including early iterator close", () => {
    const db = database();
    expect(observeConnection(db)).toBe(db);
    const events = capture(statementChannel);
    db.exec("CREATE TABLE entries (value TEXT)");
    db.prepare("INSERT INTO entries VALUES (?)").run("one");
    db.prepare("SELECT * FROM entries").all();
    for (const row of db.prepare("SELECT * FROM entries").iterate()) {
      expect(row).toEqual({ value: "one" });
      break;
    }
    expect(events).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({ engine: "sqlite", outcome: "ok" });
    expect(() => db.exec("SELECT * FROM missing_entries")).toThrow("no such table");
    expect(events).toHaveLength(5);
    expect(events.at(-1)).toMatchObject({ engine: "sqlite", outcome: "error" });
  });

  it.each([false, true])(
    "preserves immediate iterator validation and binding capture (subscribed=%s)",
    (subscribed) => {
      const db = database();
      if (subscribed) {
        capture(statementChannel);
      }
      expect(db.prepare("SELECT 7 AS value").get()).toEqual({ value: 7 });
      const statement = db.prepare("SELECT ? AS value");
      expect(() => statement.iterate(1, 2)).toThrow("column index out of range");
      const binding = new Uint8Array([1]);
      const rows = statement.iterate(binding);
      binding[0] = 2;
      expect([...rows]).toEqual([{ value: new Uint8Array([1]) }]);
    },
  );

  it("releases a subscribed native iterator returned before its first next", () => {
    const db = new DatabaseSync(":memory:");
    cleanups.push(() => db.close());
    const statement = db.prepare("SELECT ? AS value");
    const native = statement.iterate(7);
    vi.spyOn(statement, "iterate").mockReturnValue(native);
    vi.spyOn(db, "prepare").mockReturnValue(statement);
    const events = capture(statementChannel);
    const observed = observeConnection(db).prepare("SELECT ? AS value").iterate(7);
    observed.return?.();
    expect(native.next()).toMatchObject({ done: true });
    expect(events).toEqual([]);
  });

  it("redacts PostgreSQL literals, nested comments and dollar strings without changing identifiers or placeholders", () => {
    const events = capture(statementChannel);
    observeDatabaseOperation(
      "postgres",
      "statement",
      `SELECT $1, E'escaped\\'secret', 'C:\\', 'private_value', $body$dollar secret$body$, "column2", 5 /* outer /* nested */ secret */ -- comment secret\n`,
      () => 1,
    );
    expect(events).toEqual([
      expect.objectContaining({
        engine: "postgres",
        sql: 'SELECT $1, ?, ?, ?, ?, "column2", ?',
        outcome: "ok",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("publishes one worker request completion for each success or error without request payloads", async () => {
    const pending = Promise.resolve(8);
    expect(observeDatabaseRequest("sqlite", () => pending)).toBe(pending);
    await expect(pending).resolves.toBe(8);
    const events = capture(requestChannel);
    await expect(observeDatabaseRequest("postgres", async () => 7)).resolves.toBe(7);
    const failure = new Error("private failure payload");
    await expect(
      observeDatabaseRequest("sqlite", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(events).toEqual([completion("postgres"), completion("sqlite", "error")]);
  });
});
