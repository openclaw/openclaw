import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { PostgresSyncConnection } from "../postgres-sync/connection.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import type { StoreSchema } from "./contract.js";
import {
  createPostgresEngineTestFixture,
  openPostgresEngineTestStore,
} from "./engine-store.test-support.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);
const schema: StoreSchema = {
  id: "readonly_fixture",
  version: 1,
  sqlite: "",
  postgres: "CREATE TABLE items (id BIGINT PRIMARY KEY, value TEXT NOT NULL)",
};

describe.skipIf(!connection)("read-only PostgreSQL admission", () => {
  it("rejects a missing anchor and never creates it", () => {
    withEngineStoreAdmission(() => {
      const anchor = openNodeSqliteDatabase(
        path.join(dirs.make("pg-readonly-missing-"), "anchor.sqlite"),
      );
      try {
        expect(() =>
          openPostgresEngineTestStore({
            anchor,
            schema,
            input: { connection: connection!, schemaPrefix: "readonly", readOnly: true },
          }),
        ).toThrow(/Missing PostgreSQL anchor/);
        expect(
          anchor
            .prepare("SELECT name FROM sqlite_schema WHERE name = 'openclaw_engine_anchor'")
            .all(),
        ).toEqual([]);
      } finally {
        anchor.close();
      }
    });
  });

  it("refuses an unsealed source without silently repairing it", () => {
    withEngineStoreAdmission(() => {
      using fixture = createPostgresEngineTestFixture({
        directory: dirs.make("pg-readonly-unsealed-"),
        connection: connection!,
        schemaPrefix: "readonly",
        schema,
      });
      const writer = fixture.open();
      writer.exec("UPDATE openclaw_schema_meta SET fingerprint = NULL, ddl_hash = NULL");
      const before = writer.prepare("SELECT * FROM openclaw_schema_meta").all();
      expect(() =>
        openPostgresEngineTestStore({
          anchor: writer.anchor,
          schema,
          input: { connection: connection!, schemaPrefix: "readonly", readOnly: true },
        }),
      ).toThrow(/seal/i);
      expect(writer.prepare("SELECT * FROM openclaw_schema_meta").all()).toEqual(before);
    });
  });
  it("reads a sealed store without admitting mutations or changing its writer", () => {
    withEngineStoreAdmission(() => {
      using fixture = createPostgresEngineTestFixture({
        directory: dirs.make("pg-readonly-"),
        connection: connection!,
        schemaPrefix: "readonly",
        schema,
      });
      const writer = fixture.open();
      writer.exec("INSERT INTO items VALUES (1, 'before')");
      const metadata = writer.prepare("SELECT * FROM openclaw_schema_meta").all();
      const reader = openPostgresEngineTestStore({
        anchor: writer.anchor,
        schema,
        input: { connection: connection!, schemaPrefix: "readonly", readOnly: true },
      });
      try {
        if (!(reader instanceof PostgresSyncConnection)) {
          throw new Error("Expected PostgreSQL reader");
        }
        expect(reader.prepare("SELECT * FROM items").all()).toEqual([{ id: 1, value: "before" }]);
        expect(() => reader.exec("INSERT INTO items VALUES (2, 'denied')")).toThrow(/read.only/i);
        expect(() =>
          reader.runTransaction(() => reader.exec("UPDATE items SET value = 'denied'")),
        ).toThrow(/read.only/i);
        expect(() => reader.exec("ALTER TABLE items ADD COLUMN forbidden TEXT")).toThrow(
          /read.only/i,
        );
        reader.runTransaction(() => {
          expect(() => reader.exec("SET TRANSACTION READ WRITE")).toThrow(/transaction/i);
        });
        reader.exec("SET default_transaction_read_only = off");
        expect(() => reader.exec("INSERT INTO items VALUES (3, 'override-denied')")).toThrow(
          /read.only/i,
        );
        expect(() =>
          reader.exec("BEGIN READ WRITE; UPDATE items SET value = 'batch-denied'; COMMIT"),
        ).toThrow();
        expect(writer.prepare("SELECT * FROM items").all()).toEqual([{ id: 1, value: "before" }]);
        writer.exec("UPDATE items SET value = 'after' WHERE id = 1");
        expect(reader.prepare("SELECT * FROM items").all()).toEqual([{ id: 1, value: "after" }]);
        expect(writer.prepare("SELECT * FROM openclaw_schema_meta").all()).toEqual(metadata);
      } finally {
        reader.close();
      }
    });
  });

  it("refuses a version change without migrating or resealing the source", () => {
    withEngineStoreAdmission(() => {
      using fixture = createPostgresEngineTestFixture({
        directory: dirs.make("pg-readonly-version-"),
        connection: connection!,
        schemaPrefix: "readonly",
        schema,
      });
      const writer = fixture.open();
      const metadata = writer.prepare("SELECT * FROM openclaw_schema_meta").all();
      const nextDdl = `${schema.postgres}; ALTER TABLE items ADD COLUMN next TEXT`;
      const upgraded: StoreSchema = {
        ...schema,
        version: 2,
        postgres: nextDdl,
        postgresMigrations: [
          {
            version: 2,
            fromSchema: { postgres: schema.postgres! },
            schema: { postgres: nextDdl },
            sql: "ALTER TABLE items ADD COLUMN next TEXT",
          },
        ],
      };
      expect(() =>
        openPostgresEngineTestStore({
          anchor: writer.anchor,
          schema: upgraded,
          input: { connection: connection!, schemaPrefix: "readonly", readOnly: true },
        }),
      ).toThrow(/version mismatch/i);
      expect(writer.prepare("SELECT * FROM openclaw_schema_meta").all()).toEqual(metadata);
      expect(
        writer
          .prepare(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = 'items' ORDER BY column_name",
          )
          .all(writer.schema),
      ).toEqual([{ column_name: "id" }, { column_name: "value" }]);
    });
  });
});
