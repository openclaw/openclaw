import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { getEnvironmentData, threadId } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { PostgresSyncConnection } from "../postgres-sync/connection.js";
import { publishSqliteDatabaseSchemaChange } from "../sqlite-database-admission.js";
import { admitStoreSearch } from "./adapters.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import type { SearchSchema, StoreSchema } from "./contract.js";
import { openPostgresEngineTestStore } from "./engine-store.test-support.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterAll);
const tables = [
  "notes",
  "archive",
  "broken",
  "nested",
  "nested_archive",
  "drift",
  "keywords",
  "keywords_archive",
];
const schema: StoreSchema = {
  id: "search_extension",
  version: 1,
  sqlite: "",
  postgres: tables
    .map(
      (table) => `CREATE TABLE ${table} (
        id TEXT PRIMARY KEY, ordinal BIGINT NOT NULL UNIQUE,
        text TEXT NOT NULL, embedding BYTEA
      )`,
    )
    .join(";\n"),
};

function textSchema(table: string): SearchSchema {
  return {
    text: {
      body: { table, fields: ["text"], postgres: { identity: "ordinal" } },
    },
  };
}

function searchSchema(table: string, dimensions = 3): SearchSchema {
  return {
    ...textSchema(table),
    vector: {
      chunks: {
        table: `${table}_vec`,
        alias: "v",
        rowShape: { id: "string", distance: "finite-number" },
        postgres: { source: table, key: "id", embedding: "embedding", dimensions },
      },
    },
  };
}

function embedding(values: readonly number[]) {
  const bytes = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => bytes.writeDoubleLE(value, index * 8));
  return bytes;
}

