import { randomUUID } from "node:crypto";
import path from "node:path";
import { getEnvironmentData, threadId } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { isPostgresSqlConnection, type PostgresSqlConnection } from "../sql-connection.js";
import { admitSqliteSchema } from "../sqlite-schema-facts.js";
import { admitStoreSearch } from "./adapters.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import type { StoreSchema } from "./contract.js";
import { openEngineStore, readEngineAnchor } from "./open.js";
import { pgSearchName } from "./postgres-search-schema.js";
import type { SearchSchema } from "./search.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);
const search: SearchSchema = {
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
function fixture(
  dsn: string,
  selected: SearchSchema | undefined,
  run: (db: PostgresSqlConnection) => void,
) {
  expect(threadId, "The fixture host must retain the native admission descriptor").toBe(0);
  withEngineStoreAdmission(() => {
    const anchor = openNodeSqliteDatabase(
      path.join(dirs.make("pg-search-admission-"), "anchor.sqlite"),
    );
    const schema: StoreSchema = {
      id: "search",
      version: 1,
      sqlite: "",
      postgres: "CREATE TABLE notes(id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding BYTEA)",
      search: selected,
    };
    let db: PostgresSqlConnection | undefined;
    try {
      const opened = openEngineStore({
        anchor,
        schema,
        input: { connection: dsn, schemaPrefix: "r6" },
        openSqlite: () => {
          throw new Error("Unexpected SQLite bootstrap");
        },
        prepareAnchor: () => {},
        inspectSqlite: () => {
          admitSqliteSchema(anchor);
          return { hasExistingData: false, hasEngineAnchor: Boolean(readEngineAnchor(anchor)) };
        },
      });
      if (!isPostgresSqlConnection(opened)) {
        throw new Error("Expected PostgreSQL");
      }
      db = opened;
      run(db);
    } finally {
      if (db) {
        const namespace = readEngineAnchor(anchor)?.[0]?.schema;
        db.exec(`DROP SCHEMA ${pgSearchName(String(namespace))} CASCADE`);
        db.close();
      }
      anchor.close();
    }
  });
}

describe.skipIf(!connection)("PostgreSQL search admission failures", () => {
  it.each(["unaccent", "pg_trgm", "vector"])("names missing %s with operator SQL", (missing) => {
    fixture(connection!, undefined, (admin) => {
      const name = `r6_${randomUUID().replaceAll("-", "")}`;
      const url = new URL(connection!);
      url.pathname = `/${name}`;
      admin.exec(`CREATE DATABASE ${pgSearchName(name)}`);
      try {
        fixture(url.href, undefined, (setup) => {
          for (const extension of ["unaccent", "pg_trgm", "vector"]) {
            if (extension !== missing) {
              setup.exec(`CREATE EXTENSION ${pgSearchName(extension)} WITH SCHEMA public`);
            }
          }
        });
        expect(() => fixture(url.href, search, () => {})).toThrow(
          new RegExp(`PostgreSQL ${missing} capability unavailable.*CREATE EXTENSION`),
        );
        if (missing === "vector") {
          fixture(url.href, { ...search, mode: "keyword-only" }, (db) => {
            const admitted = admitStoreSearch(db, { ...search, mode: "keyword-only" });
            expect(admitted.fullText).not.toBeNull();
            expect(admitted.vector).toBeNull();
            db.exec("INSERT INTO notes VALUES ('one', 'keyword available', NULL)");
            expect(
              db
                .prepare(
                  "SELECT id FROM notes WHERE openclaw_search @@ plainto_tsquery('openclaw_simple_unaccent', 'keyword')",
                )
                .get()?.id,
            ).toBe("one");
          });
        }
      } finally {
        admin.exec(`DROP DATABASE ${pgSearchName(name)}`);
      }
    });
  });

  it("refuses unsupported exact dimensions before installing search DDL", () => {
    const selected: SearchSchema = {
      vector: {
        notes: {
          ...search.vector!.notes!,
          postgres: { ...search.vector!.notes!.postgres!, dimensions: 16_001 },
        },
      },
    };
    expect(() => fixture(connection!, selected, () => {})).toThrow("dimensions must be 1–16000");
  });

  it("names insufficient schema creation privilege", () => {
    fixture(connection!, undefined, (admin) => {
      const role = `r6_${randomUUID().replaceAll("-", "")}`;
      admin.exec(`CREATE ROLE ${pgSearchName(role)} LOGIN`);
      try {
        const url = new URL(connection!);
        url.username = role;
        url.password = "";
        expect(() => fixture(url.href, search, () => {})).toThrow("insufficient CREATE privilege");
      } finally {
        admin.exec(`DROP ROLE ${pgSearchName(role)}`);
      }
    });
  });
});
