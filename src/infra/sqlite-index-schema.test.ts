import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import {
  repairCanonicalSqliteIndexes,
  verifyAndRepairCanonicalSqliteIndexSteps,
} from "./sqlite-index-schema.js";
import { runSqliteIntegrityOperationSync } from "./sqlite-integrity.js";
import { assertSqliteSchemaContains } from "./sqlite-schema-contract.js";

const CANONICAL_SCHEMA = `
  CREATE TABLE records (
    id INTEGER PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    external_id TEXT,
    active INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_records_identity
    ON records(
      tenant_id COLLATE NOCASE,
      IFNULL(external_id, '')
    )
    WHERE active = 1;
  CREATE INDEX IF NOT EXISTS idx_records_active_lookup
    ON records(active, tenant_id);
  CREATE TABLE unindexed (id INTEGER PRIMARY KEY);
`;

import { sqliteSchemaFixture } from "./sqlite-schema-contract.test-support.js";

const expectedCatalog = sqliteSchemaFixture(CANONICAL_SCHEMA);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createDatabase(schema = CANONICAL_SCHEMA): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  return db;
}

function traceSqlExecutions(
  database: DatabaseSync,
  onIndexSql?: (sql: string) => void,
): {
  database: DatabaseSync;
  statements: string[];
  readonly materializedIndexSqlBytes: number;
} {
  const statements: string[] = [];
  let materializedIndexSqlBytes = 0;
  function observe(row: unknown) {
    if (
      row &&
      typeof row === "object" &&
      "sql" in row &&
      typeof row.sql === "string" &&
      /^CREATE (?:UNIQUE )?INDEX\b/iu.test(row.sql)
    ) {
      materializedIndexSqlBytes += Buffer.byteLength(row.sql, "utf8");
      onIndexSql?.(row.sql);
    }
  }
  return {
    database: new Proxy(database, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            return new Proxy(target.prepare(sql), {
              get(statement, method) {
                if (method === "iterate") {
                  return function* (...args: Parameters<typeof statement.iterate>) {
                    const rows = statement.iterate(...args);
                    statements.push(sql);
                    for (const row of rows) {
                      observe(row);
                      yield row;
                    }
                  };
                }
                if (method === "get" || method === "all") {
                  return (...args: unknown[]) => {
                    statements.push(sql);
                    const result = Reflect.apply(statement[method], statement, args);
                    for (const row of method === "all" ? result : [result]) {
                      observe(row);
                    }
                    return result;
                  };
                }
                const value = Reflect.get(statement, method, statement) as unknown;
                return typeof value === "function" ? value.bind(statement) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DatabaseSync,
    statements,
    get materializedIndexSqlBytes() {
      return materializedIndexSqlBytes;
    },
  };
}

describe("repairCanonicalSqliteIndexes", () => {
  it("inspects one committed index snapshot and releases it before later repair writes", () => {
    const filename = path.join(tempDirs.make("openclaw-index-snapshot-"), "state.sqlite");
    using writer = new DatabaseSync(filename);
    writer.exec(`PRAGMA journal_mode=WAL; ${CANONICAL_SCHEMA}`);
    using reader = new DatabaseSync(filename);
    let droppedIndex: string | undefined;
    const traced = traceSqlExecutions(reader, (sql) => {
      if (droppedIndex) {
        return;
      }
      droppedIndex = sql.includes("idx_records_identity")
        ? "idx_records_active_lookup"
        : "idx_records_identity";
      writer.exec(`DROP INDEX ${droppedIndex}`);
    });
    expect(repairCanonicalSqliteIndexes(traced.database, "test database", expectedCatalog)).toEqual(
      [],
    );
    expect(droppedIndex).toBeDefined();
    expect(repairCanonicalSqliteIndexes(reader, "test database", expectedCatalog)).toEqual([
      droppedIndex,
    ]);
    expect(reader.isTransaction).toBe(false);
    expect(reader.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  });

  it.each([["agent schema", OPENCLAW_AGENT_SCHEMA_SQL]])(
    "inspects canonical indexes with bounded SQL without rewriting them: %s",
    (_name, schema) => {
      using db = createDatabase(schema);
      const before = db.prepare("PRAGMA schema_version").get();
      const indexes = db
        .prepare("SELECT sql FROM main.sqlite_schema WHERE type = 'index' AND sql IS NOT NULL")
        .all();
      const indexSqlBytes = indexes.reduce((sum, row) => {
        if (typeof row.sql !== "string") {
          throw new Error("Expected fixture index DDL");
        }
        return sum + Buffer.byteLength(row.sql, "utf8");
      }, 0);
      const traced = traceSqlExecutions(db);

      expect(
        repairCanonicalSqliteIndexes(traced.database, "test database", schema, {
          verifyPhysicalIntegrity: false,
        }),
      ).toEqual([]);

      expect(db.prepare("PRAGMA schema_version").get()).toEqual(before);
      expect(traced.materializedIndexSqlBytes).toBeLessThanOrEqual(indexSqlBytes);
      expect(traced.statements.length).toBeLessThanOrEqual(7);
    },
  );

  it.each([
    [
      "column order",
      "CREATE UNIQUE INDEX idx_records_identity ON records(external_id, tenant_id) WHERE active = 1",
    ],
  ])("repairs same-name %s drift", (_name, driftedSql) => {
    using db = createDatabase();
    db.exec(`DROP INDEX idx_records_identity; ${driftedSql};`);

    expect(
      repairCanonicalSqliteIndexes(db, "test database", expectedCatalog, {
        validateAfterRepair: () => assertSqliteSchemaContains(db, "test database", expectedCatalog),
      }),
    ).toEqual(["idx_records_identity"]);

    const row = db
      .prepare("SELECT sql FROM sqlite_schema WHERE name = 'idx_records_identity'")
      .get() as { sql?: unknown };
    expect(row.sql).toContain("tenant_id COLLATE NOCASE");
    expect(row.sql).toContain("IFNULL(external_id, '')");
    expect(row.sql).toContain("WHERE active = 1");
    expect(() =>
      db.exec(`
          INSERT INTO records VALUES (1, 'Tenant', NULL, 1);
          INSERT INTO records VALUES (2, 'tenant', NULL, 1);
        `),
    ).toThrow(/UNIQUE constraint failed/iu);
  });

  it.each(["quick", "full"] as const)(
    "checks the %s source once and each rebuilt table once without losing rows",
    (check) => {
      using db = createDatabase();
      db.exec(`
          INSERT INTO records VALUES
            (1, 'Tenant', NULL, 1),
            (2, 'Other', 'two', 0);
          DROP INDEX idx_records_identity;
          DROP INDEX idx_records_active_lookup;
        `);
      const traced = traceSqlExecutions(db);

      expect(
        repairCanonicalSqliteIndexes(traced.database, "test database", expectedCatalog, {
          integrity: { check },
          validateAfterRepair: () =>
            assertSqliteSchemaContains(db, "test database", expectedCatalog),
        }),
      ).toEqual(["idx_records_active_lookup", "idx_records_identity"]);

      expect(
        traced.statements.filter((sql) =>
          /^PRAGMA (?:quick_check|integrity_check|foreign_key_check)\b/u.test(sql),
        ),
      ).toEqual([
        `PRAGMA ${check === "quick" ? "quick_check" : "integrity_check"};`,
        "PRAGMA foreign_key_check;",
        "PRAGMA integrity_check('records');",
      ]);
      expect(db.prepare("SELECT * FROM records ORDER BY id").all()).toEqual([
        { id: 1, tenant_id: "Tenant", external_id: null, active: 1 },
        { id: 2, tenant_id: "Other", external_id: "two", active: 0 },
      ]);
    },
  );

  it("rolls back without dropping the drifted index when canonical rows conflict", () => {
    using db = createDatabase();
    db.exec(`
        DROP INDEX idx_records_identity;
        CREATE UNIQUE INDEX idx_records_identity ON records(id);
        INSERT INTO records VALUES
          (1, 'Tenant', NULL, 1),
          (2, 'tenant', NULL, 1);
      `);

    expect(() => repairCanonicalSqliteIndexes(db, "test database", expectedCatalog)).toThrow(
      /canonical index idx_records_identity failed.*UNIQUE constraint failed/iu,
    );

    expect(
      db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'idx_records_identity'").get(),
    ).toEqual({
      sql: "CREATE UNIQUE INDEX idx_records_identity ON records(id)",
    });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'openclaw_probe_%'",
        )
        .all(),
    ).toEqual([]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it.each([
    {
      name: "idx_records_identity",
      unique: "UNIQUE ",
      definition: "tenant_id COLLATE NOCASE, IFNULL(external_id, '')",
      predicate: "tenant_id = 'Tenant' AND IFNULL(external_id, '') = '' AND active = 1",
      where: " WHERE active = 1",
    },
    {
      name: "idx_records_active_lookup",
      unique: "",
      definition: "active, tenant_id",
      predicate: "active = 1 AND tenant_id = 'Tenant'",
      where: "",
    },
  ])(
    "refuses physical $name damage until explicit Doctor repair",
    ({ name, unique, definition, predicate, where }) => {
      using db = createDatabase();
      db.exec(`
        DROP INDEX ${name};
        CREATE ${unique}INDEX ${name} ON records(id);
        INSERT INTO records VALUES
          (1, 'Tenant', NULL, 1),
          (2, 'Other', NULL, 1);
      `);
      db.enableDefensive?.(false);
      db.exec("PRAGMA writable_schema = ON;");
      db.prepare("UPDATE sqlite_schema SET sql = ? WHERE name = ?").run(
        `CREATE ${unique}INDEX ${name} ON records(${definition})${where}`,
        name,
      );
      db.exec("PRAGMA writable_schema = OFF;");
      db.exec(
        `PRAGMA schema_version = ${Number(db.prepare("PRAGMA schema_version").get()?.schema_version) + 1};`,
      );

      expect(db.prepare("PRAGMA integrity_check('records')").all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            integrity_check: expect.stringMatching(
              new RegExp(unique ? `missing from index ${name}` : name),
            ),
          }),
        ]),
      );
      expect(
        db.prepare(`SELECT id FROM records INDEXED BY ${name} WHERE ${predicate}`).all(),
      ).toEqual([]);

      const repair = () =>
        unique
          ? runSqliteIntegrityOperationSync(
              verifyAndRepairCanonicalSqliteIndexSteps(db, "test database", expectedCatalog),
            )
          : repairCanonicalSqliteIndexes(db, "test database", expectedCatalog);
      expect(repair).toThrow(/integrity_check failed.*openclaw doctor --fix/iu);
      expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).not.toBe("ok");
    },
  );

  it("removes bogus uniqueness from a canonical ordinary index", () => {
    using db = createDatabase();
    db.exec(`
        DROP INDEX idx_records_active_lookup;
        CREATE UNIQUE INDEX idx_records_active_lookup ON records(active, tenant_id);
      `);

    repairCanonicalSqliteIndexes(db, "test database", expectedCatalog);

    expect(
      (
        db.prepare("PRAGMA index_list(records)").all() as Array<{
          name: string;
          unique: number;
        }>
      ).find((index) => index.name === "idx_records_active_lookup"),
    ).toMatchObject({ unique: 0 });
    expect(() =>
      db.exec(`
          INSERT INTO records VALUES (1, 'Tenant', 'one', 0);
          INSERT INTO records VALUES (2, 'Tenant', 'two', 0);
        `),
    ).not.toThrow();
  });

  it.each([
    ["records", "idx_records_unexpected_unique"],
    ["unindexed", "idx_records_identity"],
  ])("rejects an unexpected unique index on %s named %s", (table, name) => {
    using db = createDatabase();
    db.exec(`DROP INDEX IF EXISTS ${name}; CREATE UNIQUE INDEX ${name} ON ${table}(id);`);

    expect(() => repairCanonicalSqliteIndexes(db, "test database", expectedCatalog)).toThrow(
      `unexpected unique index ${name}`,
    );
  });

  it.each([
    { deniedColumn: "sql", empty: true },
    { deniedColumn: "tbl_name", empty: true },
  ])(
    "preserves $deniedColumn authorization errors with absent indexes (empty=$empty)",
    ({ deniedColumn, empty }) => {
      using db = createDatabase();
      try {
        db.exec("DROP INDEX idx_records_identity; DROP INDEX idx_records_active_lookup;");
        if (empty) {
          db.exec("DROP TABLE records; DROP TABLE unindexed;");
        }
        db.setAuthorizer((action, table, column, schema) => {
          if (
            action === constants.SQLITE_READ &&
            (table === "sqlite_master" || table === "sqlite_schema") &&
            column === deniedColumn &&
            schema === "main"
          ) {
            return constants.SQLITE_DENY;
          }
          return constants.SQLITE_OK;
        });
        expect(() =>
          repairCanonicalSqliteIndexes(db, "test database", expectedCatalog, {
            verifyPhysicalIntegrity: false,
          }),
        ).toThrow(/access to sqlite_(?:master|schema)\.(?:sql|tbl_name) is prohibited/iu);
      } finally {
        db.setAuthorizer(null);
      }
    },
  );

  it("defers only indexes whose columns are owned by a pending migration", () => {
    using db = new DatabaseSync(":memory:");
    db.exec(`
        CREATE TABLE records (
          id INTEGER PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          external_id TEXT
        );
        CREATE INDEX idx_records_active_lookup ON records(tenant_id);
      `);

    expect(() => repairCanonicalSqliteIndexes(db, "test database", expectedCatalog)).toThrow(
      /no such column: active/iu,
    );
    expect(
      repairCanonicalSqliteIndexes(db, "test database", expectedCatalog, {
        allowMissingColumns: true,
      }),
    ).toEqual([]);
    expect(() =>
      repairCanonicalSqliteIndexes(db, "test database", expectedCatalog, {
        allowMissingColumns: true,
        validateUnchanged: (readTable) =>
          assertSqliteSchemaContains(db, "test database", expectedCatalog, {}, readTable),
      }),
    ).toThrow(/column definitions differ for records/iu);
    expect(
      db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'idx_records_active_lookup'").get(),
    ).toEqual({ sql: "CREATE INDEX idx_records_active_lookup ON records(tenant_id)" });

    db.exec("ALTER TABLE records ADD COLUMN active INTEGER NOT NULL DEFAULT 0;");
    expect(
      repairCanonicalSqliteIndexes(db, "test database", expectedCatalog, {
        allowMissingColumns: true,
      }),
    ).toEqual(["idx_records_active_lookup", "idx_records_identity"]);
  });

  it.each([false, true])(
    "repairs only the main schema with a temporary same-name index (shadowed pragmas=%s)",
    (shadowedPragmas) => {
      using db = createDatabase();
      if (shadowedPragmas) {
        db.exec(`
            CREATE TEMP TABLE pragma_index_list (synthetic TEXT);
            CREATE TEMP VIEW pragma_index_xinfo AS SELECT 'synthetic' AS name;
          `);
      }
      db.exec(`
          CREATE TEMP TABLE temp_records (id INTEGER PRIMARY KEY);
          CREATE UNIQUE INDEX temp.idx_records_identity ON temp_records(id);
          DROP INDEX main.idx_records_identity;
          CREATE UNIQUE INDEX main.idx_records_identity ON records(id);
        `);

      repairCanonicalSqliteIndexes(db, "test database", expectedCatalog);

      expect(
        db.prepare("SELECT sql FROM main.sqlite_schema WHERE name = 'idx_records_identity'").get(),
      ).toEqual({
        sql: expect.stringContaining("tenant_id COLLATE NOCASE"),
      });
      expect(
        db.prepare("SELECT sql FROM temp.sqlite_schema WHERE name = 'idx_records_identity'").get(),
      ).toEqual({
        sql: "CREATE UNIQUE INDEX idx_records_identity ON temp_records(id)",
      });
    },
  );
});
