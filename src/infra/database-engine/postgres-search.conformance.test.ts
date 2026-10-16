import path from "node:path";
import { getEnvironmentData, threadId } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { PostgresSyncConnection } from "../postgres-sync/connection.js";
import { publishSqliteDatabaseSchemaChange } from "../sqlite-database-admission.js";
import { admitSqliteSchema } from "../sqlite-schema-facts.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import type { StoreSchema } from "./contract.js";
import { openEngineStore, readEngineAnchor } from "./open.js";
import { bindStoreSearch } from "./search.js";
import type { TextQuery } from "./text-contract.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const schema: StoreSchema = {
  id: "search",
  version: 1,
  sqlite: "",
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
  const anchor = openNodeSqliteDatabase(path.join(dirs.make("pg-search-"), "anchor.sqlite"));
  const connections: PostgresSyncConnection[] = [];
  const open = () => {
    const db = openEngineStore({
      anchor,
      schema,
      input: { connection: connection!, schemaPrefix: "search_test" },
      openSqlite: () => {
        throw new Error("Unexpected SQLite bootstrap");
      },
      prepareAnchor: () => {},
      inspectSqlite: () => {
        admitSqliteSchema(anchor);
        return { hasExistingData: false, hasEngineAnchor: Boolean(readEngineAnchor(anchor)) };
      },
    });
    if (!(db instanceof PostgresSyncConnection)) {
      throw new Error("Expected PostgreSQL");
    }
    connections.push(db);
    return db;
  };
  try {
    // The synchronous bridge runs before an async test yields; no admission scope spans an await.
    const { result } = withEngineStoreAdmission(() => ({
      result: test({
        db: open(),
        open,
        invalidate: () => publishSqliteDatabaseSchemaChange(anchor),
      }),
    }));
    await result;
  } finally {
    withEngineStoreAdmission(() => {
      try {
        const db = connections[0];
        if (db) {
          db.exec(`DROP SCHEMA "${db.schema}" CASCADE`);
        }
      } finally {
        connections.forEach((db) => db.close());
        anchor.close();
      }
    });
  }
}

function searchFixture(db: PostgresSyncConnection, corpus = "six-notes") {
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
    const started = performance.now();
    const result = executeSqliteQuerySync(db, queryWithSnippet).rows;
    console.info(
      JSON.stringify({
        search: query.kind,
        corpus,
        latencyMs: performance.now() - started,
      }),
    );
    return result;
  };
  const nearest = (vector: readonly number[], model = "model-a", source = "memory", limit = 1) => {
    const vectorIndex = search.vectors.notes!;
    const started = performance.now();
    const { pending } = withEngineStoreAdmission(() => ({
      pending: search.vector!.nearest({
        index: vectorIndex,
        vector,
        limit,
        isRow: isVectorRow,
        scopeCount: k.selectFrom("notes").select(k.fn.countAll<number>().as("count")),
        query: ({ match, distance }) =>
          k
            .selectFrom("notes_vec as v")
            .innerJoin("notes as n", "n.id", "v.id")
            .select(["n.id", distance.as("distance")])
            .where(match)
            .where("n.model", "=", model)
            .where("n.source", "=", source)
            .orderBy(distance)
            .orderBy("n.id")
            .limit(limit),
      }),
    }));
    return pending.then((result) => {
      console.info(
        JSON.stringify({
          search: "vector",
          corpus,
          latencyMs: performance.now() - started,
        }),
      );
      return result;
    });
  };
  return { add, text, nearest, search };
}

const populateText = (add: ReturnType<typeof searchFixture>["add"]) => {
  add("short", 1, "café blue fox");
  add("long", 2, "café blue fox " + "unrelated background words ".repeat(40));
  add("reverse", 3, "fox blue café");
  add("prefix", 4, "blue foxtrot");
  add("other", 5, "green turtle decoy 50xxoff and backslash");
  add("literal", 6, "literal 50%_off and back\\slash café2026 préfixe2026-étape2");
};

