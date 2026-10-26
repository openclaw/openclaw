import { randomUUID } from "node:crypto";
import path from "node:path";
import { getEnvironmentData, threadId } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { AGENT_VECTOR_SEARCH_POSTGRES_SQL } from "../../state/openclaw-agent-vector-search-migration.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { PostgresSyncConnection } from "../postgres-sync/connection.js";
import { publishSqliteDatabaseSchemaChange } from "../sqlite-database-admission.js";
import { admitStoreSearch } from "./adapters.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import type { SearchSchema, StoreSchema } from "./contract.js";
import { openPostgresEngineTestStore } from "./engine-store.test-support.js";
import {
  admitPostgresSearch,
  assertPostgresSearchAdmitted,
  pgSearchName,
} from "./postgres-search-schema.js";
import { bindStoreSearch } from "./search.js";
import type { TextQuery } from "./text-contract.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const schema: StoreSchema = {
  id: "search",
  version: 1,
  sqlite: "",
  postgresVectorSearchVersion: 2,
  postgres: `CREATE TABLE notes (
    id TEXT PRIMARY KEY, ordinal BIGINT NOT NULL UNIQUE, text TEXT NOT NULL,
    model TEXT NOT NULL, source TEXT NOT NULL, embedding BYTEA
  );`,
  search: {
    text: {
      notes: {
        table: "notes",
        fields: ["text"],
        postgres: { identity: "ordinal", mode: "trigram" },
      },
    },
    vector: {
      notes: {
        table: "notes_vec",
        alias: "v",
        rowShape: { id: "string", distance: "finite-number" },
        postgres: { source: "notes", key: "id", embedding: "embedding", dimensions: 3 },
      },
    },
  },
};
type Note = {
  id: string;
  ordinal: number;
  text: string;
  model: string;
  source: string;
  embedding: Uint8Array | null;
  openclaw_search: unknown;
};
type SearchDB = { notes: Note; notes_vec: { id: string; embedding: unknown } };
type VectorRow = { id: string; distance: number };
const isVectorRow = (value: unknown): value is VectorRow =>
  value !== null &&
  typeof value === "object" &&
  "id" in value &&
  typeof value.id === "string" &&
  "distance" in value &&
  typeof value.distance === "number";
const embedding = (values: readonly number[]) => {
  const bytes = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => bytes.writeDoubleLE(value, index * 8));
  return bytes;
};

async function fixture(
  test: (input: {
    db: PostgresSyncConnection;
    open: () => PostgresSyncConnection;
    invalidate: () => void;
  }) => void | Promise<void>,
) {
  expect(threadId, "The fixture host must retain the native admission descriptor").toBe(0);
  const shared = withEngineStoreAdmission(() => storeFixture());
  try {
    const { result } = withEngineStoreAdmission(() => ({
      result: test({
        db: shared.open(schema),
        open: () => shared.open(schema),
        invalidate: () => publishSqliteDatabaseSchemaChange(shared.anchor),
      }),
    }));
    await result;
  } finally {
    withEngineStoreAdmission(shared.close);
  }
}

