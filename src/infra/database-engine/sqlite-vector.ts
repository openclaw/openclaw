import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createQueryId, sql, SqliteQueryCompiler, type RootOperationNode } from "kysely";
import { sqliteStringSetEntries } from "../kysely-sync.js";
import { createSqliteMemoryVectorSchema } from "./sqlite-memory-vector-schema.js";
import { runVectorKnnInSubprocess } from "./sqlite-vector-subprocess.js";
import type {
  SqliteVectorPlan,
  SqliteVectorStatement,
  VectorKnnResponse,
} from "./sqlite-vector-types.js";
import { matchesVectorRow, type VectorCapability, type VectorSearch } from "./vector-contract.js";

// sqlite-vec v0.1.9 rejects KNN queries with k above 4096.
const MAX_VECTOR_KNN_K = 4096;
const compiler = new SqliteQueryCompiler();
const vectorToBlob = (embedding: readonly number[]) =>
  Buffer.from(new Float32Array(embedding).buffer);
function compileStatement(source: { toOperationNode(): RootOperationNode }): SqliteVectorStatement {
  const { sql: statement, parameters } = compiler.compileQuery(
    source.toOperationNode(),
    createQueryId(),
  );
  // SAFETY: Kysely preserves native SQL bindings; the private candidate marker is replaced before use.
  return { sql: statement, parameters: parameters as SQLInputValue[] };
}

/** Native L2 candidates, cosine reranking, and the existing bounded underfill decision. */
export function runSqliteVectorQuery(
  db: Pick<DatabaseSync, "prepare">,
  plan: SqliteVectorPlan,
): VectorKnnResponse {
  const run = (candidateLimit: number) => {
    const parameters = [...plan.query.parameters];
    parameters[plan.candidateParameter] = candidateLimit;
    const rows = db.prepare(plan.query.sql).all(...parameters);
    for (const row of rows) {
      if (!matchesVectorRow(row, plan.rowShape)) {
        throw new Error("memory vector KNN query returned an invalid row");
      }
      const prefix = plan.textPrefix;
      const text = prefix && row[prefix.column];
      if (prefix && typeof text === "string") {
        row[prefix.column] = truncateUtf16Safe(text, prefix.maxChars);
      }
    }
    return rows;
  };
  const candidateLimit = Math.min(plan.limit * 8, MAX_VECTOR_KNN_K);
  let rows = run(candidateLimit);
  if (rows.length < plan.limit) {
    const count = Number(
      db.prepare(plan.scopeCount.sql).get(...plan.scopeCount.parameters)?.count ?? 0,
    );
    if (count > rows.length) {
      const vectorCount = Number(
        db
          .prepare(`SELECT COUNT(*) AS count FROM (SELECT 1 FROM ${plan.vectorTable} LIMIT ?)`)
          .get(MAX_VECTOR_KNN_K + 1)?.count ?? 0,
      );
      const widenedLimit = Math.min(vectorCount, MAX_VECTOR_KNN_K);
      if (widenedLimit > candidateLimit) {
        rows = run(widenedLimit);
      }
      if (vectorCount > MAX_VECTOR_KNN_K && rows.length < Math.min(plan.limit, count)) {
        return { rows: [], fallbackScanRequired: true };
      }
    }
  }
  return { rows, fallbackScanRequired: false };
}

