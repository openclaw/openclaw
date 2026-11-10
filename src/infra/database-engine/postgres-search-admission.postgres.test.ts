import { randomUUID } from "node:crypto";
import { getEnvironmentData, threadId } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { PostgresSqlConnection } from "../sql-connection.js";
import { admitStoreSearch } from "./adapters.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { DatabaseSearchCapabilityUnavailableError } from "./capability-unavailable.js";
import { createNotesSearch, createPostgresEngineTestFixture } from "./engine-store.test-support.js";
import {
  admitPostgresSearch,
  assertPostgresSearchAdmitted,
  pgSearchName,
} from "./postgres-search-schema.js";
import type { SearchSchema } from "./search.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const search: SearchSchema = createNotesSearch();
function fixture(
  dsn: string,
  selected: SearchSchema | undefined,
  run: (db: PostgresSqlConnection) => void,
) {
  expect(threadId, "The fixture host must retain the native admission descriptor").toBe(0);
  withEngineStoreAdmission(() => {
    using store = createPostgresEngineTestFixture({
      directory: dirs.make("pg-search-admission-"),
      connection: dsn,
      schemaPrefix: "r6",
      schema: {
        id: "search",
        version: 1,
        sqlite: "",
        postgres: "CREATE TABLE notes(id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding BYTEA)",
        search: selected,
      },
    });
    run(store.open());
  });
}

describe.skipIf(!connection)("PostgreSQL search admission failures", () => {
  it.each(["0.6.2", "0.7.0", "0.8.7"])(
    "gates binary search on pgvector %s once at admission while historical search remains exact",
    (version) => {
      fixture(connection!, undefined, (db) => {
        const selected: SearchSchema = { vector: search.vector };
        const namespace = String(db.prepare("SELECT current_schema() AS name").get()?.name);
        const prepare = db.prepare.bind(db);
        const statements = vi.spyOn(db, "prepare").mockImplementation((sql) => {
          const statement = prepare(sql);
          if (sql.includes("pg_catalog.pg_available_extensions")) {
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
        const count = statements.mock.calls.length;
        expect(admitPostgresSearch(db, selected, namespace, 2)).toBeUndefined();
        assertPostgresSearchAdmitted(db, selected);
        expect(statements.mock.calls).toHaveLength(count);
      });
    },
  );

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
        let admissionError: unknown;
        try {
          fixture(url.href, search, () => {});
        } catch (error) {
          admissionError = error;
        }
        expect(admissionError).toBeInstanceOf(DatabaseSearchCapabilityUnavailableError);
        expect(admissionError).toMatchObject({
          name: "DatabaseSearchCapabilityUnavailableError",
          code: "DATABASE_SEARCH_CAPABILITY_UNAVAILABLE",
          capability: missing === "vector" ? "vector" : "fullText",
        });
        expect(admissionError).toMatchObject({
          message: expect.stringMatching(
            new RegExp(`PostgreSQL ${missing} capability unavailable.*CREATE EXTENSION`),
          ),
        });
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
      const database = String(admin.prepare("SELECT current_database() AS name").get()?.name);
      admin.exec(`CREATE ROLE ${pgSearchName(role)} LOGIN PASSWORD 'synthetic-search-privilege'`);
      admin.exec(`GRANT CONNECT ON DATABASE ${pgSearchName(database)} TO ${pgSearchName(role)}`);
      try {
        const url = new URL(connection!);
        url.username = role;
        url.password = "synthetic-search-privilege";
        expect(() => fixture(url.href, search, () => {})).toThrow("insufficient CREATE privilege");
      } finally {
        admin.exec(
          `REVOKE CONNECT ON DATABASE ${pgSearchName(database)} FROM ${pgSearchName(role)}`,
        );
        admin.exec(`DROP ROLE ${pgSearchName(role)}`);
      }
    });
  });
});