function searchFixture(db: PostgresSyncConnection) {
  const k = getNodeSqliteKysely<SearchDB>(db);
  const search = bindStoreSearch(db, schema.search!);
  const index = search.text.notes!;
  const fullText = search.fullText!;
  const insert = db.prepare(
    "INSERT INTO notes(id, ordinal, text, model, source, embedding) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const add = (
    id: string,
    ordinal: number,
    text: string,
    vector: readonly number[] | null = null,
    model = "model-a",
    source = "memory",
  ) => insert.run(id, ordinal, text, model, source, vector ? embedding(vector) : null);
  const text = (query: TextQuery, limit = 20, maxChars = 500) => {
    const rank = fullText.rank(index, query);
    const picked = k
      .selectFrom("notes")
      .select(["id", "text", "openclaw_search", rank.value.as("rank")])
      .where(fullText.match(index, query))
      .orderBy(rank.value, rank.order)
      .orderBy("id")
      .limit(limit + 1);
    const queryWithSnippet = k
      .with(
        (cte) => cte("picked").materialized(),
        () => picked,
      )
      .selectFrom("picked")
      .select([
        "id",
        "rank",
        fullText.snippet({ ...index, alias: "picked" }, "text", 12, query, maxChars).as("snippet"),
      ])
      .orderBy("rank", rank.order)
      .orderBy("id");
    return executeSqliteQuerySync(db, queryWithSnippet).rows;
  };
  const nearest = (vector: readonly number[], model = "model-a", source = "memory", limit = 1) => {
    const vectorIndex = search.vectors.notes!;
    const scoped = () =>
      k
        .selectFrom("notes_vec as v")
        .innerJoin("notes as n", "n.id", "v.id")
        .where("n.model", "=", model)
        .where("n.source", "=", source);
    const { pending } = withEngineStoreAdmission(() => ({
      pending: search.vector!.nearest({
        index: vectorIndex,
        vector,
        limit,
        isRow: isVectorRow,
        scopeCount: k.selectFrom("notes").select(k.fn.countAll<number>().as("count")),
        candidates: ({ match, distance, limit: candidateLimit }) =>
          scoped()
            .select("v.id")
            .where(match)
            .orderBy(distance)
            .orderBy("v.id")
            .limit(candidateLimit),
        query: ({ match, distance }) =>
          scoped()
            .select(["n.id", distance.as("distance")])
            .where(match)
            .orderBy(distance)
            .orderBy("n.id")
            .limit(limit),
      }),
    }));
    return pending;
  };
  const ids = (query: TextQuery) => text(query).map((row) => row.id);
  const storedVector = (id: string) =>
    db.prepare("SELECT embedding FROM notes WHERE id = ?").get(id)!.embedding;
  return { add, text, ids, nearest, search, storedVector };
}

const populateText = (add: ReturnType<typeof searchFixture>["add"]) => {
  add("short", 1, "café blue fox");
  add("long", 2, "café blue fox " + "unrelated background words ".repeat(40));
  add("reverse", 3, "fox blue café");
  add("prefix", 4, "blue foxtrot");
  add("other", 5, "green turtle decoy 50xxoff and backslash");
  add("literal", 6, "literal 50%_off and back\\slash café2026 préfixe2026-étape2");
};
const term = (text: string): TextQuery => ({ kind: "term", text });
const terms = (kind: "any" | "all", ...texts: string[]): TextQuery => ({
  kind,
  clauses: texts.map(term),
});

