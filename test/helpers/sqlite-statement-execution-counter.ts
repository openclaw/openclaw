import { realpathSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { vi, type Mock } from "vitest";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../src/infra/kysely-sync.js";
import { requireNodeSqlite } from "../../src/infra/node-sqlite.js";
import {
  captureStateDatabaseCoordinatorRuntime,
  resolveStateDatabaseCoordinatorPath,
} from "../../src/infra/state-database-coordinator.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";

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

/** Observe host data SQL while allowing only the captured state's lifecycle control database. */
export function observeHostDataSql(env?: NodeJS.ProcessEnv): {
  calls: Mock[];
  restore: () => void;
} {
  // Validate the real runtime once before measurement. The owner's capability
  // probes are setup, not an exemption for arbitrary in-memory database SQL.
  const native = requireNodeSqlite();
  const coordinatorPath = resolveStateDatabaseCoordinatorPath({
    databasePath: resolveOpenClawStateSqlitePath(env),
    runtimeDirectory: captureStateDatabaseCoordinatorRuntime().directory,
    uid: process.getuid?.(),
  });
  const isControl = (database: DatabaseSync | undefined) => {
    const location = database?.location();
    if (!location) {
      return false;
    }
    try {
      return realpathSync(location) === realpathSync(coordinatorPath);
    } catch {
      // Missing or unknown locations must never hide data SQL.
      return false;
    }
  };
  const databases = new WeakMap<StatementSync, DatabaseSync>();
  const prepare = vi.fn();
  const exec = vi.fn();
  // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted database receiver.
  const originalPrepare = native.DatabaseSync.prototype.prepare;
  // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted database receiver.
  const originalExec = native.DatabaseSync.prototype.exec;
  const spies = [
    vi
      .spyOn(native.DatabaseSync.prototype, "prepare")
      .mockImplementation(function (this: DatabaseSync, sql) {
        if (!isControl(this)) {
          prepare(sql);
        }
        const statement = originalPrepare.call(this, sql);
        databases.set(statement, this);
        return statement;
      }),
    vi
      .spyOn(native.DatabaseSync.prototype, "exec")
      .mockImplementation(function (this: DatabaseSync, sql) {
        if (!isControl(this)) {
          exec(sql);
        }
        return originalExec.call(this, sql);
      }),
  ];
  const statements = (["get", "all", "run", "iterate"] as const).map((method) => {
    const called = vi.fn();
    const original = native.StatementSync.prototype[method];
    const spy = vi.spyOn(native.StatementSync.prototype, method).mockImplementation(
      new Proxy(original, {
        apply(target, receiver: StatementSync, args) {
          if (!isControl(databases.get(receiver))) {
            called(...args);
          }
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
    return { called, spy };
  });
  return {
    calls: [prepare, exec, ...statements.map(({ called }) => called)],
    restore: () => {
      spies.forEach((spy) => spy.mockRestore());
      statements.forEach(({ spy }) => spy.mockRestore());
    },
  };
}
