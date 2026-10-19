import assert from "node:assert/strict";
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
import { getPostgresPhysicalFacts } from "./physical-facts.js";
import { openPortStore } from "./port-backup.test-support.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const ddl = `CREATE TABLE items (id BIGINT PRIMARY KEY, value BIGINT NOT NULL DEFAULT 0 CHECK (value >= 0));
CREATE INDEX active_items ON items(value) WHERE value > 0;
CREATE FUNCTION bump() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.value := NEW.value + 1; RETURN NEW; END$$;
CREATE TRIGGER bump BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION bump();`;
const schema: StoreSchema = { id: "fixture", version: 1, sqlite: "", postgres: ddl };

const pgInput = { connection: connection!, schemaPrefix: "r2" };

const row = (db: PostgresSyncConnection, sql: string) => db.prepare(sql).get();

function fixture(
  test: (input: {
    open: (schema?: StoreSchema) => PostgresSyncConnection;
    db: PostgresSyncConnection;
    invalidate: () => void;
  }) => void,
) {
  return () =>
    withEngineStoreAdmission(() => {
      using anchor = openNodeSqliteDatabase(path.join(dirs.make("pg-schema-"), "anchor.sqlite"));
      const connections: PostgresSyncConnection[] = [];
      const open = (selected = schema) => {
        const db = openPortStore(anchor, selected, pgInput);
        assert(db instanceof PostgresSyncConnection);
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
        }
      }
    });
}

describe.skipIf(!connection)("PostgreSQL schema admission", () => {
  it(
    "reads an existing anchor while another handle holds write admission",
    fixture(({ db }) => {
      db.exec("INSERT INTO items (id) VALUES (1)");
      const location = db.anchor.location();
      assert(location, "Expected a file-backed PostgreSQL anchor");
      using reader = openNodeSqliteDatabase(location);
      revokeSqliteDatabaseAdmissions(db.anchor);
      db.anchor.exec("BEGIN IMMEDIATE");
      try {
        const opened = openPortStore(reader, schema, pgInput, true);
        try {
          expect(opened.prepare("SELECT value FROM items").all()).toEqual([{ value: 1 }]);
        } finally {
          opened.close();
        }
      } finally {
        db.anchor.exec("ROLLBACK");
      }
    }),
  );

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
    })();
  });

  it(
    "admits unchanged stores with one catalog read and rechecks a changed server major",
    fixture(({ db, open, invalidate }) => {
      invalidate();
      const queries: string[] = [];
      const count = (prefix: string) => queries.filter((sql) => sql.startsWith(prefix)).length;
      const listener = (message: unknown) => {
        const event = message as { engine: string; sql: string };
        if (event.engine === "postgres") {
          queries.push(event.sql);
        }
      };
      const observations = channel("openclaw.database.statement");
      observations.subscribe(listener);
      try {
        open();
        expect([count("WITH captured"), count("CREATE SCHEMA")]).toEqual([1, 0]);
        db.exec("UPDATE openclaw_schema_meta SET server_major = 0");
        invalidate();
        queries.length = 0;
        open();
        expect([count("CREATE SCHEMA"), count("DROP SCHEMA")]).toEqual([1, 1]);
        expect(row(db, "SELECT server_major FROM openclaw_schema_meta")?.server_major).toBe(
          getPostgresPhysicalFacts(db)?.capabilities.serverMajor,
        );
      } finally {
        observations.unsubscribe(listener);
      }
    }),
  );

  it(
    "verifies unsealed port metadata and drops scratch on refusal",
    fixture(({ db, open, invalidate }) => {
      db.exec(
        "ALTER TABLE openclaw_schema_meta DROP COLUMN fingerprint, DROP COLUMN ddl_hash, DROP COLUMN server_major",
      );
      invalidate();
      open();
      expect(row(db, "SELECT length(fingerprint) AS n FROM openclaw_schema_meta")?.n).toBe(64);
      db.exec(
        "ALTER TABLE items ALTER COLUMN value SET DEFAULT 2; UPDATE openclaw_schema_meta SET server_major = 0",
      );
      invalidate();
      const scratches: string[] = [];
      observeExec((sql) => {
        const match = /^CREATE SCHEMA "(openclaw_check_[^"]+)"$/.exec(sql);
        if (match) {
          scratches.push(match[1]!);
        }
      });
      expect(() => open()).toThrow("schema drift detected against generated DDL");
      expect(scratches).toHaveLength(1);
      for (const namespace of scratches) {
        expect(
          db.prepare("SELECT nspname FROM pg_namespace WHERE nspname = ?").get(namespace),
        ).toBeUndefined();
      }
    }),
  );

  it(
    "re-admits equivalent DDL text after exact catalog comparison",
    fixture(({ db, open, invalidate }) => {
      db.runTransaction(() => db.exec("INSERT INTO items VALUES (1, 5)"));
      const previous = row(db, "SELECT ddl_hash FROM openclaw_schema_meta")?.ddl_hash;
      invalidate();
      const reopened = open({ ...schema, postgres: `-- Equivalent fragment grouping\n${ddl}` });
      expect(row(reopened, "SELECT value FROM items WHERE id = 1")?.value).toBe(6);
      expect(row(reopened, "SELECT ddl_hash FROM openclaw_schema_meta")?.ddl_hash).not.toBe(
        previous,
      );
    }),
  );

  it(
    "rejects a generated DDL change at the same version",
    fixture(({ open, invalidate }) => {
      invalidate();
      expect(() => open({ ...schema, postgres: ddl.replace("DEFAULT 0", "DEFAULT 9") })).toThrow(
        "schema drift detected against generated DDL",
      );
    }),
  );

  it(
    "migrates two versions atomically and rolls back both steps on failure",
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
      const before = row(db, "SELECT * FROM openclaw_schema_meta");
      const expectRollback = () => {
        expect(row(db, "SELECT * FROM openclaw_schema_meta")).toEqual(before);
        expect(db.prepare("SELECT * FROM items").all()).toEqual([{ id: 1, value: 6 }]);
      };
      expect(() => open(target)).toThrow("missing_column");
      expectRollback();
      expect(getPostgresPhysicalFacts(db)?.version).toBe(1);
      for (const step of target.postgresMigrations!) {
        step.sql = step.sql.split("; SELECT")[0]!;
      }
      const secondStep = target.postgresMigrations![1]!;
      secondStep.sql = secondStep.sql.replace("DEFAULT 1", "DEFAULT 2");
      expect(() => open(target)).toThrow("generated DDL");
      expectRollback();
      secondStep.sql = secondStep.sql.replace("DEFAULT 2", "DEFAULT 1");
      db.exec("UPDATE openclaw_schema_meta SET server_major = 0");
      const storeId = getPostgresPhysicalFacts(db)?.storeId;
      let commitObserved = false;
      observeExec((sql) => {
        if (sql === "COMMIT") {
          commitObserved = true;
          const published = captureSqliteDatabaseAdmissions().flatMap((record) => [
            record.facts.get("database.engine.schema")?.value,
          ]);
          for (const version of [2, 3]) {
            expect(published).not.toContainEqual(expect.objectContaining({ storeId, version }));
          }
        }
      });
      const migrated = open(target);
      expect(commitObserved).toBe(true);
      expect(migrated.prepare("SELECT * FROM items").all()).toEqual([
        { id: 1, value: 6, label: "migrated", revision: 1 },
      ]);
      expect(getPostgresPhysicalFacts(migrated)?.version).toBe(3);
      expect(() => open(schema)).toThrow(/newer.*reverse-port/);
    }),
  );

  it.each([
    [150000, "UTF8", "UTF8"],
    [170000, "SQL_ASCII", "UTF8"],
    [170000, "UTF8", "LATIN1"],
  ])(
    "refuses unsupported capabilities at admission (%s, %s, %s)",
    (version, serverEncoding, clientEncoding) => {
      const prepare = PostgresSyncConnection.prototype.prepare;
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
      expect(fixture(() => {})).toThrow(/version 16 or newer and UTF8/);
    },
  );
});

function observeExec(observe: (sql: string) => void) {
  const exec = PostgresSyncConnection.prototype.exec;
  vi.spyOn(PostgresSyncConnection.prototype, "exec").mockImplementation(function (
    this: PostgresSyncConnection,
    sql,
  ) {
    observe(sql);
    exec.call(this, sql);
  });
}
