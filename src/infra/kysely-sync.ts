import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { toUSVString } from "node:util";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { Compilable, CompiledQuery, Kysely, QueryResult, RawBuilder } from "kysely";
import {
  InsertQueryNode,
  Kysely as KyselyInstance,
  SelectQueryNode,
  sql as kyselySql,
  SqliteDialect,
} from "kysely";
import { isNodeVersionAtLeast, parseNodeReleaseVersion } from "../../node-version.mjs";
import {
  executeWithCachedStatement,
  installStatementInvalidation,
  kyselyByDatabase,
  queryErrorHandlerByDatabase,
} from "./kysely-sync-cache-state.js";
import { PostgresSyncConnection } from "./postgres-sync/connection.js";
import { OpenClawPostgresDialect, sqliteStringSetNodes } from "./postgres-sync/query-compiler.js";
import type { SqlConnection } from "./sql-connection.js";
import { captureSqliteReaderOwner, retainSqliteReader } from "./sqlite-reader-lifecycle.js";

// Node 24.20 and 26.6 fixed all() column counts after statement reprepare (nodejs/node#64219).
const nodeVersion = parseNodeReleaseVersion(process.versions.node);
const supportsRepreparedAll =
  !process.versions.bun &&
  ((nodeVersion?.major === 24 &&
    isNodeVersionAtLeast(nodeVersion, { major: 24, minor: 20, patch: 0 })) ||
    isNodeVersionAtLeast(nodeVersion, { major: 26, minor: 6, patch: 0 }));

export {
  clearNodeSqliteKyselyCacheForDatabase,
  enableNodeSqliteKyselyStatementCache,
} from "./kysely-sync-cache-state.js";

const compileOnlySqliteDialect = new SqliteDialect({
  // The lazy database factory leaves compilation usable while direct execution fails fast.
  database: async () => {
    throw new Error(
      "getNodeSqliteKysely() returns a compile-only Kysely facade; use executeSqliteQuerySync() to execute node:sqlite queries.",
    );
  },
});

const postgresKyselyByDatabase = new WeakMap<PostgresSyncConnection, Kysely<unknown>>();
const compileOnlyPostgresDialect = new OpenClawPostgresDialect({
  pool: async () => {
    throw new Error("getNodeSqliteKysely() returns a compile-only Kysely facade.");
  },
});

export function getNodeSqliteKysely<Database>(db: SqlConnection): Kysely<Database>;
// Keep the native signature last for existing callers deriving their handle type with Parameters.
export function getNodeSqliteKysely<Database>(db: DatabaseSync): Kysely<Database>;
export function getNodeSqliteKysely<Database>(db: SqlConnection): Kysely<Database> {
  if (db instanceof PostgresSyncConnection) {
    let kysely = postgresKyselyByDatabase.get(db);
    if (!kysely) {
      kysely = new KyselyInstance({ dialect: compileOnlyPostgresDialect });
      postgresKyselyByDatabase.set(db, kysely);
    }
    // SAFETY: this compile-only facade stores no rows; Database supplies the caller's schema types.
    return kysely as Kysely<Database>;
  }
  if (!(db instanceof DatabaseSync)) {
    throw new TypeError("Unsupported synchronous SQL connection");
  }
  const existing = kyselyByDatabase.get(db) as Kysely<unknown> | undefined;
  if (existing) {
    return existing as Kysely<Database>;
  }
  const kysely = new KyselyInstance<Database>({
    dialect: compileOnlySqliteDialect,
  });
  kyselyByDatabase.set(db, kysely as Kysely<unknown>);
  return kysely;
}

/** A single bound set avoids SQLite parameter and JS variadic-call limits. */
export function encodeSqliteStringSet(values: readonly (string | null)[]): string {
  // Keep node:sqlite's USV binding. SQLite 3.44 needs JSON5 \x00 to retain NUL;
  // consuming escaped backslashes first preserves literal "\\u0000" keys.
  return JSON.stringify(
    values.map((value) => (value === null ? null : toUSVString(value))),
  ).replace(/\\(?:\\|u0000)/g, (escape) => (escape === "\\u0000" ? "\\x00" : escape));
}

export function sqliteStringSet(values: readonly string[]): RawBuilder<string> {
  /* kysely-allow-raw: JSON table-valued selection keeps one read snapshot and outer query ordering. */
  const expression = kyselySql<string>`(SELECT value FROM json_each(${encodeSqliteStringSet(values)}))`;
  sqliteStringSetNodes.set(expression.toOperationNode(), "values");
  return expression;
}

/** Expands encoded string tuples without adding one SQLite parameter per field. */
export function sqliteStringSetEntries(
  encoded: string | RawBuilder<string>,
): RawBuilder<{ key: number; value: string | null }> {
  const expression = kyselySql<{ key: number; value: string | null }>`json_each(${encoded})`;
  sqliteStringSetNodes.set(expression.toOperationNode(), "entries");
  return expression;
}