describe.skipIf(!connection)("PostgreSQL engine search conformance", () => {
  it("composes literal terms, phrases, final-lexeme prefixes and OR with bounded ranked snippets", async () => {
    await fixture(({ db }) => {
      const { add, text, search } = searchFixture(db);
      db.runTransaction(() => populateText(add));
      expect(
        text({ kind: "term", text: "cafe" })
          .map((row) => row.id)
          .toSorted(),
      ).toEqual(["long", "reverse", "short"]);
      expect(text({ kind: "term", text: "cafe2026" }).map((row) => row.id)).toEqual(["literal"]);
      expect(text({ kind: "term", text: "prefixe2026-etape2" }).map((row) => row.id)).toEqual([
        "literal",
      ]);
      expect(text({ kind: "phrase", text: "blue fox" }).map((row) => row.id)).toEqual([
        "short",
        "long",
      ]);
      expect(
        text({ kind: "phrase", text: "blue fox", prefix: true })
          .map((row) => row.id)
          .toSorted(),
      ).toEqual(["long", "prefix", "short"]);
      expect(
        text({
          kind: "any",
          clauses: [
            { kind: "term", text: "turtle" },
            { kind: "term", text: "foxtrot" },
          ],
        })
          .map((row) => row.id)
          .toSorted(),
      ).toEqual(["other", "prefix"]);
      expect(
        text({
          kind: "all",
          clauses: [
            { kind: "term", text: "cafe" },
            { kind: "term", text: "fox" },
          ],
        })
          .map((row) => row.id)
          .toSorted(),
      ).toEqual(["long", "reverse", "short"]);
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
    });
  });

  it("uses trigram contains literally, including wildcard and escape characters", async () => {
    await fixture(({ db }) => {
      const { add, text } = searchFixture(db);
      db.runTransaction(() => populateText(add));
      // Contains has no tsquery ranking: compose its filter with the caller's stable identity.
      const { fullText, text: indexes } = bindStoreSearch(db, schema.search!);
      const k = getNodeSqliteKysely<SearchDB>(db);
      for (const needle of ["50%_off", "back\\slash", "BLUE FOX"]) {
        const started = performance.now();
        const rows = executeSqliteQuerySync(
          db,
          k
            .selectFrom("notes")
            .select("id")
            .where(fullText!.match(indexes.notes!, { kind: "contains", text: needle }))
            .orderBy("id"),
        ).rows;
        console.info(
          JSON.stringify({
            search: "trigram",
            corpus: "six-notes",
            latencyMs: performance.now() - started,
          }),
        );
        expect(rows.map((row) => row.id)).toEqual(
          needle === "BLUE FOX" ? ["long", "prefix", "short"] : ["literal"],
        );
      }
      expect(text({ kind: "term", text: "missing" })).toEqual([]);
    });
  });

  it("computes exact float32 cosine after model/source eligibility and preserves binary64 source", async () => {
    await fixture(async ({ db }) => {
      const { add, nearest } = searchFixture(db, "eight-vector-notes");
      const precise = [0.12345678912345678, 0.9876543219876543, 0.3333333333333333];
      db.runTransaction(() => {
        add("wrong-model", 1, "excluded exact", [1, 0, 0], "model-b");
        add("wrong-source", 2, "excluded exact", [1, 0, 0], "model-a", "session");
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
      const bytes = db.prepare("SELECT embedding FROM notes WHERE id = 'precise'").get()!.embedding;
      expect(bytes).toEqual(new Uint8Array(embedding(precise)));
      expect(
        db.prepare("SELECT embedding FROM notes WHERE id = 'underflow'").get()!.embedding,
      ).toEqual(new Uint8Array(embedding([2 ** -150, 1, 0])));
      const result = await nearest([1, 0, 0], "model-a", "memory", 3);
      expect(result.fallbackScanRequired).toBe(false);
      expect(result.rows.map((row) => row.id)).toEqual(["eligible", "orthogonal", "opposite"]);
      expect(result.rows[0]!.distance).toBeCloseTo(1 - 1 / Math.sqrt(2), 6);
      expect(result.rows[1]!.distance).toBe(1);
      expect(result.rows[2]!.distance).toBe(2);
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
    });
  });

  it("synchronizes source writes and deletes transactionally and rebuilds only derived projections", async () => {
    await fixture(async ({ db }) => {
      const { add, text, nearest, search } = searchFixture(db, "one-note");
      db.runTransaction(() => add("kept", 1, "firstword", [1, 0, 0]));
      expect(text({ kind: "term", text: "firstword" }).map((row) => row.id)).toEqual(["kept"]);
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
      const before = db.prepare("SELECT embedding FROM notes WHERE id = 'kept'").get()!.embedding;
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
      expect(text({ kind: "term", text: "secondword" }).map((row) => row.id)).toEqual(["kept"]);
      expect(db.prepare("SELECT id FROM notes_vec ORDER BY id").all()).toEqual([{ id: "kept" }]);
      expect(text({ kind: "term", text: "keywordonly" }).map((row) => row.id)).toEqual([
        "text-only",
      ]);
      expect(
        db.prepare("SELECT embedding FROM notes WHERE id = 'kept'").get()!.embedding,
      ).not.toEqual(before);
      const updated = db.prepare("SELECT embedding FROM notes WHERE id = 'kept'").get()!.embedding;
      db.runTransaction(() => {
        db.exec("DELETE FROM notes_vec");
        search.rebuild!();
      });
      expect(db.prepare("SELECT embedding FROM notes WHERE id = 'kept'").get()!.embedding).toEqual(
        updated,
      );
      const result = await nearest([0, 1, 0]);
      expect(result.rows).toEqual([{ id: "kept", distance: 0 }]);
      withEngineStoreAdmission(() => {
        db.runTransaction(() => {
          db.prepare("UPDATE notes SET embedding = ? WHERE id = ?").run(embedding([]), "kept");
        });
        expect(db.prepare("SELECT id FROM notes_vec").all()).toEqual([]);
        expect(text({ kind: "term", text: "secondword" }).map((row) => row.id)).toEqual(["kept"]);
      });
    });
  });

  it.each([
    ["GIN index", "DROP INDEX notes_search_gin"],
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
