import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { threadId } from "node:worker_threads";
import { observeGcSamples } from "../gc-observer.js";
import type { SqlConnection } from "../sql-connection.js";
import type { DatabaseEngineId } from "./types.js";

type Kind = "statement" | "request";
const channels = {
  statement: channel("openclaw.database.statement"),
  request: channel("openclaw.database.request"),
};
const observedConnections = new WeakSet<SqlConnection>();
let statementTiming: ((sql: string, durationMs: number, rows?: number) => void) | undefined;

/** Synchronous diagnostic scope; hashes identify normalized statements without logging SQL. */
export function startSqliteStatementTiming(collectGc = false) {
  const previous = statementTiming;
  let callbackGcMs: number | undefined;
  // Reuse the isolate's GC owner; PerformanceObserver delivers too late for this sync line.
  let stopGc: (() => void) | undefined;
  if (collectGc) {
    try {
      stopGc = observeGcSamples((samples) => {
        for (const sample of samples) {
          callbackGcMs = (callbackGcMs ?? 0) + sample.durationMs;
        }
      });
      callbackGcMs = stopGc ? 0 : undefined;
    } catch {
      // Unavailable diagnostics must not prevent a coherent read.
    }
  }

  const statements = new Map<
    string,
    {
      count: number;
      totalMs: number;
      maxMs: number;
      rows?: number;
    }
  >();
  let count = 0;
  let totalMs = 0;
  let maxMs = 0;
  let slowestSql: string | undefined;
  statementTiming = (sql, durationMs, rows) => {
    count++;
    totalMs += durationMs;
    if (slowestSql === undefined || durationMs > maxMs) {
      slowestSql = sql;
    }
    const key = statements.has(sql) || statements.size < 32 ? sql : "";
    const entry = statements.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
    statements.set(key, entry);
    maxMs = Math.max(maxMs, durationMs);
    if (rows !== undefined) {
      entry.rows = (entry.rows ?? 0) + rows;
    }
    entry.count++;
    entry.totalMs += durationMs;
    entry.maxMs = Math.max(entry.maxMs, durationMs);
  };
  return () => {
    statementTiming = previous;
    try {
      stopGc?.();
    } catch {
      callbackGcMs = undefined;
    }
    return {
      totalMs,
      callbackGcMs,
      summarize() {
        // Only slow holds pay for normalization, hashing and log-shaped allocations.
        const identity = (sql: string) => {
          const normalized = normalizeSql("sqlite", sql);
          return {
            id: sql ? createHash("sha256").update(normalized).digest("hex").slice(0, 16) : "other",
            operation:
              /^(SELECT|INSERT|UPDATE|DELETE|WITH|SAVEPOINT|RELEASE|ROLLBACK)\b/i
                .exec(normalized)?.[1]
                ?.toUpperCase() ?? "OTHER",
          };
        };
        return {
          count,
          maxMs,
          slowest: slowestSql === undefined ? undefined : { ...identity(slowestSql), maxMs },
          // Keep the existing console metadata tail below its 2,048-character budget.
          statements: [...statements]
            .toSorted((left, right) => right[1].totalMs - left[1].totalMs)
            .slice(0, 5)
            .map(([sql, entry]) =>
              Object.assign(identity(sql), entry, {
                totalMs: Math.round(entry.totalMs * 100) / 100,
                maxMs: Math.round(entry.maxMs * 100) / 100,
              }),
            ),
          omittedGroups: Math.max(0, statements.size - 5),
        };
      },
    };
  };
}

function normalizeSql(engine: DatabaseEngineId, sql: string): string {
  let normalized = "";
  for (let i = 0; i < sql.length;) {
    const rest = sql.slice(i);
    if (rest.startsWith("/*")) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      normalized += " ";
      continue;
    }
    const comment = /^--[^\r\n]*/.exec(rest)?.[0];
    const escapedLiteral =
      engine === "postgres" ? /^[eE]'(?:\\[\s\S]|''|[^'\\])*(?:'|$)/.exec(rest)?.[0] : undefined;
    const literal = escapedLiteral ?? /^(?:[uU]&)?'(?:''|[^'])*(?:'|$)/.exec(rest)?.[0];
    const dollar = /^\$(?:[A-Za-z_][\w]*)?\$/.exec(rest)?.[0];
    const identifier = /^(?:"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\])/.exec(rest)?.[0];
    const number = !/[\w$]/.test(sql[i - 1] ?? "")
      ? /^(?:0x[\da-f]+|\d+(?:\.\d*)?(?:e[+-]?\d+)?)(?!\w)/i.exec(rest)?.[0]
      : undefined;
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length);
      i = end < 0 ? sql.length : end + dollar.length;
      normalized += "?";
    } else if (comment || literal || identifier || number) {
      const token = comment ?? literal ?? identifier ?? number ?? "";
      i += token.length;
      normalized += comment ? " " : identifier ? token : "?";
    } else {
      normalized += sql[i++];
    }
  }
  return normalized.replace(/\s+/g, " ").trim();
}