describe.skipIf(!connection)("PostgreSQL engine search conformance", () => {
  it("keeps cover-density ranking by default and supports a frequency opt-in", () =>
    fixture(({ db }) => {
      const { add, search } = searchFixture(db);
      add("adjacent", 1, "red fox");
      const fullText = search.fullText!;
      const index = search.text.notes!;
      const query = terms("all", "red", "fox");
      const row = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<SearchDB>(db)
          .selectFrom("notes")
          .select([
            fullText.rank(index, query).value.as("default_rank"),
            fullText
              .rank(index, query, { postgres: { normalization: 0 } })
              .value.as("cover_density"),
            fullText
              .rank(index, query, { postgres: { normalization: 0, rank: "frequency" } })
              .value.as("frequency"),
          ]),
      ).rows[0]!;
      expect(row.default_rank).toBeCloseTo(0.05, 6);
      expect(row.cover_density).toBeCloseTo(0.1, 6);
      expect(row.frequency).toBeCloseTo(0.09910322, 6);
    }));

  it("composes literal terms, phrases, final-lexeme prefixes and OR with bounded ranked snippets", () =>
    fixture(({ db }) => {
      const { add, text, ids, search } = searchFixture(db);
      db.runTransaction(() => populateText(add));
      expect(ids({ kind: "term", text: "cafe" }).toSorted()).toEqual(["long", "reverse", "short"]);
      expect(ids({ kind: "term", text: "cafe2026" })).toEqual(["literal"]);
      expect(ids({ kind: "term", text: "prefixe2026-etape2" })).toEqual(["literal"]);
      expect(ids({ kind: "phrase", text: "blue fox" })).toEqual(["short", "long"]);
      expect(ids({ kind: "phrase", text: "blue fox", prefix: true }).toSorted()).toEqual([
        "long",
        "prefix",
        "short",
      ]);
      expect(ids(terms("any", "turtle", "foxtrot")).toSorted()).toEqual(["other", "prefix"]);
      expect(ids(terms("all", "cafe", "fox")).toSorted()).toEqual(["long", "reverse", "short"]);
      expect(text({ kind: "term", text: "blue | turtle" })).toEqual([]);
      expect(() =>
        search.fullText!.snippet(search.text.notes!, "text", 1, { kind: "term", text: "blue" }),
      ).toThrow(/at least/i);
      const ranked = text({ kind: "phrase", text: "blue fox" }, 1, 48);
      expect(ranked).toHaveLength(2);
      expect(ranked[0]!.id).toBe("short");
      expect(ranked[0]!.rank).toBeGreaterThan(ranked[1]!.rank);
      for (const row of ranked) {
        expect(row.snippet.length).toBeLessThanOrEqual(48);
        expect(row.snippet).toContain("blue fox");
      }
    }));

  it("uses trigram contains literally, including wildcard and escape characters", () =>
    fixture(({ db }) => {
      const { add, text } = searchFixture(db);
      db.runTransaction(() => populateText(add));
      const { fullText, text: indexes } = bindStoreSearch(db, schema.search!);
      const k = getNodeSqliteKysely<SearchDB>(db);
      for (const needle of ["50%_off", "back\\slash", "BLUE FOX"]) {
        const rows = executeSqliteQuerySync(
          db,
          k
            .selectFrom("notes")
            .select("id")
            .where(fullText!.match(indexes.notes!, { kind: "contains", text: needle }))
            .orderBy("id"),
        ).rows;
        expect(rows.map((row) => row.id)).toEqual(
          needle === "BLUE FOX" ? ["long", "prefix", "short"] : ["literal"],
        );
      }
      expect(text({ kind: "term", text: "missing" })).toEqual([]);
    }));

  it("computes exact float32 cosine after model/source eligibility and preserves binary64 source", () =>
    fixture(async ({ db }) => {
      const { add, nearest, storedVector } = searchFixture(db);
      const precise = [0.12345678912345678, 0.9876543219876543, 0.3333333333333333];
      db.runTransaction(() => {
        for (let i = 0; i < 20; i++) {
          add(`wrong-model-${i}`, 10 + i, "excluded exact", [1, 0, 0], "model-b");
          add(`wrong-source-${i}`, 30 + i, "excluded exact", [1, 0, 0], "model-a", "session");
        }
        add("eligible", 3, "eligible diagonal", [1, 1, 0]);
        add("opposite", 4, "eligible opposite", [-1, 0, 0]);
        add("precise", 5, "precision", precise, "precision");
        add("orthogonal", 6, "eligible orthogonal", [0, 1, 0]);
        add("zero", 7, "no cosine direction", [0, 0, 0]);
        add("underflow", 8, "float32 rounds to zero", [2 ** -150, 1, 0], "underflow");
      });
      for (const invalid of [
        [Number.NaN, 0, 0],
        [Infinity, 0, 0],
        [1e39, 0, 0],
        [1, 2],
      ]) {
        expect(() => db.runTransaction(() => add("invalid", 9, "invalid", invalid))).toThrow();
      }
      expect(db.prepare("SELECT id FROM notes WHERE id = 'invalid'").get()).toBeUndefined();
      expect(storedVector("precise")).toEqual(new Uint8Array(embedding(precise)));
      expect(storedVector("underflow")).toEqual(new Uint8Array(embedding([2 ** -150, 1, 0])));
      const result = await nearest([1, 0, 0], "model-a", "memory", 3);
      expect(result.fallbackScanRequired).toBe(false);
      expect(result.rows.map((row) => row.id)).toEqual(["eligible", "orthogonal", "opposite"]);
      expect(result.rows[0]!.distance).toBeCloseTo(1 - 1 / Math.sqrt(2), 6);
      expect(result.rows[1]!.distance).toBe(1);
      expect(result.rows[2]!.distance).toBe(2);
      expect(
        db
          .prepare("SELECT embedding_bits::text AS bits FROM notes_vec WHERE id = 'opposite'")
          .get(),
      ).toEqual({ bits: "000" });
      expect(db.prepare("SELECT embedding_bits FROM notes_vec WHERE id = 'zero'").get()).toEqual({
        embedding_bits: null,
      });
      const negative = await nearest([-1, -0.01, 0]);
      expect(negative.rows[0]!.id).toBe("opposite");
      expect(negative.rows[0]!.distance).toBeCloseTo(1 - 1 / Math.hypot(1, 0.01), 6);
      const measured = await nearest([1, 0, 0], "precision");
      const rounded = precise.map(Math.fround);
      expect(measured.rows[0]!.distance).toBeCloseTo(1 - rounded[0]! / Math.hypot(...rounded), 6);
      expect((await nearest([1, 0, 0], "underflow")).rows).toEqual([
        { id: "underflow", distance: 1 },
      ]);
      await expect(nearest([0, 0, 0])).rejects.toThrow("nonzero");
      await expect(nearest([1, 0])).rejects.toThrow("dimensions");
      await expect(nearest([1e39, 0, 0])).rejects.toThrow("finite");
      await expect(nearest([Number.NaN, 0, 0])).rejects.toThrow("finite");
    }));

  it("synchronizes source writes and deletes transactionally and rebuilds only derived projections", () =>
    fixture(async ({ db }) => {
      const { add, text, ids, nearest, search, storedVector } = searchFixture(db);
      db.exec(`CREATE FUNCTION reject_projection_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'unnecessary projection DELETE'; END $$;
CREATE TRIGGER reject_projection_delete BEFORE DELETE ON notes_vec
FOR EACH STATEMENT EXECUTE FUNCTION reject_projection_delete();`);
      db.runTransaction(() => {
        add("kept", 1, "firstword", [0, 1, 0]);
        db.prepare("UPDATE notes SET embedding = ? WHERE id = ?").run(embedding([1, 0, 0]), "kept");
      });
      expect(ids({ kind: "term", text: "firstword" })).toEqual(["kept"]);
      expect(() =>
        db.runTransaction(() => {
          db.prepare("UPDATE notes SET text = ?, embedding = ? WHERE id = ?").run(
            "rolledword",
            embedding([0, 1, 0]),
            "kept",
          );
          add("rolled", 2, "rolledword", [0, 1, 0]);
          throw new Error("rollback fixture");
        }),
      ).toThrow("rollback fixture");
      expect(text({ kind: "term", text: "rolledword" })).toEqual([]);
      expect(
        db.prepare("SELECT embedding::text AS embedding FROM notes_vec WHERE id = 'kept'").get(),
      ).toEqual({ embedding: "[1,0,0]" });
      expect(db.prepare("SELECT id FROM notes_vec WHERE id = 'rolled'").get()).toBeUndefined();
      db.exec("DROP TRIGGER reject_projection_delete ON notes_vec");
      const before = storedVector("kept");
      db.runTransaction(() => {
        db.prepare("UPDATE notes SET text = ?, embedding = ? WHERE id = ?").run(
          "secondword",
          embedding([0, 1, 0]),
          "kept",
        );
        add("deleted", 3, "deletedword", [1, 0, 0]);
        db.prepare("DELETE FROM notes WHERE id = ?").run("deleted");
        add("text-only", 4, "keywordonly", []);
      });
      expect(text({ kind: "term", text: "firstword" })).toEqual([]);
      expect(ids({ kind: "term", text: "secondword" })).toEqual(["kept"]);
      expect(db.prepare("SELECT id FROM notes_vec ORDER BY id").all()).toEqual([{ id: "kept" }]);
      expect(ids({ kind: "term", text: "keywordonly" })).toEqual(["text-only"]);
      expect(storedVector("kept")).not.toEqual(before);
      const updated = storedVector("kept");
      db.runTransaction(() => {
        db.exec("DELETE FROM notes_vec");
        search.rebuild!();
      });
      expect(storedVector("kept")).toEqual(updated);
      const result = await nearest([0, 1, 0]);
      expect(result.rows).toEqual([{ id: "kept", distance: 0 }]);
      withEngineStoreAdmission(() => {
        db.runTransaction(() => {
          db.prepare("UPDATE notes SET embedding = ? WHERE id = ?").run(embedding([]), "kept");
        });
        expect(db.prepare("SELECT id FROM notes_vec").all()).toEqual([]);
        expect(ids({ kind: "term", text: "secondword" })).toEqual(["kept"]);
      });
    }));

  it.each([
    ["GIN index", "DROP INDEX notes_search_gin"],
    ["binary projection", "ALTER TABLE notes_vec DROP COLUMN embedding_bits"],
    [
      "text configuration",
      "ALTER TEXT SEARCH CONFIGURATION openclaw_simple_unaccent ALTER MAPPING FOR word WITH pg_catalog.simple",
    ],
  ])("rejects %s drift when the admitted store reopens", async (_name, change) => {
    await fixture(({ db, open, invalidate }) => {
      db.exec(change);
      invalidate();
      expect(open).toThrow("schema drift");
    });
  });
});

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
const sparseEmbedding = (dim: number, value: number) => {
  const bytes = Buffer.alloc(dim * 8);
  bytes.writeDoubleLE(value);
  return bytes;
};