describe.skipIf(!connection)("PostgreSQL search extension admission", () => {
  let anchor: ReturnType<typeof openNodeSqliteDatabase>;
  let db: PostgresSyncConnection;
  const connections: PostgresSyncConnection[] = [];
  const row = (sql: string, ...values: string[]) => db.prepare(sql).get(...values);
  const expectDefinitions = (...names: string[]) => {
    const definitions = row(
      "SELECT search_extensions::text AS definitions FROM openclaw_schema_meta",
    )?.definitions;
    for (const name of names) {
      expect(definitions).toEqual(expect.stringContaining(name));
    }
  };
  const matchText = (
    table: "notes" | "keywords" | "nested",
    search: ReturnType<typeof admitStoreSearch>,
    text: string,
  ) =>
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<{
        notes: { id: string };
        keywords: { id: string };
        nested: { id: string };
      }>(db)
        .selectFrom(table)
        .select("id")
        .where(search.fullText!.match(search.text.body!, { kind: "term", text })),
    ).rows;
  const open = () => {
    const opened = openPostgresEngineTestStore({
      anchor,
      schema,
      input: { connection: connection!, schemaPrefix: "search_extension_test" },
    });
    if (!(opened instanceof PostgresSyncConnection)) {
      throw new Error("Expected PostgreSQL");
    }
    connections.push(opened);
    return opened;
  };

  beforeAll(() => {
    expect(threadId, "The fixture retains the in-process admission descriptor").toBe(0);
    anchor = openNodeSqliteDatabase(path.join(dirs.make("pg-search-extension-"), "anchor.sqlite"));
    db = withEngineStoreAdmission(open);
  });
  afterAll(() => {
    withEngineStoreAdmission(() => {
      try {
        db?.exec(`DROP SCHEMA "${db.schema}" CASCADE`);
      } finally {
        connections.forEach((opened) => opened.close());
        anchor?.close();
      }
    });
  });

  it("installs keyword-only extensions and reopens without scratch DDL", () => {
    withEngineStoreAdmission(() => {
      const selected = { ...textSchema("keywords"), mode: "keyword-only" as const };
      const first = admitStoreSearch(db, selected, { extension: "keywords-search" });
      admitStoreSearch(db, textSchema("keywords_archive"), {
        extension: "keywords-archive-search",
      });
      db.runTransaction(() => {
        db.prepare("INSERT INTO keywords(id, ordinal, text) VALUES (?, ?, ?)").run(
          "one",
          1,
          "café memory",
        );
      });
      expect(first.vector).toBeNull();
      expect(matchText("keywords", first, "cafe")).toEqual([{ id: "one" }]);
      const statements: string[] = [];
      const observe = (value: unknown) => {
        if (
          value &&
          typeof value === "object" &&
          "engine" in value &&
          value.engine === "postgres" &&
          "sql" in value &&
          typeof value.sql === "string"
        ) {
          statements.push(value.sql);
        }
      };
      const events = channel("openclaw.database.statement");
      events.subscribe(observe);
      try {
        const previous = db;
        publishSqliteDatabaseSchemaChange(anchor);
        db = open();
        previous.close();
        admitStoreSearch(db, selected, { extension: "keywords-search" });
        admitStoreSearch(db, textSchema("keywords_archive"), {
          extension: "keywords-archive-search",
        });
      } finally {
        events.unsubscribe(observe);
      }
      expect(statements.length).toBeGreaterThan(0);
      expect(
        statements.filter((statement) =>
          /\bCREATE\s+(?:SCHEMA|TABLE|INDEX|FUNCTION|TEXT\s+SEARCH)\b/i.test(statement),
        ),
      ).toEqual([]);
      expect(
        db
          .prepare(
            "SELECT id FROM keywords WHERE openclaw_search @@ plainto_tsquery('openclaw_simple_unaccent', 'cafe')",
          )
          .all(),
      ).toEqual([{ id: "one" }]);
      expectDefinitions("keywords-search", "keywords-archive-search");
    });
  });

  it("installs independent vector extensions and refuses changed dimensions without changing source bytes", async () => {
    const precise = embedding([0.12345678912345678, 0.9876543219876543, 0.3333333333333333]);
    const selected = searchSchema("notes");
    const { pending } = withEngineStoreAdmission(() => {
      db.prepare("INSERT INTO notes VALUES (?, ?, ?, ?)").run("one", 1, "café memory", precise);
      const first = admitStoreSearch(db, selected, { extension: "notes-search" });
      const second = admitStoreSearch(db, searchSchema("archive", 2), {
        extension: "archive-search",
      });
      db.runTransaction(() => {
        db.prepare("INSERT INTO archive(id, ordinal, text, embedding) VALUES (?, ?, ?, ?)").run(
          "archive-one",
          1,
          "archived memory",
          embedding([1, 0]),
        );
      });
      expect(second.vector!.prepareExists(second.vectors.chunks!)("archive-one")).toBe(true);
      const k = getNodeSqliteKysely<{ notes: { id: string } }>(db);
      expect(matchText("notes", first, "cafe")).toEqual([{ id: "one" }]);
      return {
        pending: first.vector!.nearest({
          index: first.vectors.chunks!,
          vector: [1, 0, 0],
          limit: 1,
          isRow: (value): value is { id: string; distance: number } =>
            typeof value === "object" &&
            value !== null &&
            "id" in value &&
            typeof value.id === "string" &&
            "distance" in value &&
            typeof value.distance === "number",
          scopeCount: k.selectFrom("notes").select(k.fn.countAll<number>().as("count")),
          query: ({ match, distance }) =>
            getNodeSqliteKysely<{ notes_vec: { id: string } }>(db)
              .selectFrom("notes_vec as v")
              .select(["v.id", distance.as("distance")])
              .where(match)
              .orderBy(distance)
              .limit(1),
        }),
      };
    });
    const result = await pending;
    expect(result.rows.map((resultRow) => resultRow.id)).toEqual(["one"]);
    expect(result.rows[0]!.distance).toBeCloseTo(
      1 -
        Math.fround(precise.readDoubleLE(0)) /
          Math.hypot(...[0, 8, 16].map((i) => Math.fround(precise.readDoubleLE(i)))),
      6,
    );
    withEngineStoreAdmission(() => {
      const previous = db;
      publishSqliteDatabaseSchemaChange(anchor);
      db = open();
      previous.close();
      expect(row("SELECT embedding FROM notes WHERE id = 'one'")?.embedding).toEqual(
        new Uint8Array(precise),
      );
      expectDefinitions("notes-search", "archive-search");
      expect(() =>
        admitStoreSearch(db, searchSchema("notes", 4), { extension: "notes-search" }),
      ).toThrow(
        expect.objectContaining({
          name: "SearchExtensionDefinitionChangedError",
          message: expect.stringMatching(/rebuild.*canonical/i),
        }),
      );
      expect(row("SELECT embedding FROM notes WHERE id = 'one'")?.embedding).toEqual(
        new Uint8Array(precise),
      );
      const readmitted = admitStoreSearch(db, selected, { extension: "notes-search" });
      expect(readmitted.vector!.prepareExists(readmitted.vectors.chunks!)("one")).toBe(true);
    });
  });

  it("rolls back a failed installation before publishing definitions or derived objects", () => {
    withEngineStoreAdmission(() => {
      const broken: SearchSchema = {
        text: {
          ...textSchema("broken").text,
          missing: { table: "missing_source", fields: ["text"], postgres: { identity: "ordinal" } },
        },
      };
      expect(() => admitStoreSearch(db, broken, { extension: "broken-search" })).toThrow(
        /missing_source/,
      );
      expect(
        row(
          "SELECT 1 AS present FROM information_schema.columns WHERE table_schema = ? AND table_name = 'broken' AND column_name = 'openclaw_search'",
          db.schema,
        ),
      ).toBeUndefined();
      expect(
        row(
          "SELECT 1 AS present FROM pg_indexes WHERE schemaname = ? AND indexname = 'broken_search_gin'",
          db.schema,
        ),
      ).toBeUndefined();
      expect(
        row(
          "SELECT to_jsonb(meta)->>'search_extensions' AS definitions FROM openclaw_schema_meta AS meta",
        )?.definitions,
      ).not.toEqual(expect.stringContaining("broken-search"));
      const recovered = admitStoreSearch(db, textSchema("broken"), { extension: "broken-search" });
      expect(recovered.fullText).not.toBeNull();
      expectDefinitions("broken-search");
    });
  });

  it("rolls back extension admission with its outer owner transaction", () => {
    withEngineStoreAdmission(() => {
      db.prepare("INSERT INTO nested(id, ordinal, text) VALUES (?, ?, ?)").run(
        "kept",
        1,
        "nested memory",
      );
      const selected = textSchema("nested");
      expect(() =>
        db.runTransaction(() => {
          const admitted = admitStoreSearch(db, selected, { extension: "nested-search" });
          admitStoreSearch(db, textSchema("nested_archive"), {
            extension: "nested-archive-search",
          });
          expect(matchText("nested", admitted, "memory")).toEqual([{ id: "kept" }]);
          throw new Error("outer owner rollback");
        }),
      ).toThrow("outer owner rollback");
      expect(
        row(
          "SELECT 1 AS present FROM information_schema.columns WHERE table_schema = ? AND table_name = 'nested' AND column_name = 'openclaw_search'",
          db.schema,
        ),
      ).toBeUndefined();
      expect(
        row(
          "SELECT to_jsonb(meta)->>'search_extensions' AS definitions FROM openclaw_schema_meta AS meta",
        )?.definitions,
      ).not.toEqual(expect.stringContaining("nested-search"));
      const readmitted = db.runTransaction(() => {
        const search = admitStoreSearch(db, selected, { extension: "nested-search" });
        admitStoreSearch(db, textSchema("nested_archive"), {
          extension: "nested-archive-search",
        });
        return search;
      });
      expect(matchText("nested", readmitted, "memory")).toEqual([{ id: "kept" }]);
      expectDefinitions("nested-search", "nested-archive-search");
    });
  });

  it("rejects derived-index tampering on readmission", () => {
    withEngineStoreAdmission(() => {
      admitStoreSearch(db, textSchema("drift"), { extension: "drift-search" });
      db.exec("DROP INDEX drift_search_gin");
      publishSqliteDatabaseSchemaChange(anchor);
      expect(open).toThrow(/schema drift/i);
    });
  });
});
