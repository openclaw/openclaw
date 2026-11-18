import { getEnvironmentData } from "node:worker_threads";
import { sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { AGENT_VECTOR_SEARCH_POSTGRES_SQL } from "../../state/openclaw-agent-vector-search-migration.js";
import { PostgresSyncConnection } from "../postgres-sync/connection.js";
import { admitStoreSearch } from "./adapters.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import type { SearchSchema, StoreSchema } from "./contract.js";
import { createPostgresEngineTestFixture } from "./engine-store.test-support.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);
const dimensions = [3, 2001, 16000];
const source: StoreSchema = {
  id: "agent",
  version: 32,
  sqlite: "",
  postgres: [...dimensions, 17]
    .map((dim) => `CREATE TABLE notes_${dim} (id TEXT PRIMARY KEY, embedding BYTEA)`)
    .join(";\n"),
  postgresVectorDecoderVersion: 2,
};
const destination: StoreSchema = {
  ...source,
  version: 33,
  postgresVectorSearchVersion: 2,
  postgresMigrations: [
    {
      version: 33,
      fromSchema: { postgres: source.postgres!, postgresVectorDecoderVersion: 2 },
      schema: {
        postgres: source.postgres!,
        postgresVectorDecoderVersion: 2,
        postgresVectorSearchVersion: 2,
      },
      sql: AGENT_VECTOR_SEARCH_POSTGRES_SQL,
    },
  ],
};
const vectorSchema = (dim: number): SearchSchema => ({
  vector: {
    notes: {
      table: `vectors_${dim}`,
      alias: "v",
      rowShape: { id: "string" },
      postgres: { source: `notes_${dim}`, key: "id", embedding: "embedding", dimensions: dim },
    },
  },
});
const embedding = (dim: number, value: number) => {
  const bytes = Buffer.alloc(dim * 8);
  bytes.writeDoubleLE(value);
  return bytes;
};

describe.skipIf(!connection)("PostgreSQL binary vector schema", () => {
  it("migrates existing optional projections, preserves historical admission and maintains zero eligibility", async () => {
    const pending: Array<Promise<{ rows: { id: string }[] }>> = [];
    let finish: (() => void) | undefined;
    using store = createPostgresEngineTestFixture({
      directory: dirs.make("pg-vector-search-"),
      connection: connection!,
      schemaPrefix: "binary_vector_test",
      schema: source,
    });
    const { open, invalidate } = store;
    try {
      withEngineStoreAdmission(() => {
        const original = open(source);
        original.runTransaction(() => {
          for (const dim of dimensions) {
            admitStoreSearch(original, vectorSchema(dim), { extension: `vectors-${dim}` });
            for (const [id, value] of [
              ["positive", 1],
              ["negative", -1],
              ["zero", 0],
            ] as const) {
              original
                .prepare(`INSERT INTO notes_${dim} VALUES (?, ?)`)
                .run(id, embedding(dim, value));
            }
          }
        });
        // Override only the migration's catalog input; installed extensions and admission stay real.
        expect(() =>
          open({
            ...destination,
            postgresMigrations: destination.postgresMigrations!.map((migration) =>
              Object.assign({}, migration, {
                sql: migration.sql.replace("regexp_match(extversion,", "regexp_match('0.6.2',"),
              }),
            ),
          }),
        ).toThrow(
          "PostgreSQL binary vector search requires pgvector 0.7 or newer. Upgrade the server extension package, then have a database administrator run ALTER EXTENSION vector UPDATE before reopening the store.",
        );
        expect(original.prepare("SELECT version FROM openclaw_schema_meta").get()?.version).toBe(
          32,
        );
        expect(
          original
            .prepare(
              "SELECT count(*) AS count FROM information_schema.columns WHERE table_schema = ? AND column_name = 'embedding_bits'",
            )
            .get(original.schema)?.count,
        ).toBe(0);
        invalidate();
        // oxlint-disable-next-line typescript/unbound-method -- Forwarded below with the intercepted connection as receiver.
        const prepare = PostgresSyncConnection.prototype.prepare;
        const oldVector = vi
          .spyOn(PostgresSyncConnection.prototype, "prepare")
          .mockImplementation(function (this: PostgresSyncConnection, statementSql) {
            const statement = prepare.call(this, statementSql);
            if (statementSql.includes("pg_catalog.pg_available_extensions")) {
              const all = statement.all.bind(statement);
              vi.spyOn(statement, "all").mockImplementation((...values) =>
                all(...values).map((row) =>
                  row.name === "vector" ? Object.assign({}, row, { extversion: "0.6.2" }) : row,
                ),
              );
            }
            return statement;
          });
        try {
          const historical = open(destination, true);
          expect(
            historical.prepare("SELECT version FROM openclaw_schema_meta").get()?.version,
          ).toBe(32);
          expect(
            historical
              .prepare(
                "SELECT count(*) AS count FROM information_schema.columns WHERE table_schema = ? AND column_name = 'embedding_bits'",
              )
              .get(historical.schema)?.count,
          ).toBe(0);
          expect(() => open(destination)).toThrow(/requires pgvector 0.7 or newer/);
        } finally {
          oldVector.mockRestore();
        }
        const migrated = open(destination);
        expect(migrated.prepare("SELECT version FROM openclaw_schema_meta").get()?.version).toBe(
          33,
        );
        migrated.runTransaction(() => {
          for (const dim of dimensions) {
            expect(
              migrated
                .prepare(
                  `SELECT id, (embedding_bits IS NULL)::int AS excluded, bit_length(embedding_bits) AS dimensions FROM vectors_${dim} ORDER BY id`,
                )
                .all(),
            ).toEqual([
              { id: "negative", excluded: 0, dimensions: dim },
              { id: "positive", excluded: 0, dimensions: dim },
              { id: "zero", excluded: 1, dimensions: null },
            ]);
            expect(
              migrated
                .prepare(
                  `SELECT get_bit(embedding_bits, 0) AS sign FROM vectors_${dim} WHERE id = 'negative'`,
                )
                .get()?.sign,
            ).toBe(0);
            migrated
              .prepare(`UPDATE notes_${dim} SET embedding = ? WHERE id = 'zero'`)
              .run(embedding(dim, 1));
            expect(
              migrated
                .prepare(
                  `SELECT get_bit(embedding_bits, 0) AS sign FROM vectors_${dim} WHERE id = 'zero'`,
                )
                .get()?.sign,
            ).toBe(1);
            expect(
              migrated.prepare(`SELECT embedding FROM notes_${dim} WHERE id = 'negative'`).get()
                ?.embedding,
            ).toEqual(new Uint8Array(embedding(dim, -1)));
          }
        });
        admitStoreSearch(migrated, vectorSchema(17), { extension: "vectors-17" });
        migrated.runTransaction(() => {
          migrated.prepare("INSERT INTO notes_17 VALUES (?, ?)").run("new", embedding(17, 1));
        });
        expect(
          migrated.prepare("SELECT bit_length(embedding_bits) AS dimensions FROM vectors_17").get()
            ?.dimensions,
        ).toBe(17);
        for (const dim of dimensions) {
          const search = admitStoreSearch(migrated, vectorSchema(dim));
          const query = Array<number>(dim).fill(0);
          query[0] = -1;
          const table =
            /* kysely-allow-raw: Table comes from this fixture's admitted vector index. */ sql.table(
              search.vectors.notes!.table,
            );
          pending.push(
            search.vector!.nearest<{ id: string }>({
              index: search.vectors.notes!,
              vector: query,
              limit: 3,
              scopeCount: sql`SELECT count(*) FROM ${table}`,
              isRow: (value): value is { id: string } =>
                typeof value === "object" &&
                value !== null &&
                "id" in value &&
                typeof value.id === "string",
              candidates: ({ match, distance, limit }) =>
                sql`SELECT v.id FROM ${table} AS v WHERE ${match} ORDER BY ${distance}, v.id LIMIT ${limit}`,
              query: ({ match, distance }) =>
                sql`SELECT v.id FROM ${table} AS v WHERE ${match} ORDER BY ${distance}, v.id LIMIT 3`,
            }),
          );
        }
        finish = () => {
          migrated.runTransaction(() => {
            migrated.exec("ALTER TABLE vectors_3 ALTER COLUMN embedding_bits DROP EXPRESSION");
          });
          invalidate();
          expect(() => open(destination)).toThrow("schema drift");
        };
      });
      for (const result of await Promise.allSettled(pending)) {
        if (result.status === "rejected") {
          throw result.reason;
        }
        expect(result.value.rows).toEqual([{ id: "negative" }, { id: "positive" }, { id: "zero" }]);
      }
      withEngineStoreAdmission(() => finish!());
    } finally {
      await Promise.allSettled(pending);
    }
  });

  it("migrates stores without optional vectors without creating vector projections", () => {
    withEngineStoreAdmission(() => {
      using store = createPostgresEngineTestFixture({
        directory: dirs.make("pg-vector-empty-"),
        connection: connection!,
        schemaPrefix: "binary_vector_empty_test",
        schema: source,
      });
      store.open();
      const migrated = store.open(destination);
      expect(migrated.prepare("SELECT version FROM openclaw_schema_meta").get()?.version).toBe(33);
    });
  });
});