function storeFixture(dsn = connection!) {
  const anchor = openNodeSqliteDatabase(path.join(dirs.make("pg-vector-search-"), "anchor.sqlite"));
  const opened: PostgresSyncConnection[] = [];
  return {
    anchor,
    open(this: void, selectedSchema: StoreSchema, existingVersion = false) {
      const db = openPostgresEngineTestStore({
        anchor,
        schema: selectedSchema,
        existingVersion,
        input: { connection: dsn, schemaPrefix: "binary_vector_test" },
        openSqlite() {
          throw new Error("Expected PostgreSQL");
        },
      });
      if (!(db instanceof PostgresSyncConnection)) {
        throw new Error("Expected PostgreSQL");
      }
      opened.push(db);
      return db;
    },
    close(this: void) {
      try {
        if (opened[0]) {
          opened[0].exec(`DROP SCHEMA "${opened[0].schema}" CASCADE`);
        }
      } finally {
        opened.forEach((db) => db.close());
        anchor.close();
      }
    },
  };
}

const readVersion = (db: PostgresSyncConnection) =>
  db.prepare("SELECT version FROM openclaw_schema_meta").get()?.version;
const bitColumns = (db: PostgresSyncConnection) =>
  db
    .prepare(
      "SELECT count(*) AS count FROM information_schema.columns WHERE table_schema = ? AND column_name = 'embedding_bits'",
    )
    .get(db.schema)?.count;

