import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import {
  findSqlClosingParenthesis,
  hasUnquotedSqlKeyword,
  normalizeSqlIdentifier,
  normalizeSqlWhitespace,
  quoteSqliteIdentifier,
  readSqlToken,
} from "./sqlite-schema-sql.js";

const SQLITE_STRICT_DATATYPES: Record<string, true> = {
  ANY: true,
  BLOB: true,
  INT: true,
  INTEGER: true,
  REAL: true,
  TEXT: true,
};

/** Classify one nullable addition without executing comparison DDL or touching source state. */
export function isCompatibleAdditiveColumnDefinition(definition: string): boolean {
  const sql = normalizeSqlWhitespace(definition);
  const name = readSqlToken(sql, 0);
  const type = name ? readSqlToken(sql, name.end) : null;
  if (!name || !type?.keyword || SQLITE_STRICT_DATATYPES[type.keyword] !== true) {
    return false;
  }
  if (type.end === sql.length) {
    return true;
  }
  const checks: string[] = [];
  let collation = "BINARY";
  let offset = type.end;
  try {
    for (let token = readSqlToken(sql, offset); token; token = readSqlToken(sql, offset)) {
      offset = token.end;
      if (token.keyword === "CONSTRAINT") {
        const constraintName = readSqlToken(sql, offset);
        if (!constraintName) {
          return false;
        }
        token = readSqlToken(sql, constraintName.end);
        if (!token) {
          return false;
        }
        offset = token.end;
      }
      if (token.keyword === "NULL") {
        continue;
      }
      if (token.keyword === "COLLATE") {
        const value = readSqlToken(sql, offset);
        if (!value) {
          return false;
        }
        collation = normalizeSqlIdentifier(value.raw);
        if (!["binary", "nocase", "rtrim"].includes(collation)) {
          return false;
        }
        offset = value.end;
        continue;
      }
      if (token.keyword !== "DEFAULT" && token.keyword !== "CHECK") {
        return false;
      }
      while (sql[offset] === " ") {
        offset += 1;
      }
      if (sql[offset] !== "(") {
        const value = readSqlToken(sql, offset);
        if (token.keyword !== "DEFAULT" || value?.keyword !== "NULL") {
          return false;
        }
        offset = value.end;
        continue;
      }
      const close = findSqlClosingParenthesis(sql, offset);
      let expression = sql.slice(offset + 1, close).trim();
      offset = close + 1;
      if (token.keyword === "DEFAULT") {
        while (expression.startsWith("(")) {
          const end = findSqlClosingParenthesis(expression, 0);
          if (end !== expression.length - 1) {
            return false;
          }
          expression = expression.slice(1, end).trim();
        }
        if (expression.toUpperCase() !== "NULL") {
          return false;
        }
      } else {
        // SQLite CHECK declarations cannot contain subqueries.
        if (hasUnquotedSqlKeyword(expression, /\bSELECT\b/giu)) {
          return false;
        }
        checks.push(expression);
      }
    }
  } catch {
    return false;
  }
  if (checks.length === 0) {
    return true;
  }
  const { constants } = requireNodeSqlite();
  using probe = openNodeSqliteDatabase(":memory:", { enableDoubleQuotedStringLiterals: false });
  const deterministic = new Set<string>();
  for (const entry of probe.prepare("PRAGMA function_list").all()) {
    if (
      entry.builtin &&
      entry.type === "s" &&
      typeof entry.flags === "number" &&
      (entry.flags & 0x800) !== 0 &&
      // These functions also accept clock/local-time inputs despite their deterministic flag.
      !/^(?:date|time|datetime|julianday|unixepoch|strftime|timediff)$/u.test(String(entry.name))
    ) {
      deterministic.add(String(entry.name));
    }
  }
  probe.setAuthorizer((action, first, second) =>
    action === constants.SQLITE_SELECT ||
    // Native observers may inspect this empty, private probe's read-only catalog.
    (action === constants.SQLITE_PRAGMA &&
      second === null &&
      ["database_list", "schema_version", "table_list"].includes(first ?? "")) ||
    (action === constants.SQLITE_READ &&
      ["sqlite_master", "sqlite_schema", "sqlite_temp_master", "sqlite_temp_schema"].includes(
        first ?? "",
      )) ||
    (action === constants.SQLITE_FUNCTION && deterministic.has(second ?? ""))
      ? constants.SQLITE_OK
      : constants.SQLITE_DENY,
  );
  try {
    const column = quoteSqliteIdentifier(normalizeSqlIdentifier(name.raw));
    for (const expression of checks) {
      // An omitted NULL default and an explicit NULL are identical. CHECK accepts
      // NULL or a nonzero numeric result; WHERE also rejects aggregates and windows.
      const accepted = probe
        .prepare(
          `SELECT 1 FROM (SELECT NULL COLLATE ${collation} AS ${column}) ` +
            `WHERE CAST((${expression}) AS NUMERIC) IS NOT 0`,
        )
        .get();
      if (!accepted) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    probe.setAuthorizer(null);
  }
}
