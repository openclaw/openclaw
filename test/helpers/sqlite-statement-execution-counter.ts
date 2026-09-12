import type { DatabaseSync, StatementSync } from "node:sqlite";
import { vi } from "vitest";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../src/infra/kysely-sync.js";

/**
 * Count SQLite query executions per caller-defined bucket. Prepared-statement
 * caching (src/infra/kysely-sync.ts) reuses statements across calls, so
 * counting `prepare` invocations undercounts; this wraps `get`, `iterate`, and `run` on matching
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
  restore: () => void;
} {
  clearNodeSqliteKyselyCacheForDatabase(db);
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
  const rowCounts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
  const textBytes = Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
  const observeRow = (key: Key, row: Record<string, unknown>) => {
    rowCounts[key] += 1;
    for (const value of Object.values(row)) {
      if (typeof value === "string") {
        textBytes[key] += Buffer.byteLength(value);
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
    restore: () => {
      clearNodeSqliteKyselyCacheForDatabase(db);
      prepareSpy.mockRestore();
    },
  };
}