describe.skipIf(!connection)("PostgreSQL binary vector schema", () => {
  it("migrates existing optional projections, preserves historical admission and maintains zero eligibility", () =>
    withEngineStoreAdmission(() => {
      const shared = storeFixture();
      const { anchor, open } = shared;
      try {
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
                .run(id, sparseEmbedding(dim, value));
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
        expect(readVersion(original)).toBe(32);
        expect(bitColumns(original)).toBe(0);
        publishSqliteDatabaseSchemaChange(anchor);
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
          expect(readVersion(historical)).toBe(32);
          expect(bitColumns(historical)).toBe(0);
          expect(() => open(destination)).toThrow(/requires pgvector 0.7 or newer/);
        } finally {
          oldVector.mockRestore();
        }
        const migrated = open(destination);
        expect(readVersion(migrated)).toBe(33);
        migrated.runTransaction(() => {
          for (const dim of dimensions) {
            const expectedVector = (id: string, value: number) => ({
              id,
              dimensions: value === 0 ? null : dim,
              bits: value === 0 ? null : (value > 0 ? "1" : "0") + "0".repeat(dim - 1),
              embedding: new Uint8Array(sparseEmbedding(dim, value)),
            });
            expect(
              migrated
                .prepare(`SELECT n.id, n.embedding, v.embedding_bits::text AS bits,
              bit_length(v.embedding_bits) AS dimensions
              FROM notes_${dim} n JOIN vectors_${dim} v USING (id) ORDER BY n.id`)
                .all(),
            ).toEqual([
              expectedVector("negative", -1),
              expectedVector("positive", 1),
              expectedVector("zero", 0),
            ]);
            migrated
              .prepare(`UPDATE notes_${dim} SET embedding = ? WHERE id = 'zero'`)
              .run(sparseEmbedding(dim, 1));
            expect(
              migrated
                .prepare(
                  `SELECT get_bit(embedding_bits, 0) AS sign FROM vectors_${dim} WHERE id = 'zero'`,
                )
                .get()?.sign,
            ).toBe(1);
          }
        });
        admitStoreSearch(migrated, vectorSchema(17), { extension: "vectors-17" });
        migrated.runTransaction(() => {
          migrated.prepare("INSERT INTO notes_17 VALUES (?, ?)").run("new", sparseEmbedding(17, 1));
        });
        expect(
          migrated.prepare("SELECT bit_length(embedding_bits) AS dimensions FROM vectors_17").get()
            ?.dimensions,
        ).toBe(17);

        migrated.runTransaction(() => {
          migrated.exec("ALTER TABLE vectors_3 ALTER COLUMN embedding_bits DROP EXPRESSION");
        });
        publishSqliteDatabaseSchemaChange(anchor);
        expect(() => open(destination)).toThrow("schema drift");
      } finally {
        shared.close();
      }
    }));

  it("migrates stores without optional vectors without creating vector projections", () => {
    withEngineStoreAdmission(() => {
      const { open, close } = storeFixture();
      try {
        open(source);
        const migrated = open(destination);
        expect(readVersion(migrated)).toBe(33);
      } finally {
        close();
      }
    });
  });
});

