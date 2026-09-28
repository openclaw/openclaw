import type { DatabaseSync, StatementSync } from "node:sqlite";
import { vi, type Mock } from "vitest";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../src/infra/kysely-sync.js";
import { requireNodeSqlite } from "../../src/infra/node-sqlite.js";

/** Capture SQL during execution; closing a connection invalidates its statement getters. */
export function observeSqliteReadSql(prototype: StatementSync): {
  queries: string[];
  restore: () => void;
} {
  const queries: string[] = [];
  const observers = (["all", "get", "iterate"] as const).map((method) => {
    const original = prototype[method];
    return vi.spyOn(prototype, method).mockImplementation(
      new Proxy(original, {
        apply(target, receiver: StatementSync, args) {
          queries.push(receiver.sourceSQL);
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
  });
  return {
    queries,
    restore: () => observers.forEach((observer) => observer.mockRestore()),
  };
}

/**
 * Count SQLite query executions per caller-defined bucket. Prepared-statement
 * caching (src/infra/kysely-sync.ts) reuses statements across calls, so
 * counting `prepare` invocations undercounts; this wraps `all`, `get`, `iterate`, and `run` on matching
 * statements and clears the statement cache at attach so statements cached
 * before the spy cannot bypass it.
 */
export function trackSqliteStatementExecutions<Key extends string>(
  db: DatabaseSync,
  keys: readonly Key[],
  classify: (sql: string) => Key | null,
): {
  counts: Record<Key, number>;
  rowCounts: Record<Key, number>;
  textBytes: Record<Key, number>;
  blobBytes: Record<Key, number>;
  restore: () => void;
} {
  clearNodeSqliteKyselyCacheForDatabase(db);
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
  const rowCounts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
  const textBytes = Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
  const blobBytes = Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
  const observeRow = (key: Key, row: Record<string, unknown>) => {
    rowCounts[key] += 1;
    for (const value of Object.values(row)) {
      if (typeof value === "string") {
        textBytes[key] += Buffer.byteLength(value);
      } else if (ArrayBuffer.isView(value)) {
        blobBytes[key] += value.byteLength;
      }
    }
  };
  const originalPrepare = db.prepare.bind(db);
  const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sqlText: string) => {
    const statement = originalPrepare(sqlText);
    const key = classify(sqlText);
    if (key !== null) {
      // Preserve both positional and named-binding overloads at the native call boundary.
      statement.run = new Proxy(statement.run.bind(statement), {
        apply(run, receiver, args) {
          counts[key] += 1;
          return Reflect.apply(run, receiver, args);
        },
      });
      statement.get = new Proxy(statement.get.bind(statement), {
        apply(get, _receiver, args) {
          counts[key] += 1;
          const row = get(...args);
          if (row) {
            observeRow(key, row);
          }
          return row;
        },
      });
      statement.all = new Proxy(statement.all.bind(statement), {
        apply(all, _receiver, args) {
          counts[key] += 1;
          const rows = all(...args);
          for (const row of rows) {
            observeRow(key, row);
          }
          return rows;
        },
      });
      const originalIterate = statement.iterate.bind(statement) as (
        ...args: unknown[]
      ) => ReturnType<StatementSync["iterate"]>;
      // iterate is overloaded, so the wrapper forwards untyped and casts back.
      statement.iterate = ((...args: unknown[]) => {
        counts[key] += 1;
        const rows = originalIterate(...args);
        return (function* () {
          for (const row of rows) {
            observeRow(key, row);
            yield row;
          }
        })();
      }) as StatementSync["iterate"];
    }
    return statement;
  });
  return {
    counts,
    rowCounts,
    textBytes,
    blobBytes,
    restore: () => {
      clearNodeSqliteKyselyCacheForDatabase(db);
      prepareSpy.mockRestore();
    },
  };
}

/** Observe all host data SQL, including statements prepared before observation began. */
export function observeHostDataSql(onQuery?: (sql: string) => void): {
  calls: Mock[];
  queries: string[];
  restore: () => void;
} {
  // Validate the real runtime once before measurement. The owner's capability
  // probes are setup, not an exemption for arbitrary in-memory database SQL.
  const native = requireNodeSqlite();
  const queries: string[] = [];
  const recordQuery = (sql: string) => {
    queries.push(sql);
    onQuery?.(sql);
  };
  const prepare = vi.fn();
  const exec = vi.fn();
  // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted database receiver.
  const originalPrepare = native.DatabaseSync.prototype.prepare;
  // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted database receiver.
  const originalExec = native.DatabaseSync.prototype.exec;
  const spies = [
    vi.spyOn(native.DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      prepare(sql);
      recordQuery(sql);
      return originalPrepare.call(this, sql);
    }),
    vi.spyOn(native.DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      exec(sql);
      recordQuery(sql);
      return originalExec.call(this, sql);
    }),
  ];
  const statements = (["get", "all", "run", "iterate"] as const).map((method) => {
    const called = vi.fn();
    const original = native.StatementSync.prototype[method];
    const spy = vi.spyOn(native.StatementSync.prototype, method).mockImplementation(
      new Proxy(original, {
        apply(target, receiver: StatementSync, args) {
          called(...args);
          recordQuery(receiver.sourceSQL);
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
    return { called, spy };
  });
  return {
    calls: [prepare, exec, ...statements.map(({ called }) => called)],
    queries,
    restore: () => {
      spies.forEach((spy) => spy.mockRestore());
      statements.forEach(({ spy }) => spy.mockRestore());
    },
  };
}
