import { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";

type SqlObservationOptions = { includeClose?: boolean };

function mainThreadSqlSpies(options: SqlObservationOptions = {}) {
  return [
    vi.spyOn(DatabaseSync.prototype, "prepare"),
    vi.spyOn(DatabaseSync.prototype, "exec"),
    ...(options.includeClose ? [vi.spyOn(DatabaseSync.prototype, "close")] : []),
    ...(["get", "all", "run", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    ),
  ];
}

// Callers retain ownership of assertion timing and restoration.
export function observeMainThreadSql(options: SqlObservationOptions = {}) {
  return observeSqlCalls(mainThreadSqlSpies(options));
}

export function observeMainThreadReads() {
  return observeSqlCalls(
    (["all", "get", "iterate"] as const).map((method) => vi.spyOn(StatementSync.prototype, method)),
  );
}

function observeSqlCalls(calls: ReturnType<typeof mainThreadSqlSpies>) {
  const clear = () => {
    for (const call of calls) {
      call.mockClear();
    }
  };
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
        for (const call of calls) {
          expect(call).toHaveBeenCalled();
        }
      } finally {
        clear();
      }
    },
    expectIdle() {
      for (const call of calls) {
        expect(call).not.toHaveBeenCalled();
      }
    },
    restore() {
      for (const call of calls) {
        call.mockRestore();
      }
    },
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
    restore() {
      for (const call of calls) {
        call.mockRestore();
      }
    },
  };
}
