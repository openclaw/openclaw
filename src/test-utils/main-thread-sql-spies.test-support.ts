import { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";

type SqlObservationOptions = {
  includeClose?: boolean;
  /** Observe bound SQL before the caller can dispose its statement. */
  onStatement?: (sql: string) => void;
};

function mainThreadSqlSpies({ includeClose, onStatement }: SqlObservationOptions = {}) {
  return [
    vi.spyOn(DatabaseSync.prototype, "prepare"),
    vi.spyOn(DatabaseSync.prototype, "exec"),
    ...(includeClose ? [vi.spyOn(DatabaseSync.prototype, "close")] : []),
    ...(["get", "all", "run", "iterate"] as const).map((method) => {
      const original = StatementSync.prototype[method];
      const spy = vi.spyOn(StatementSync.prototype, method);
      if (onStatement) {
        spy.mockImplementation(
          new Proxy(original, {
            apply(target, receiver: StatementSync, args) {
              const result = Reflect.apply(target, receiver, args);
              onStatement(receiver.expandedSQL);
              return result;
            },
          }),
        );
      }
      return spy;
    }),
  ];
}

// Callers retain ownership of assertion timing and restoration.
export function observeMainThreadSql(options: SqlObservationOptions = {}) {
  return observeSqlCalls(mainThreadSqlSpies(options));
}

export async function expectNoMainThreadSql(run: () => Promise<void>) {
  const sql = observeMainThreadSql();
  try {
    await run();
    sql.expectIdle();
  } finally {
    sql.restore();
  }
}

export async function withoutMainThreadSql<T>(run: () => Promise<T>): Promise<T> {
  const sql = observeMainThreadSql();
  try {
    const result = await run();
    sql.expectIdle();
    return result;
  } finally {
    sql.restore();
  }
}

export function observeMainThreadReads() {
  return observeSqlCalls(
    (["all", "get", "iterate"] as const).map((method) => vi.spyOn(StatementSync.prototype, method)),
  );
}

function observeSqlCalls(calls: ReturnType<typeof mainThreadSqlSpies>) {
  const clear = () => calls.forEach((call) => call.mockClear());
  return {
    calls,
    count: () => calls.reduce((total, call) => total + call.mock.calls.length, 0),
    clear,
    calibrate() {
      const database = new DatabaseSync(":memory:");
      try {
        try {
          database.exec("CREATE TABLE calibration (value INTEGER)");
          database.prepare("INSERT INTO calibration VALUES (?)").run(1);
          const read = database.prepare("SELECT value FROM calibration");
          read.get();
          read.all();
          expect([...read.iterate()]).toHaveLength(1);
        } finally {
          database.close();
        }
        calls.forEach((call) => expect(call).toHaveBeenCalled());
      } finally {
        clear();
      }
    },
    expectIdle: () => calls.forEach((call) => expect(call).not.toHaveBeenCalled()),
    restore: () => calls.forEach((call) => call.mockRestore()),
  };
}

export function forbidMainThreadSql(message: string) {
  requireNodeSqlite();
  const calls = mainThreadSqlSpies();
  for (const call of calls) {
    call.mockImplementation(() => {
      throw new Error(message);
    });
  }
  return {
    restore: () => calls.forEach((call) => call.mockRestore()),
  };
}