function reportNodeSqliteKyselyQueryError(db: DatabaseSync, error: unknown): void {
  try {
    queryErrorHandlerByDatabase.get(db)?.(error);
  } catch {
    // Lifecycle cleanup must never replace the database error seen by the caller.
  }
}

function releaseSqliteIterator(
  iterator: Iterator<unknown>,
  reader: ReturnType<typeof retainSqliteReader>,
  failed: boolean,
  cleanupErrorMessage: string,
): void {
  let cleanupError: unknown;
  try {
    iterator.return?.();
  } catch (error) {
    cleanupError = error;
  }
  reader.release();
  if (!failed && cleanupError !== undefined) {
    throw toErrorObject(cleanupError, cleanupErrorMessage);
  }
}

/** Execute a compiled Kysely query synchronously against node:sqlite. */
function executeCompiledSqliteQuerySync<Row>(
  db: SqlConnection,
  compiledQuery: CompiledQuery<Row>,
  firstRowOnly = false,
  parameters = compiledQuery.parameters as SQLInputValue[],
): QueryResult<Row> {
  if (db instanceof PostgresSyncConnection) {
    const result = db.query(compiledQuery.sql, parameters);
    // SAFETY: the compiled Kysely query defines Row; the bridge preserves its selected column names.
    const rows = (firstRowOnly ? result.rows.slice(0, 1) : result.rows) as Row[];
    // Unlike SQLite rowids, PostgreSQL insert identities must be requested with RETURNING.
    return result.columns.length > 0
      ? { rows }
      : { rows: [], numAffectedRows: BigInt(result.rowCount) };
  }
  if (!(db instanceof DatabaseSync)) {
    throw new TypeError("Unsupported synchronous SQL connection");
  }
  try {
    const sql = compiledQuery.sql;
    installStatementInvalidation(db);
    return executeWithCachedStatement(db, sql, parameters, (statement) => {
      if (firstRowOnly && SelectQueryNode.is(compiledQuery.query)) {
        // get() reads columns after step/reprepare and resets the reader before returning.
        // Raw SQL and writes still run to completion through the general executor.
        // SAFETY: the compiled Kysely selection defines the native result row shape.
        const row = statement.get(...parameters) as Row | undefined;
        return { rows: row === undefined ? [] : [row] };
      }
      // SELECT already guarantees a reader; avoid allocating native column metadata
      // just to classify it. Raw SQL and other roots still need native classification.
      if (SelectQueryNode.is(compiledQuery.query) || statement.columns().length > 0) {
        if (supportsRepreparedAll) {
          // SAFETY: the compiled Kysely query defines the native result row shape.
          return { rows: statement.all(...parameters) as Row[] };
        }
        // Older Node all() snapshots the column count before SQLite can reprepare
        // an expired statement. Eagerly consuming iterate() reads it after step.
        const iterator = statement.iterate(...parameters);
        const reader = retainSqliteReader(db, "kysely eager query");
        let failed = false;
        let failure: unknown;
        const rows: Row[] = [];
        try {
          for (const row of iterator) {
            reader.progress();
            rows.push(row as Row);
          }
        } catch (error) {
          failed = true;
          failure = error;
        }
        releaseSqliteIterator(iterator, reader, failed, "SQLite query cleanup failed");
        if (failed) {
          throw toErrorObject(failure, "SQLite query failed");
        }
        return { rows };
      }

      // SQLite retains a connection-wide 64-bit last rowid even for UPDATE/DELETE.
      // Request bigint results before executing so a valid write cannot fail while
      // Node converts that retained identity to an unsafe JavaScript number.
      statement.setReadBigInts(true);
      let outcome: ReturnType<typeof statement.run>;
      try {
        outcome = statement.run(...parameters);
      } finally {
        statement.setReadBigInts(false);
      }
      const { changes, lastInsertRowid } = outcome;
      const result: QueryResult<Row> = {
        numAffectedRows: BigInt(changes),
        rows: [],
      };
      if (InsertQueryNode.is(compiledQuery.query) && changes > 0) {
        return {
          ...result,
          insertId: BigInt(lastInsertRowid),
        };
      }
      return result;
    });
  } catch (error) {
    reportNodeSqliteKyselyQueryError(db, error);
    throw error;
  }
}

/** Compile and execute a Kysely query synchronously. */
export function executeSqliteQuerySync<Row>(
  db: SqlConnection,
  query: Compilable<Row>,
): QueryResult<Row> {
  return executeCompiledSqliteQuerySync<Row>(db, query.compile());
}

type SqliteQueryBindingBuilder<Params, Row> = (
  parameter: <Value extends SQLInputValue>(read: (params: Params) => Value) => RawBuilder<Value>,
) => Compilable<Row>;

/** Cache compiled query functions or bundles by native connection. */
export function createSqliteQueryCache<
  Queries extends object,
  Connection extends SqlConnection = DatabaseSync,