export function bindSqliteVectorCapability(
  admitted: { store: object; databasePath: string },
  db?: DatabaseSync,
): VectorCapability {
  const own = (index: VectorSearch<unknown>["index"]) => {
    if (index.store !== admitted.store || (db && !db.isOpen)) {
      throw new Error("Vector index is not admitted to this open store");
    }
  };
  return {
    idSet(index, ids) {
      own(index);
      // Retain the caller's JSON bytes; the string-set encoder normalizes code points.
      return /* kysely-allow-raw: Native set projection keeps IDs bound through the string-set helper. */ sql<string>`SELECT value FROM ${sqliteStringSetEntries(JSON.stringify(ids))}`;
    },
    prepareExists(index) {
      own(index);
      if (!db) {
        throw new Error("Vector lookup requires the admitted reader");
      }
      const lookup = db.prepare(`SELECT id FROM ${index.table} WHERE id = ?`);
      return (id) => {
        own(index);
        return Boolean(lookup.get(id));
      };
    },
    async nearest<Row>(request: VectorSearch<Row>) {
      own(request.index);
      const candidate = Symbol("vector-candidate-limit");
      const embedding =
        /* kysely-allow-raw: Alias comes from the admitted vector index declaration. */ sql.raw(
          `${request.index.alias}.embedding`,
        );
      // The former JSON request normalized -0 and nonfinite query numbers before encoding.
      const vector = admitted.databasePath
        ? request.vector.map((value) => (Number.isFinite(value) ? value + 0 : 0))
        : request.vector;
      const blob = vectorToBlob(vector);
      const query = compileStatement(
        request.query({
          match: /* kysely-allow-raw: sqlite-vec candidate matching binds both vector and candidate limit. */ sql<boolean>`${embedding} MATCH ${blob} AND k = ${candidate}`,
          distance: /* kysely-allow-raw: Native cosine distance reranks the admitted vector candidates. */ sql<number>`vec_distance_cosine(${embedding}, ${blob})`,
        }),
      );
      const plan: SqliteVectorPlan = {
        query,
        scopeCount: compileStatement(request.scopeCount),
        vectorTable: request.index.table,
        rowShape: request.index.rowShape,
        textPrefix: request.textPrefix,
        limit: request.limit,
        candidateParameter: query.parameters.findIndex(
          (parameter: unknown) => parameter === candidate,
        ),
      };
      if (plan.candidateParameter < 0) {
        throw new Error("Vector query omitted native candidate matching");
      }
      plan.query.parameters = [...plan.query.parameters];
      plan.query.parameters[plan.candidateParameter] = 0;
      let response: VectorKnnResponse<Row>;
      if (db && !admitted.databasePath) {
        const result = runSqliteVectorQuery(db, plan);
        if (!result.rows.every(request.isRow)) {
          throw new Error("memory vector KNN query returned an invalid row");
        }
        response = { rows: result.rows, fallbackScanRequired: result.fallbackScanRequired };
      } else {
        response = await runVectorKnnInSubprocess({
          databasePath: admitted.databasePath,
          extensionPath: request.extensionPath,
          request: plan,
          isRow: request.isRow,
          signal: request.signal,
        });
      }
      own(request.index);
      return { rows: response.rows, fallbackScanRequired: response.fallbackScanRequired };
    },
    remove(index, scope) {
      own(index);
      if (!db) {
        throw new Error("Vector deletion requires the admitted writer");
      }
      if ("toOperationNode" in scope) {
        const query = compileStatement(scope);
        db.prepare(`DELETE FROM ${index.table} WHERE id IN (${query.sql})`).run(
          ...query.parameters,
        );
      } else {
        // sqlite-vec only uses primary-key lookup for scalar equality.
        const deletion = db.prepare(`DELETE FROM ${index.table} WHERE id = ?`);
        for (const id of scope) {
          deletion.run(id);
        }
      }
    },
    drop(index) {
      own(index);
      if (!db) {
        throw new Error("Vector deletion requires the admitted writer");
      }
      db.exec(`DROP TABLE IF EXISTS ${index.table}`);
    },
    create(index, dimensions, ifNotExists = false) {
      own(index);
      if (!db) {
        throw new Error("Vector index creation requires the admitted writer");
      }
      createSqliteMemoryVectorSchema(db, index.table, dimensions, ifNotExists);
    },
    write(index, rows) {
      own(index);
      if (!db) {
        throw new Error("Vector writes require the admitted writer");
      }
      if (rows.length === 0) {
        return;
      }
      const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
      // sqlite-vec only uses its primary-key lookup for scalar equality.
      const deletion = db.prepare(`DELETE FROM ${index.table} WHERE id = ?`);
      for (const row of unique) {
        deletion.run(row.id);
      }
      db.prepare(
        `INSERT INTO ${index.table} (id, embedding) VALUES ${unique.map(() => "(?, ?)").join(",")}`,
      ).run(...unique.flatMap((row) => [row.id, vectorToBlob(row.embedding)]));
    },
  };
}