export function observeDatabaseOperation<T>(
  engine: DatabaseEngineId,
  kind: Kind,
  sql: string | undefined,
  operation: () => T,
  resultKind?: "get" | "all",
): T {
  const target = channels[kind];
  const timing = engine === "sqlite" && kind === "statement" ? statementTiming : undefined;
  if (!target.hasSubscribers && !timing) {
    return operation();
  }
  const started = performance.now();
  let outcome = "error";
  let rows: number | undefined;
  try {
    const result = operation();
    outcome = "ok";
    rows =
      resultKind === "all" && Array.isArray(result)
        ? result.length
        : resultKind === "get"
          ? Number(result !== undefined)
          : undefined;
    return result;
  } finally {
    const durationMs = performance.now() - started;
    if (sql !== undefined) {
      timing?.(sql, durationMs, rows);
    }
    if (target.hasSubscribers) {
      target.publish({
        engine,
        sql: sql === undefined ? undefined : normalizeSql(engine, sql),
        threadId,
        outcome,
        durationMs,
      });
    }
  }
}

export function observeDatabaseRequest<T>(
  engine: DatabaseEngineId,
  operation: () => Promise<T>,
): Promise<T> {
  const target = channels.request;
  if (!target.hasSubscribers) {
    return operation();
  }
  return (async () => {
    const started = performance.now();
    let outcome = "error";
    try {
      const result = await operation();
      outcome = "ok";
      return result;
    } finally {
      target.publish({ engine, threadId, outcome, durationMs: performance.now() - started });
    }
  })();
}

export function observeConnection<T extends SqlConnection>(db: T): T {
  if (observedConnections.has(db)) {
    return db;
  }
  observedConnections.add(db);
  const exec = db.exec.bind(db);
  const prepare = db.prepare.bind(db);
  db.exec = (sql) => observeDatabaseOperation("sqlite", "statement", sql, () => exec(sql));
  db.prepare = (sql) => {
    const statement = prepare(sql);
    for (const key of ["get", "all", "run"] as const) {
      const execute = statement[key].bind(statement);
      Object.defineProperty(statement, key, {
        configurable: true,
        writable: true,
        value: (...parameters: Parameters<typeof execute>) =>
          observeDatabaseOperation(
            "sqlite",
            "statement",
            sql,
            () => execute(...parameters),
            key === "run" ? undefined : key,
          ),
      });
    }
    const iterate = statement.iterate.bind(statement);
    statement.iterate = (...parameters) => {
      const iterator = iterate(...parameters);
      const timing = statementTiming;
      if (!channels.statement.hasSubscribers && !timing) {
        return iterator;
      }
      let durationMs = 0;
      let rows = 0;
      let executed = false;
      let finished = false;
      const finish = (outcome: "ok" | "error") => {
        if (finished) {
          return;
        }
        finished = true;
        if (executed) {
          timing?.(sql, durationMs, rows);
          if (channels.statement.hasSubscribers) {
            channels.statement.publish({
              engine: "sqlite",
              sql: normalizeSql("sqlite", sql),
              threadId,
              outcome,
              durationMs,
            });
          }
        }
      };
      const step = (operation: () => ReturnType<typeof iterator.next>) => {
        if (finished) {
          return operation();
        }
        const started = performance.now();
        try {
          const result = operation();
          durationMs += performance.now() - started;
          if (result.done) {
            finish("ok");
          } else {
            rows++;
          }
          return result;
        } catch (error) {
          durationMs += performance.now() - started;
          finish("error");
          throw error;
        }
      };
      const observed: typeof iterator = {
        next: (...args) => {
          executed = true;
          return step(() => iterator.next(...args));
        },
        return: (value) => step(() => iterator.return?.(value) ?? { done: true, value }),
        [Symbol.iterator]() {
          return this;
        },
      };
      // Native iterator helpers and disposal must use the measured next/return methods.
      Object.setPrototypeOf(observed, Object.getPrototypeOf(iterator));
      return observed;
    };
    return statement;
  };
  return db;
}
