import {
  expressionBuilder,
  sql,
  type AliasableExpression,
  type Expression,
  type RawBuilder,
  type SqlBool,
} from "kysely";
import { isPostgresSqlConnection, type EngineConnection } from "../sql-connection.js";

/**
 * Scalar maximum for non-NULL numeric operands. SQLite max propagates any NULL;
 * PostgreSQL greatest ignores NULLs. Coalesce nullable operands explicitly.
 * Include a SQL-typed numeric operand so PostgreSQL can infer bound values' type.
 */
export function engineGreatest<T extends number | bigint>(
  db: EngineConnection,
  values: readonly [Expression<T>, Expression<T>, ...Expression<T>[]],
): AliasableExpression<T> {
  return expressionBuilder().fn<T>(isPostgresSqlConnection(db) ? "greatest" : "max", values);
}

/**
 * Scalar minimum for non-NULL numeric operands. SQLite min propagates any NULL;
 * PostgreSQL least ignores NULLs. Coalesce nullable operands explicitly.
 * Include a SQL-typed numeric operand so PostgreSQL can infer bound values' type.
 */
export function engineLeast<T extends number | bigint>(
  db: EngineConnection,
  values: readonly [Expression<T>, Expression<T>, ...Expression<T>[]],
): AliasableExpression<T> {
  return expressionBuilder().fn<T>(isPostgresSqlConnection(db) ? "least" : "min", values);
}

/** Literal, one-based substring position; zero if absent, NULL if either operand is NULL. */
export function engineStringPosition(
  db: EngineConnection,
  haystack: Expression<string | null>,
  needle: Expression<string | null>,
): AliasableExpression<number | null> {
  return expressionBuilder().fn<number | null>(isPostgresSqlConnection(db) ? "strpos" : "instr", [
    haystack,
    needle,
  ]);
}

/** Equality including two NULLs; one NULL and one non-NULL value are unequal. */
export function engineNullSafeEqual(
  db: EngineConnection,
  left: Expression<unknown>,
  right: Expression<unknown>,
): RawBuilder<SqlBool> {
  return /* kysely-allow-raw: Engine-owned null-safe equality operator. */ sql<SqlBool>`${left} ${sql.raw(isPostgresSqlConnection(db) ? "is not distinct from" : "is")} ${right}`;
}
