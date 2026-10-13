import { channel } from "node:diagnostics_channel";
import { threadId } from "node:worker_threads";
import type { SqlConnection } from "../sql-connection.js";
import type { DatabaseEngineId } from "./registry.js";

type Kind = "statement" | "request";
const channels = {
  statement: channel("openclaw.database.statement"),
  request: channel("openclaw.database.request"),
};
const observedConnections = new WeakSet<SqlConnection>();

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
): T {
  const target = channels[kind];
  if (!target.hasSubscribers) {
    return operation();
  }
  const started = performance.now();
  let outcome = "error";
  try {
    const result = operation();
    outcome = "ok";
    return result;
  } finally {
    const durationMs = performance.now() - started;
    target.publish({
      engine,
      sql: sql === undefined ? undefined : normalizeSql(engine, sql),
      threadId,
      outcome,
      durationMs,
    });
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
          observeDatabaseOperation("sqlite", "statement", sql, () => execute(...parameters)),
      });
    }
    const iterate = statement.iterate.bind(statement);
    statement.iterate = (...parameters) => {
      const iterator = iterate(...parameters);
      if (!channels.statement.hasSubscribers) {
        return iterator;
      }
      let durationMs = 0;
      let executed = false;
      let finished = false;
      const finish = (outcome: "ok" | "error") => {
        if (finished) {
          return;
        }
        finished = true;
        if (executed) {
          channels.statement.publish({
            engine: "sqlite",
            sql: normalizeSql("sqlite", sql),
            threadId,
            outcome,
            durationMs,
          });
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
