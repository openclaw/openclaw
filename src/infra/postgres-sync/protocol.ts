import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import type { MessagePort } from "node:worker_threads";

export type PostgresResult = {
  command?: string;
  rows: Record<string, unknown>[];
  rowCount: number;
  fields: { name: string; dataTypeID: number }[];
};
export type PostgresErrorData = {
  name: string;
  message: string;
  stack?: string;
  /** Server SQLSTATE only; socket error codes are not copied by the worker. */
  code?: string;
  detail?: string;
  constraint?: string;
  column?: string;
};
export type BridgeCommand =
  | { operation: "connect" }
  | { operation: "close" }
  | { operation: "query"; sql: string; parameters: readonly SQLInputValue[] };
export type BridgeRequest = BridgeCommand & { id: number };
export type BridgeReply = { id: number } & (
  | { result: PostgresResult }
  | { error: PostgresErrorData }
);
export type BridgeWorkerData = {
  port: MessagePort;
  signal: SharedArrayBuffer;
  url: string;
  schema: string;
};

/** Rewrite anonymous bindings without changing quoted SQL, comments, or escaped ?? operators. */
export function rewritePostgresPlaceholders(sql: string): string {
  let result = "";
  let parameter = 0;
  let statementStart = true;
  for (let i = 0; i < sql.length;) {
    const rest = sql.slice(i);
    const quoted =
      /^(?:[eE]'(?:\\[\s\S]|''|[^'\\])*'|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*(?:\n|$))/.exec(
        rest,
      );
    const dollar = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(rest)?.[0];
    if (rest.startsWith("/*")) {
      let end = i + 2;
      let depth = 1;
      while (end < sql.length && depth > 0) {
        if (sql.startsWith("/*", end)) {
          depth++;
          end += 2;
        } else if (sql.startsWith("*/", end)) {
          depth--;
          end += 2;
        } else {
          end++;
        }
      }
      result += sql.slice(i, end);
      i = end;
    } else if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length);
      const next = end < 0 ? sql.length : end + dollar.length;
      result += sql.slice(i, next);
      i = next;
      statementStart = false;
    } else if (quoted) {
      result += quoted[0];
      i += quoted[0].length;
      if (!quoted[0].startsWith("--")) {
        statementStart = false;
      }
    } else {
      if (statementStart && /^pragma\b/i.test(rest)) {
        throw new Error("The experimental PostgreSQL engine does not support PRAGMA statements");
      }
      const character = sql.charAt(i);
      if (character === "?" && sql[i + 1] === "?") {
        result += "?";
        i += 2;
      } else if (character === "?") {
        result += `$${++parameter}`;
        i++;
      } else {
        result += character;
        i++;
      }
      if (character === ";") {
        statementStart = true;
      } else if (!/\s/.test(character)) {
        statementStart = false;
      }
    }
  }
  return result;
}

export function validatePostgresBindings(parameters: readonly unknown[]): void {
  for (const value of parameters) {
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "bigint" &&
      !ArrayBuffer.isView(value)
    ) {
      throw new TypeError(
        "SQL bindings must be null, numbers, bigints, strings, or ArrayBuffer views",
      );
    }
  }
}

export function decodePostgresRows(result: PostgresResult, readBigInts: boolean) {
  return result.rows.map((row) =>
    Object.fromEntries(
      result.fields.map((field) => {
        const value = row[field.name];
        let decoded: SQLOutputValue;
        if (value === null) {
          decoded = null;
        } else if (field.dataTypeID === 20) {
          if (typeof value !== "string") {
            throw new TypeError("PostgreSQL int8 results must be text");
          }
          const integer = BigInt(value);
          if (readBigInts) {
            decoded = integer;
          } else {
            const number = Number(integer);
            if (!Number.isSafeInteger(number)) {
              throw new RangeError(
                `PostgreSQL int8 ${integer} cannot be represented safely as a number`,
              );
            }
            decoded = number;
          }
        } else if (value instanceof Uint8Array) {
          decoded = new Uint8Array(value);
        } else if (typeof value === "boolean") {
          decoded = Number(value);
        } else if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "bigint"
        ) {
          decoded = value;
        } else {
          throw new TypeError(`Unsupported PostgreSQL result type for column ${field.name}`);
        }
        return [field.name, decoded];
      }),
    ),
  );
}

export function isPostgresConnectionError(sqlState?: string): boolean {
  return !sqlState || sqlState.startsWith("08") || /^57P0[123]$/.test(sqlState);
}

export function decodePostgresError(data: PostgresErrorData): Error {
  const cause = Object.assign(new Error(data.message), data);
  const constraints: Record<string, [number, string]> = {
    "23505": [2067, "UNIQUE"],
    "23503": [787, "FOREIGN KEY"],
    "23502": [1299, "NOT NULL"],
    "23514": [275, "CHECK"],
  };
  const constraint = constraints[data.code ?? ""];
  return constraint
    ? Object.assign(
        new Error(
          `${constraint[1]} constraint failed: ${data.constraint ?? data.column ?? "unknown"}`,
          { cause },
        ),
        { code: "ERR_SQLITE_ERROR", errcode: constraint[0] },
      )
    : cause;
}