>(create: (database: Connection) => Queries): (database: Connection) => Queries {
  const queriesByDatabase = new WeakMap<Connection, Queries>();
  return (database) => {
    let queries = queriesByDatabase.get(database);
    if (queries === undefined) {
      queries = create(database);
      queriesByDatabase.set(database, queries);
    }
    return queries;
  };
}

/** Compile fixed SQL and fresh bindings without taking ownership of a native statement. */
export function compileSqliteQueryBindings<Params, Row = unknown>(
  build: SqliteQueryBindingBuilder<Params, Row>,
) {
  const bindings = new Map<unknown, (params: Params) => SQLInputValue>();
  const compiled = build((read) => {
    const marker = Symbol("sqlite-query-parameter");
    bindings.set(marker, read);
    // Kysely preserves bound values in compiler order. Unique markers avoid
    // positional assumptions and collisions with literal query parameters.
    /* kysely-allow-raw: a bound value expression, with no raw SQL or identifiers. */
    return kyselySql<ReturnType<typeof read>>`${marker}`;
  }).compile();
  const readers = compiled.parameters.map((value) => bindings.get(value) ?? (() => value));
  return {
    compiled,
    // Keep bindings invocation-local: SQLite callbacks can re-enter the caller.
    // SAFETY: Kysely bindings pass through unchanged; node:sqlite validates their runtime types.
    bind: (params: Params) => readers.map((read) => read(params)) as SQLInputValue[],
  };
}

/** Compile a fixed query once; bind fresh values through the normal sync executor on each call. */
export function prepareSqliteQuerySync<Params, Row = unknown>(
  db: SqlConnection,
  build: SqliteQueryBindingBuilder<Params, Row>,
): (params: Params) => QueryResult<Row> {
  const { compiled, bind } = compileSqliteQueryBindings(build);
  return (params) => executeCompiledSqliteQuerySync(db, compiled, false, bind(params));
}

/** Compile a fixed first-row read once and bind fresh values on every execution. */
export function prepareSqliteQueryTakeFirstSync<Params, Row = unknown>(
  db: SqlConnection,
  build: SqliteQueryBindingBuilder<Params, Row>,
): (params: Params) => Row | undefined {
  const { compiled, bind } = compileSqliteQueryBindings(build);
  return (params) => executeCompiledSqliteQuerySync<Row>(db, compiled, true, bind(params)).rows[0];
}

/** Compile once and capture fresh bindings before lazily opening each private iterator. */
export function prepareSqliteQueryIterator<Params, Row = unknown>(
  db: SqlConnection,
  build: SqliteQueryBindingBuilder<Params, Row>,
): (params: Params) => IterableIterator<Row> {
  const { compiled, bind } = compileSqliteQueryBindings(build);
  return (params) => {
    const parameters = bind(params);
    return iterateSqliteQuerySync(db, {
      compile: () => ({ ...compiled, parameters }),
    });
  };
}

/** Compile and lazily iterate a Kysely query synchronously against node:sqlite. */
export function iterateSqliteQuerySync<Row>(
  db: SqlConnection,
  query: Compilable<Row>,
): IterableIterator<Row> {
  if (db instanceof PostgresSyncConnection) {
    // The pilot buffers one result; server-side cursor ownership is outside its scope.
    return (function* () {
      yield* executeCompiledSqliteQuerySync(db, query.compile()).rows;
    })();
  }
  if (!(db instanceof DatabaseSync)) {
    throw new TypeError("Unsupported synchronous SQL connection");
  }
  const owner = captureSqliteReaderOwner();
  return (function* () {
    const compiledQuery = query.compile();
    try {
      // Iterators keep statement state across yields. A private statement prevents
      // nested iteration of identical SQL from resetting an earlier iterator.
      const statement = db.prepare(compiledQuery.sql);
      if (!SelectQueryNode.is(compiledQuery.query) && statement.columns().length === 0) {
        return;
      }
      const parameters = compiledQuery.parameters as SQLInputValue[];
      const iterator = statement.iterate(...parameters);
      const reader = retainSqliteReader(db, "kysely iterator", owner);
      let failed = false;
      try {
        for (const row of iterator) {
          reader.progress();
          yield row as Row;
        }
      } catch (error) {
        failed = true;
        throw toErrorObject(error, "SQLite iterator failed");
      } finally {
        releaseSqliteIterator(iterator, reader, failed, "SQLite iterator cleanup failed");
      }
    } catch (error) {
      reportNodeSqliteKyselyQueryError(db, error);
      throw error;
    }
  })();
}

/** Execute a Kysely query synchronously and return its first row. */
export function executeSqliteQueryTakeFirstSync<Row>(
  db: SqlConnection,
  query: Compilable<Row>,
): Row | undefined {
  return executeCompiledSqliteQuerySync(db, query.compile(), true).rows[0];
}
