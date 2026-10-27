import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { PostgresSyncConnection } from "../postgres-sync/connection.js";
import {
  captureSqliteDatabaseAdmissions,
  publishSqliteDatabaseSchemaChange,
  revokeSqliteDatabaseAdmissions,
} from "../sqlite-database-admission.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import type { StoreSchema } from "./contract.js";
import { openPostgresEngineTestStore } from "./engine-store.test-support.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const ddl = `CREATE TABLE items (id BIGINT PRIMARY KEY, value BIGINT NOT NULL DEFAULT 0 CHECK (value >= 0));
CREATE INDEX active_items ON items(value) WHERE value > 0;
CREATE FUNCTION bump() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.value := NEW.value + 1; RETURN NEW; END$$;
CREATE TRIGGER bump BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION bump();`;
const schema: StoreSchema = { id: "fixture", version: 1, sqlite: "", postgres: ddl };

function fixture(
  test: (input: {
    open: (schema?: StoreSchema, existingVersion?: boolean) => PostgresSyncConnection;
    db: PostgresSyncConnection;
    invalidate: () => void;
  }) => void,
) {
  withEngineStoreAdmission(() => {
    const anchor = openNodeSqliteDatabase(path.join(dirs.make("pg-schema-"), "anchor.sqlite"));
    const connections: PostgresSyncConnection[] = [];
    const open = (selected = schema, existingVersion = false) => {
      const db = openPostgresEngineTestStore({
        anchor,
        schema: selected,
        existingVersion,
        input: { connection: connection!, schemaPrefix: "r2" },
      });
      if (!(db instanceof PostgresSyncConnection)) {
        throw new Error("Expected PostgreSQL connection");
      }
      connections.push(db);
      return db;
    };
    try {
      const db = open();
      test({ open, db, invalidate: () => publishSqliteDatabaseSchemaChange(anchor) });
    } finally {
      try {
        const db = connections[0];
        if (db) {
          db.exec(`DROP SCHEMA "${db.schema}" CASCADE`);
        }
      } finally {
        connections.forEach((item) => item.close());
        anchor.close();
      }
    }
  });
}

describe.skipIf(!connection)("PostgreSQL schema admission", () => {
  it("keeps migration callbacks out of worker admission snapshots", () => {
    fixture(({ open, invalidate }) => {
      invalidate();
      open({
        ...schema,
        postgresMigrations: [
          {
            version: 2,
            fromSchema: { postgres: ddl },
            schema: { postgres: ddl },
            sql: "",
            backup: {
              id: "fixture",
              version: 1,
              minimumPostgresVersion: 16,
              tables: [],
              sqlite: "",
              preData: "",
              postData: "",
              expectedCatalog: [],
              postgresPostData: () => "",
            },
          },
        ],
      });
      expect(() => structuredClone(captureSqliteDatabaseAdmissions())).not.toThrow();
    });
  });

  it("reads an existing anchor while another handle holds write admission", () => {
    fixture(({ db }) => {
      db.exec("INSERT INTO items (id) VALUES (1)");
      const location = db.anchor.location();
      if (!location) {
        throw new Error("Expected a file-backed PostgreSQL anchor");
      }
      using reader = openNodeSqliteDatabase(location);
      revokeSqliteDatabaseAdmissions(db.anchor);
      db.anchor.exec("BEGIN IMMEDIATE");
      try {
        const opened = openPostgresEngineTestStore({
          anchor: reader,
          schema,
          input: { connection: connection!, schemaPrefix: "r2" },
          existingOnly: true,
        });
        try {
          expect(opened.prepare("SELECT value FROM items").all()).toEqual([{ value: 1 }]);
        } finally {
          opened.close();
        }
      } finally {
        db.anchor.exec("ROLLBACK");
      }
    });
  });

  it.each([
    ["default value", "ALTER TABLE items ALTER COLUMN value SET DEFAULT 2"],
    [
      "CHECK expression",
      "ALTER TABLE items DROP CONSTRAINT items_value_check; ALTER TABLE items ADD CONSTRAINT items_value_check CHECK (value >= 1)",
    ],
    [
      "partial-index predicate",
      "DROP INDEX active_items; CREATE INDEX active_items ON items(value) WHERE value > 1",
    ],
    [
      "trigger body",
      "CREATE OR REPLACE FUNCTION bump() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.value := NEW.value + 2; RETURN NEW; END$$",
    ],
  ])("refuses changed %s", (_name, sql) => {
    fixture(({ db, open, invalidate }) => {
      db.exec(sql);
      invalidate();
      expect(() => open()).toThrow("schema drift");
    });
  });

  it("admits unchanged stores with one catalog read and rechecks a changed server major", () => {
    fixture(({ db, open, invalidate }) => {
      invalidate();
      const queries: { sql: string; durationMs: number }[] = [];
      const listener = (message: unknown) => {
        const event = message as { engine: string; sql: string; durationMs: number };
        if (event.engine === "postgres") {
          queries.push(event);
        }
      };
      const observations = channel("openclaw.database.statement");
      observations.subscribe(listener);
      try {
        open();
        const catalog = queries.filter((event) => event.sql.startsWith("WITH captured"));
        expect(catalog).toHaveLength(1);
        expect(queries.some((event) => event.sql.startsWith("CREATE SCHEMA"))).toBe(false);
        const catalogMs = catalog[0]!.durationMs;
        db.exec("UPDATE openclaw_schema_meta SET server_major = 0");
        invalidate();
        queries.length = 0;
        const started = performance.now();
        open();
        const scratchMs = performance.now() - started;
        expect(queries.filter((event) => event.sql.startsWith("CREATE SCHEMA"))).toHaveLength(1);
        expect(
          db.prepare("SELECT server_major FROM openclaw_schema_meta").get()?.server_major,
        ).toBe(getPostgresPhysicalFacts(db)?.capabilities.serverMajor);
        expect(queries.filter((event) => event.sql.startsWith("DROP SCHEMA"))).toHaveLength(1);
        console.info(JSON.stringify({ catalogMs, scratchMs }));
      } finally {
        observations.unsubscribe(listener);
      }
    });
  });

  it("verifies unsealed port metadata and drops scratch on refusal", () => {
    fixture(({ db, open, invalidate }) => {
      db.exec(
        "ALTER TABLE openclaw_schema_meta DROP COLUMN fingerprint, DROP COLUMN ddl_hash, DROP COLUMN server_major",
      );
      invalidate();
      open();
      expect(db.prepare("SELECT length(fingerprint) AS n FROM openclaw_schema_meta").get()?.n).toBe(
        64,
      );
      db.exec(
        "ALTER TABLE items ALTER COLUMN value SET DEFAULT 2; UPDATE openclaw_schema_meta SET server_major = 0",
      );
      invalidate();
      const exec = Reflect.get(
        PostgresSyncConnection.prototype,
        "exec",
      ) as PostgresSyncConnection["exec"];
      const scratches: string[] = [];
      vi.spyOn(PostgresSyncConnection.prototype, "exec").mockImplementation(function (
        this: PostgresSyncConnection,
        sql,
      ) {
        const match = /^CREATE SCHEMA "(openclaw_check_[^"]+)"$/.exec(sql);
        if (match) {
          scratches.push(match[1]!);
        }
        exec.call(this, sql);
      });
      expect(() => open()).toThrow("schema drift detected against generated DDL");
      expect(scratches).toHaveLength(1);
      for (const namespace of scratches) {
        expect(
          db.prepare("SELECT nspname FROM pg_namespace WHERE nspname = ?").get(namespace),
        ).toBeUndefined();
      }
    });
  });

  it("re-admits equivalent DDL text after exact catalog comparison", () => {
    fixture(({ db, open, invalidate }) => {
      db.runTransaction(() => db.exec("INSERT INTO items VALUES (1, 5)"));
      const previous = db.prepare("SELECT ddl_hash FROM openclaw_schema_meta").get()?.ddl_hash;
      invalidate();
      const reopened = open({ ...schema, postgres: `-- Equivalent fragment grouping\n${ddl}` });
      expect(reopened.prepare("SELECT value FROM items WHERE id = 1").get()?.value).toBe(6);
      expect(
        reopened.prepare("SELECT ddl_hash FROM openclaw_schema_meta").get()?.ddl_hash,
      ).not.toBe(previous);
    });
  });

  it("inspects reconstructed predecessor DDL without changing its seal before migration", () => {
    fixture(({ db, open, invalidate }) => {
      db.runTransaction(() => db.exec("INSERT INTO items VALUES (1, 5)"));
      const original = db.prepare("SELECT * FROM openclaw_schema_meta").get();
      const nextDdl = `${ddl}\nALTER TABLE items ADD COLUMN label TEXT;`;
      const target: StoreSchema = {
        ...schema,
        version: 2,
        postgres: nextDdl,
        postgresMigrations: [
          {
            version: 2,
            fromSchema: { postgres: `-- Reconstructed predecessor\n${ddl}` },
            schema: { postgres: nextDdl },
            sql: "ALTER TABLE items ADD COLUMN label TEXT; UPDATE items SET label = 'migrated'",
          },
        ],
      };
      invalidate();
      expect(() =>
        open(
          {
            ...target,
            postgresMigrations: [
              {
                ...target.postgresMigrations![0]!,
                fromSchema: { postgres: ddl.replace("DEFAULT 0", "DEFAULT 9") },
              },
            ],
          },
          true,
        ),
      ).toThrow("schema drift detected against generated DDL");
      const inspected = open(target, true);
      expect(inspected.prepare("SELECT * FROM openclaw_schema_meta").get()).toEqual(original);
      expect(getPostgresPhysicalFacts(inspected)?.version).toBe(1);
      invalidate();
      const migrated = open(target);
      expect(migrated.prepare("SELECT * FROM items").all()).toEqual([
        { id: 1, value: 6, label: "migrated" },
      ]);
      expect(getPostgresPhysicalFacts(migrated)?.version).toBe(2);
      expect(
        migrated.prepare("SELECT ddl_hash FROM openclaw_schema_meta").get()?.ddl_hash,
      ).not.toBe(original?.ddl_hash);
    });
  });

  it("rejects a generated DDL change at the same version", () => {
    fixture(({ open, invalidate }) => {
      invalidate();
      expect(() => open({ ...schema, postgres: ddl.replace("DEFAULT 0", "DEFAULT 9") })).toThrow(
        "schema drift detected against generated DDL",
      );
    });
  });

  it("migrates two versions atomically and rolls back both steps on failure", () => {
    fixture(({ db, open }) => {
      db.runTransaction(() => db.exec("INSERT INTO items VALUES (1, 5)"));
      const v2 = `${ddl}\nALTER TABLE items ADD COLUMN label TEXT;`;
      const v3 = `${v2}\nALTER TABLE items ADD COLUMN revision BIGINT NOT NULL DEFAULT 1;`;
      const target: StoreSchema = {
        ...schema,
        version: 3,
        postgres: v3,
        postgresMigrations: [
          {
            version: 2,
            fromSchema: { postgres: ddl },
            sql: "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory') THEN RAISE EXCEPTION 'no writer lock'; END IF; END $$; ALTER TABLE items ADD COLUMN label TEXT; UPDATE items SET label = 'migrated'",
            schema: { postgres: v2 },
          },
          {
            version: 3,
            fromSchema: { postgres: v2 },
            sql: "ALTER TABLE items ADD COLUMN revision BIGINT NOT NULL DEFAULT 1; SELECT missing_column FROM items",
            schema: { postgres: v3 },
          },
        ],
      };
      const before = db.prepare("SELECT * FROM openclaw_schema_meta").get();
      expect(() => open(target)).toThrow("missing_column");
      expect(db.prepare("SELECT * FROM openclaw_schema_meta").get()).toEqual(before);
      expect(db.prepare("SELECT * FROM items").all()).toEqual([{ id: 1, value: 6 }]);
      expect(getPostgresPhysicalFacts(db)?.version).toBe(1);
      target.postgresMigrations = target.postgresMigrations!.map((step) => ({
        version: step.version,
        fromSchema: step.fromSchema,
        schema: step.schema,
        sql: step.sql.split("; SELECT")[0]!,
      }));
      const secondStep = target.postgresMigrations![1]!;
      secondStep.sql = secondStep.sql.replace("DEFAULT 1", "DEFAULT 2");
      expect(() => open(target)).toThrow("generated DDL");
      expect(db.prepare("SELECT * FROM openclaw_schema_meta").get()).toEqual(before);
      expect(db.prepare("SELECT * FROM items").all()).toEqual([{ id: 1, value: 6 }]);
      secondStep.sql = secondStep.sql.replace("DEFAULT 2", "DEFAULT 1");
      db.exec("UPDATE openclaw_schema_meta SET server_major = 0");
      const storeId = getPostgresPhysicalFacts(db)?.storeId;
      const exec = Reflect.get(
        PostgresSyncConnection.prototype,
        "exec",
      ) as PostgresSyncConnection["exec"];
      let commitObserved = false;
      vi.spyOn(PostgresSyncConnection.prototype, "exec").mockImplementation(function (
        this: PostgresSyncConnection,
        sql,
      ) {
        if (sql === "COMMIT") {
          commitObserved = true;
          const published = captureSqliteDatabaseAdmissions().flatMap((record) => [
            record.facts.get("database.engine.schema")?.value,
          ]);
          for (const version of [2, 3]) {
            expect(published).not.toContainEqual(expect.objectContaining({ storeId, version }));
          }
        }
        exec.call(this, sql);
      });
      const migrated = open(target);
      expect(commitObserved).toBe(true);
      expect(migrated.prepare("SELECT * FROM items").all()).toEqual([
        { id: 1, value: 6, label: "migrated", revision: 1 },
      ]);
      expect(getPostgresPhysicalFacts(migrated)?.version).toBe(3);
      expect(() => open(schema)).toThrow(/newer.*reverse-port/);
    });
  });

  it.each([
    [150000, "UTF8", "UTF8"],
    [170000, "SQL_ASCII", "UTF8"],
    [170000, "UTF8", "LATIN1"],
  ])(
    "refuses unsupported capabilities at admission (%s, %s, %s)",
    (version, serverEncoding, clientEncoding) => {
      const prepare = Reflect.get(
        PostgresSyncConnection.prototype,
        "prepare",
      ) as PostgresSyncConnection["prepare"];
      vi.spyOn(PostgresSyncConnection.prototype, "prepare").mockImplementation(function (
        this: PostgresSyncConnection,
        sql,
      ) {
        const statement = prepare.call(this, sql);
        if (sql.startsWith("SELECT current_setting")) {
          vi.spyOn(statement, "get").mockReturnValue({
            version,
            server_encoding: serverEncoding,
            client_encoding: clientEncoding,
          });
        }
        return statement;
      });
      expect(() => fixture(() => {})).toThrow(/version 16 or newer and UTF8/);
    },
  );
});
