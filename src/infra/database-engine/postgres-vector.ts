import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import type { PostgresSqlConnection } from "../sql-connection.js";
import type { SearchSchema } from "./contract.js";
import { pgSearchName } from "./postgres-search-schema.js";
import { matchesVectorRow, type VectorCapability, type VectorIndex } from "./vector-contract.js";

export function bindPostgresVector(
  db: PostgresSqlConnection,
  store: object,
  schema: SearchSchema,
): VectorCapability {
  const kysely = getNodeSqliteKysely(db);
  const extension = pgSearchName(schema.extensionSchema ?? "public");
  const own = (index: VectorIndex) => {
    if (!db.isOpen || index.store !== store) {
      throw new Error("Vector index is not admitted to this open store");
    }
    return index.postgres!;
  };
  const write = (index: VectorIndex) => {
    const source = own(index);
    if (!db.isTransaction) {
      throw new Error("Vector mutation requires the owner's transaction");
    }
    return source;
  };
  return {
    idSet(index, ids) {
      own(index);
      return /* kysely-allow-raw: Bound JSON elements retain string ID type. */ sql<string>`SELECT value FROM json_array_elements_text(${JSON.stringify(ids)}::json)`;
    },
    prepareExists(index) {
      own(index);
      const statement =
        /* sqlite-allow-raw: PostgreSQL projection lookup uses its admitted identity. */ db.prepare(
          `SELECT id FROM ${pgSearchName(index.table)} WHERE id = ?`,
        );
      return (id) => {
        own(index);
        return Boolean(statement.get(id));
      };
    },
    async nearest(request) {
      const source = own(request.index);
      request.signal?.throwIfAborted();
      if (
        request.vector.length !== source.dimensions ||
        request.vector.some(
          (value) => !Number.isFinite(value) || !Number.isFinite(Math.fround(value)),
        ) ||
        !request.vector.some((value) => Math.fround(value) !== 0)
      ) {
        throw new Error(
          "PostgreSQL cosine query requires a finite nonzero vector matching the admitted dimensions; rebuild for a changed embedding model.",
        );
      }
      const vector = `[${request.vector.map(Math.fround).join(",")}]`;
      const stored =
        /* kysely-allow-raw: The vector column belongs to the admitted index. */ sql.ref(
          `${request.index.alias}.embedding`,
        );
      const distance = /* kysely-allow-raw: Native cosine uses admitted identifiers and a bound vector. */ sql<number>`${sql.ref(`${request.index.alias}.embedding`)} ${sql.raw(`OPERATOR(${extension}.<=>)`)} ${vector}::${sql.raw(extension)}.vector`;
      // Eligibility and LIMIT remain in one caller-owned SQL query; there is no unfiltered candidate window.
      const query = request.query({
        match: /* kysely-allow-raw: Zero vectors have no cosine direction and are ineligible. */ sql<boolean>`${sql.raw(extension)}.vector_norm(${stored}) > 0`,
        distance,
      });
      const rows = executeSqliteQuerySync(db, {
        compile: () =>
          sql`SELECT * FROM (${query}) AS openclaw_candidates LIMIT ${request.limit}`.compile(
            kysely,
          ),
      }).rows;
      if (
        !rows.every(request.isRow) ||
        !rows.every((row) => matchesVectorRow(row, request.index.rowShape))
      ) {
        throw new Error("PostgreSQL vector query returned an invalid row");
      }
      for (const row of rows) {
        const prefix = request.textPrefix;
        if (prefix && row && typeof row === "object") {
          const text = Reflect.get(row, prefix.column);
          if (typeof text === "string") {
            Reflect.set(row, prefix.column, truncateUtf16Safe(text, prefix.maxChars));
          }
        }
      }
      return { rows, fallbackScanRequired: false };
    },
    remove(index, scope) {
      write(index);
      const ids =
        "toOperationNode" in scope
          ? sql`${scope}`
          : sql`SELECT value FROM json_array_elements_text(${JSON.stringify(scope)}::json)`;
      executeSqliteQuerySync(db, {
        compile: () =>
          /* kysely-allow-raw: The table belongs to the admitted store; IDs remain bound. */ sql`DELETE FROM ${sql.table(index.table)} WHERE id IN (${ids})`.compile(
            kysely,
          ),
      });
    },
    drop(index) {
      write(index);
      throw new Error(
        "PostgreSQL vector DDL belongs to store schema admission; rebuild the projection instead",
      );
    },
    create(index, dimensions) {
      const source = write(index);
      if (source.dimensions !== dimensions) {
        throw new Error(
          "PostgreSQL vector dimensions changed; reopen with the new search schema and rebuild",
        );
      }
    },
    write(index, rows) {
      const source = write(index);
      // Refresh from authoritative bytes, never re-encode a caller's possibly rounded embedding.
      const statement =
        /* sqlite-allow-raw: PostgreSQL projection refresh derives from canonical source bytes. */ db.prepare(
          `INSERT INTO ${pgSearchName(index.table)}(id, embedding) SELECT ${pgSearchName(source.key)}, openclaw_vector(${pgSearchName(source.embedding)}, ${source.dimensions}) FROM ${pgSearchName(source.source)} WHERE ${pgSearchName(source.key)} = ? AND octet_length(${pgSearchName(source.embedding)}) > 0 ON CONFLICT (id) DO UPDATE SET embedding = excluded.embedding`,
        );
      for (const row of rows) {
        if (row.embedding.length !== source.dimensions) {
          throw new Error("PostgreSQL embedding dimension mismatch");
        }
        statement.run(row.id);
      }
    },
  };
}