const admissionSearch: SearchSchema = {
  text: {
    notes: { table: "notes", fields: ["text"], postgres: { identity: "id", mode: "trigram" } },
  },
  vector: {
    notes: {
      table: "vectors",
      alias: "v",
      rowShape: { id: "string" },
      postgres: { source: "notes", key: "id", embedding: "embedding", dimensions: 3 },
    },
  },
};
function admissionFixture(
  dsn: string,
  search: SearchSchema | undefined,
  run: (db: PostgresSyncConnection) => void,
) {
  withEngineStoreAdmission(() => {
    const { open, close } = storeFixture(dsn);
    try {
      run(
        open({
          id: "search",
          version: 1,
          sqlite: "",
          postgres: "CREATE TABLE notes(id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding BYTEA)",
          search,
        }),
      );
    } finally {
      close();
    }
  });
}
afterEach(() => vi.restoreAllMocks());
describe.skipIf(!connection)("PostgreSQL search admission failures", () => {
  it.each(["0.6.2", "0.7.0"])(
    "gates binary search on pgvector %s once at admission while historical search remains exact",
    (version) => {
      admissionFixture(connection!, undefined, (db) => {
        const selected: SearchSchema = { vector: admissionSearch.vector };
        const namespace = String(db.prepare("SELECT current_schema() AS name").get()?.name);
        const prepare = db.prepare.bind(db);
        vi.spyOn(db, "prepare").mockImplementation((statementSql) => {
          const statement = prepare(statementSql);
          if (statementSql.includes("pg_catalog.pg_available_extensions")) {
            const all = statement.all.bind(statement);
            vi.spyOn(statement, "all").mockImplementation((...values) =>
              all(...values).map((row) =>
                row.name === "vector" ? Object.assign({}, row, { extversion: version }) : row,
              ),
            );
          }
          return statement;
        });
        admitPostgresSearch(db, selected, namespace, 1)?.();
        if (version.startsWith("0.6")) {
          expect(() => admitPostgresSearch(db, selected, namespace, 2)).toThrow(
            /requires pgvector 0.7 or newer.*ALTER EXTENSION vector UPDATE/,
          );
          return;
        }
        admitPostgresSearch(db, selected, namespace, 2)?.();
        expect(admitPostgresSearch(db, selected, namespace, 2)).toBeUndefined();
        assertPostgresSearchAdmitted(db, selected);
      });
    },
  );

  it("refuses unsupported exact dimensions before installing search DDL", () => {
    const selected: SearchSchema = {
      vector: {
        notes: {
          ...admissionSearch.vector!.notes!,
          postgres: { ...admissionSearch.vector!.notes!.postgres!, dimensions: 16_001 },
        },
      },
    };
    expect(() => admissionFixture(connection!, selected, () => {})).toThrow(
      "dimensions must be 1–16000",
    );
  });

  it("names insufficient schema creation privilege", () => {
    admissionFixture(connection!, undefined, (admin) => {
      const role = `r6_${randomUUID().replaceAll("-", "")}`;
      const database = String(admin.prepare("SELECT current_database() AS name").get()?.name);
      admin.exec(`CREATE ROLE ${pgSearchName(role)} LOGIN PASSWORD 'synthetic-search-privilege'`);
      admin.exec(`GRANT CONNECT ON DATABASE ${pgSearchName(database)} TO ${pgSearchName(role)}`);
      try {
        const url = new URL(connection!);
        url.username = role;
        url.password = "synthetic-search-privilege";
        expect(() => admissionFixture(url.href, admissionSearch, () => {})).toThrow(
          "insufficient CREATE privilege",
        );
      } finally {
        admin.exec(
          `REVOKE CONNECT ON DATABASE ${pgSearchName(database)} FROM ${pgSearchName(role)}`,
        );
        admin.exec(`DROP ROLE ${pgSearchName(role)}`);
      }
    });
  });
});
