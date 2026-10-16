import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  generatePostgresSchemas,
  generateLogbookPostgresSchema,
  generateWorkboardPostgresSchema,
  pendingPromotion,
} from "../../scripts/generate-postgres-schema.mts";
import { catalog as readCatalog, portTables } from "../../scripts/lib/postgres-schema-catalog.mts";
import { generateSqliteSchemaCatalogs } from "../../scripts/lib/sqlite-schema-generation.mts";
import { listOpenClawStateFeatureSchemas } from "../../src/state/openclaw-state-feature-schema.js";
import type statePortMetadata from "../../src/state/postgres-schema.generated/state-port.json";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readRoot = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const reportOnly = (directory: string) =>
  generatePostgresSchemas(directory, "openclaw", { reportOnly: true });

function withDatabase<T>(run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(":memory:");
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function fixture(sql: string, verify?: (db: DatabaseSync) => void) {
  if (verify) {
    withDatabase((db) => {
      db.exec(`PRAGMA foreign_keys = ON; ${sql}`);
      verify(db);
    });
  }
  const directory = tempDirs.make("postgres-schema-");
  fs.mkdirSync(path.join(directory, "src/state"), { recursive: true });
  fs.writeFileSync(path.join(directory, "src/state/openclaw-state-schema.sql"), sql);
  fs.writeFileSync(path.join(directory, "src/state/openclaw-agent-schema.sql"), "");
  return directory;
}

describe("PostgreSQL schema generation", () => {
  it("generates state port metadata from every canonical table and optional fragment", async () => {
    const { files, report } = await generatePostgresSchemas(root);
    const metadata: typeof statePortMetadata = JSON.parse(files["state-port.json"]!);
    const schemas = [metadata, ...metadata.fragments];
    expect(
      schemas.flatMap((schema) => schema.tables.map((table) => table.name)).toSorted(),
    ).toEqual(report.catalogs.state!.tables.map((table) => table.name).toSorted());
    expect(
      metadata.fragments.find((fragment) => fragment.id === "agent_deletion_journal"),
    ).toBeDefined();
    expect(Buffer.byteLength(files["state-port.json"]!)).toBeLessThan(60_000);
    expect(schemas.some((schema) => "sqlite" in schema || "objects" in schema)).toBe(false);
    expect(schemas.flatMap((schema) => schema.tables).some((table) => "columns" in table)).toBe(
      false,
    );
  });

  it("preserves all agent relational objects and declares search separately", async () => {
    const { files, report } = await generatePostgresSchemas(root);
    const agent = report.catalogs.agent!;
    for (const kind of ["table", "column", "default", "check", "index", "foreignKey", "trigger"]) {
      expect(
        agent.objects.filter(
          (item) =>
            item.kind === kind &&
            item.sql === null &&
            item.table !== "sqlite_sequence" &&
            item.pendingCapability !== "search",
        ),
        kind,
      ).toEqual([]);
    }
    expect(agent.objects.filter((item) => item.kind === "trigger" && item.sql)).toHaveLength(10);
    expect(agent.objects.filter((item) => item.kind === "triggerFunction")).toHaveLength(4);
    expect(agent.objects.filter((item) => item.kind === "check" && item.sql)).toHaveLength(66);
    const pending = report.pendingCapabilities.filter((item) => item.database === "agent");
    expect(pending.filter((item) => item.kind === "trigger")).toHaveLength(4);
    expect(pending.filter((item) => item.kind === "virtualTable")).toHaveLength(2);
    expect(JSON.parse(files["manifest.json"]!).pendingCapabilities).toEqual(
      report.pendingCapabilities,
    );
    for (const fragment of [
      "NEW.session_key IS DISTINCT FROM OLD.session_key",
      "NEW.route_context_json IS NOT DISTINCT FROM OLD.route_context_json",
    ]) {
      expect(files["agent.postgres.sql"]).toContain(fragment);
    }
    expect(files["portability-report.md"]).toContain(
      "Duplicate-key JSON is unreachable from writers",
    );
  });

  it("refuses unsupported agent objects and trigger bodies", async () => {
    const directory = fixture("");
    const file = path.join(directory, "src/state/openclaw-agent-schema.sql");
    fs.writeFileSync(file, "CREATE TABLE unsupported (id INTEGER DEFAULT (abs(-1))) STRICT;");
    await expect(generatePostgresSchemas(directory)).rejects.toThrow(
      /Unsupported agent default.*abs/,
    );
    fs.writeFileSync(
      file,
      readRoot("src/state/openclaw-agent-schema.sql").replace(
        "snapshot_revision + 1",
        "snapshot_revision + 2",
      ),
    );
    await expect(generatePostgresSchemas(directory)).rejects.toThrow(/Unsupported trigger update/);
  });

  it("keeps the complete workboard artifact current and uses the admitted search path", async () => {
    const { sql, catalog, portMetadata } = await generateWorkboardPostgresSchema();
    expect(sql).toBe(readRoot("extensions/workboard/src/workboard-schema.postgres.sql"));
    expect(catalog.objects.filter((item) => item.sql === null)).toEqual([]);
    expect(sql).toContain('CREATE TABLE "workboard_cards" (');
    expect(sql).toContain('"content" bytea NOT NULL');
    expect(sql).toContain("CHECK ((\"source\" IN ('state', 'model', 'operator')))");
    expect(sql).toContain(
      'REFERENCES "workboard_cards" ("id") ON UPDATE NO ACTION ON DELETE CASCADE',
    );
    expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT|CREATE SCHEMA)\b/);
    expect(sql).toMatch(/[^\n]\n$/);
    expect(portMetadata).toEqual(
      JSON.parse(readRoot("src/infra/database-engine/workboard-port.generated.json")),
    );
    const preData = sql.slice(portMetadata.preData[0], portMetadata.preData[1]);
    const postData = sql.slice(portMetadata.postData[0], portMetadata.postData[1]);
    expect(preData + postData).toBe(sql);
    expect(preData).toContain('CREATE TABLE "workboard_cards"');
    expect(preData).not.toMatch(/CREATE (?:UNIQUE )?INDEX|ALTER TABLE/);
    expect(postData).not.toContain("CREATE TABLE");
    expect(postData).toContain('CREATE INDEX "workboard_cards_board_status_idx"');
    expect(postData).toContain('ALTER TABLE "workboard_card_labels" ADD FOREIGN KEY');
  });

  it("keeps Logbook DDL and port allocation metadata current", async () => {
    const { sql, portMetadata } = await generateLogbookPostgresSchema();
    expect(sql).toBe(readRoot("extensions/logbook/src/logbook-schema.postgres.sql"));
    expect(portMetadata).toEqual(
      JSON.parse(readRoot("src/infra/database-engine/logbook-port.generated.json")),
    );
    expect(portMetadata.tables.flatMap((table) => table.identities)).toEqual(
      Array.from({ length: 4 }, () => ({ column: "id", autoIncrement: true })),
    );
    expect(sql).not.toContain("sqlite_sequence");
    expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT|CREATE SCHEMA)\b/);
  });

  it("derives identity allocation semantics and composite keys from canonical SQLite", () => {
    withDatabase((db) => {
      db.exec(`
        CREATE TABLE allocated (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
        CREATE TABLE reused (id INTEGER PRIMARY KEY, note TEXT DEFAULT 'AUTOINCREMENT') STRICT;
        CREATE TABLE paired (left_id TEXT, right_id INTEGER, PRIMARY KEY(left_id, right_id)) STRICT;
      `);
      const tables = portTables(readCatalog(db, ""));
      expect(tables.map(({ name, pk, identities }) => ({ name, pk, identities }))).toEqual([
        { name: "allocated", pk: ["id"], identities: [{ column: "id", autoIncrement: true }] },
        { name: "paired", pk: ["left_id", "right_id"], identities: [] },
        { name: "reused", pk: ["id"], identities: [{ column: "id", autoIncrement: false }] },
      ]);
    });
  });

  it("renders eager and lazy state DDL inside the connection owner's namespace and transaction", async () => {
    const { files, report } = await generatePostgresSchemas(root);
    for (const file of [
      "state.postgres.sql",
      "state-v23-v24.postgres.sql",
      "state-v24-v25.postgres.sql",
      "agent.postgres.sql",
      "agent-search.postgres.sql",
      ...report.fragments.map((item) => item.file),
    ]) {
      expect(files[file], file).not.toMatch(/^(?:BEGIN;|COMMIT;|SET |CREATE SCHEMA )/m);
      expect(files[file], file).not.toContain('"openclaw_state".');
      expect(files[file], file).not.toContain('"openclaw_agent".');
    }
    expect(files["state.postgres.sql"]).toContain('CREATE TABLE "schema_meta" (');
    const backgrounds = report.fragments.find((item) =>
      item.tables.includes("user_background_images"),
    )!;
    expect(files[backgrounds.file]).toContain('CREATE TABLE "user_background_images" (');
    expect(files[backgrounds.file]).toContain('REFERENCES "user_profiles"');
    expect(files["state.postgres.sql"]).not.toContain('CREATE TABLE "user_background_images"');
  });

  it("accounts for every canonical SQLite object and generates identical bytes twice", async () => {
    const { files, report } = await generatePostgresSchemas(root);
    expect((await generatePostgresSchemas(root)).files).toEqual(files);
    expect(Object.keys(files).toSorted()).toEqual(
      [
        "agent-port.json",
        "agent-runtime.ts",
        "agent.postgres.sql",
        "agent-search-runtime.ts",
        "agent-search.postgres.sql",
        ...report.fragments.map((fragment) => fragment.file),
        "manifest.json",
        "portability-report.md",
        "state.postgres.sql",
        "state-v23-v24.postgres.sql",
        "state-v24-v25.postgres.sql",
        "runtime.ts",
        "sqlite-catalogs.ts",
        "sqlite-state-catalogs.ts",
        "sqlite-state-catalogs.json",
        "sqlite-agent-catalogs.ts",
        "sqlite-agent-catalogs.json",
        "sqlite-daemon-catalogs.ts",
        "sqlite-daemon-catalogs.json",
        "sqlite-memory-catalogs.ts",
        "sqlite-memory-catalogs.json",
        "state-port.json",
      ].toSorted(),
    );
    expect(
      report.catalogs
        .state!.objects.filter((item) => item.sql === null && item.kind === "index")
        .map((item) => item.name)
        .toSorted(),
    ).toEqual(pendingPromotion.map((item) => item.name).toSorted());
    for (const fragment of report.fragments) {
      for (const table of fragment.tables) {
        expect(files["state.postgres.sql"]).not.toContain(`CREATE TABLE "${table}"`);
        expect(files[fragment.file]).toContain(`CREATE TABLE "${table}"`);
      }
    }
    const exported = await generatePostgresSchemas(root, "openclaw", { includeJsonReport: true });
    expect(JSON.parse(exported.files["portability-report.json"]!)).toEqual(report);
    for (const name of ["state", "agent"]) {
      withDatabase((db) => {
        db.exec(readRoot(`src/state/openclaw-${name}-schema.sql`));
        if (name === "state") {
          for (const fragment of listOpenClawStateFeatureSchemas()) {
            db.exec(fragment.sql());
          }
        }
        const expected: string[] = [];
        const add = (kind: string, table: unknown, item: unknown) =>
          expected.push(JSON.stringify([kind, table, item]));
        const rows = db
          .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type != 'index'")
          .all();
        const tableKinds = new Map(
          db
            .prepare("PRAGMA table_list")
            .all()
            .map((row) => [row.name, row.type]),
        );
        for (const row of rows) {
          if (row.type !== "table") {
            add(String(row.type), row.tbl_name, row.name);
            continue;
          }
          const kind = tableKinds.get(row.name);
          const excluded = kind !== "table" || String(row.name).startsWith("sqlite_");
          add(
            kind === "virtual" ? "virtualTable" : excluded ? "internalTable" : "table",
            row.name,
            row.name,
          );
          for (const [objectKind, pragma, field] of [
            ["column", "table_xinfo", "name"],
            ["index", "index_list", "name"],
            ["foreignKey", "foreign_key_list", "id"],
          ] as const) {
            const query = `SELECT DISTINCT ${field} AS value FROM pragma_${pragma}(?)`;
            for (const item of db.prepare(query).all(String(row.name))) {
              add(objectKind, row.name, String(item.value));
            }
          }
          if (!excluded) {
            const checks = String(row.sql).match(/\bCHECK\s*\(/gi) ?? [];
            checks.forEach((_, index) => add("check", row.name, String(index)));
          }
        }
        const catalog = report.catalogs[name]!;
        const inventoryKinds = new Set([
          "table",
          "column",
          "index",
          "foreignKey",
          "check",
          "trigger",
          "virtualTable",
          "internalTable",
          "view",
        ]);
        expect(
          catalog.objects
            .filter((item) => inventoryKinds.has(item.kind))
            .map((item) => JSON.stringify([item.kind, item.table, item.name]))
            .toSorted(),
        ).toEqual(expected.toSorted());
        for (const item of catalog.objects) {
          if (item.sql === null) {
            expect(item.reason, `${name}: ${item.kind} ${item.table}.${item.name}`).toBeTruthy();
            expect(files["portability-report.md"]).toContain(`\`${item.table}.${item.name}\``);
          } else {
            expect(
              Object.values(files).join("\n"),
              `${item.kind} ${item.table}.${item.name}`,
            ).toContain(item.sql);
          }
        }
      });
    }
  });

  it("generates computed fragments after their owner prepares native SQLite capabilities", async () => {
    const fragments = [3, 8].map((dimensions) => ({
      id: `memory-vector-${dimensions}`,
      store: "memory",
      sql: `CREATE TABLE memory_vector_${dimensions} (embedding BLOB CHECK (length(embedding) = vector_dimensions())) STRICT;`,
      prepare: (db: DatabaseSync) => {
        db.function("vector_dimensions", { deterministic: true }, () => dimensions);
      },
    }));
    const first = fragments[0]!;
    await expect(
      generateSqliteSchemaCatalogs([{ id: first.id, store: first.store, sql: first.sql }], root),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining("no such function") } });

    const files = await generateSqliteSchemaCatalogs(fragments, root);
    expect(JSON.parse(files["sqlite-memory-catalogs.json"]!)).toMatchObject({
      tables: [3, 8].map((dimensions) => ({
        name: `memory_vector_${dimensions}`,
        sql: `CREATE TABLE memory_vector_${dimensions} (embedding BLOB CHECK (length(embedding) = vector_dimensions())) STRICT`,
        columns: [{ name: "embedding", type: "BLOB" }],
      })),
    });
  });

  it("preserves mapped types, keys, defaults, index ordering, and foreign-key timing", async () => {
    const directory = fixture(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL UNIQUE) STRICT;
      CREATE TABLE child (
        parent_id INTEGER REFERENCES parent(id) ON UPDATE CASCADE ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
        position INTEGER NOT NULL,
        alias INT NOT NULL DEFAULT 0,
        label TEXT DEFAULT 'O''Reilly',
        ratio REAL DEFAULT 1.5,
        payload BLOB,
        PRIMARY KEY (position, alias), UNIQUE (parent_id, label)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX child_label ON child(label DESC, position ASC) WHERE parent_id IS NOT NULL;
    `);
    const { files, report } = await generatePostgresSchemas(directory, 'proof"scope');
    const sql = files["state.postgres.sql"]!;
    expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT|CREATE SCHEMA)\b/);
    expect(files["agent.postgres.sql"]).not.toMatch(/^(?:BEGIN|COMMIT|CREATE SCHEMA)\b/m);
    expect(sql).toContain('"id" bigint GENERATED BY DEFAULT AS IDENTITY');
    expect(sql).toContain('PRIMARY KEY ("position", "alias")');
    expect(sql).toContain('UNIQUE ("parent_id", "label")');
    expect(sql).toContain('"alias" bigint NOT NULL DEFAULT 0');
    expect(sql).toContain("DEFAULT 'O''Reilly'");
    expect(sql).toContain('"ratio" double precision DEFAULT 1.5');
    expect(sql).toContain('"payload" bytea');
    expect(sql).toContain('("label") DESC NULLS LAST');
    expect(sql).toContain('("position") ASC NULLS FIRST');
    expect(sql).toContain('WHERE "parent_id" IS NOT NULL');
    expect(sql).toContain(
      'REFERENCES "parent" ("id") ON UPDATE CASCADE ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED',
    );
    expect(sql.indexOf('CREATE TABLE "parent"')).toBeLessThan(sql.indexOf("ADD FOREIGN KEY"));
    expect(sql).not.toMatch(/\bSTRICT\b|WITHOUT ROWID|AUTOINCREMENT/);
    expect(
      report.catalogs.state!.tables.find((table) => table.name === "parent")?.columns[0],
    ).toMatchObject({
      type: "bigint",
      nullable: false,
      identity: true,
    });
    expect(report.catalogs.state!.notes.join("\n")).toContain("sqlite_sequence");
    expect(fs.readdirSync(directory)).toEqual(["src"]);
  });

  it("translates the explicit expression subset and records refusals without weakening indexes", async () => {
    const accepted = [
      ["value >= -2 AND value <= +9", '"value" >= -2'],
      ["value == 1 OR value <> 2", '"value" = 1'],
      ["value IN (-1, 0, 1)", '"value" IN (-1, 0, 1)'],
      ["value NOT IN (3, 4)", '"value" NOT IN (3, 4)'],
      ["optional IS NULL OR length(optional) > 0", 'char_length("optional")'],
      ["value BETWEEN 0 AND 9", '"value" BETWEEN 0 AND 9'],
      ["NOT (value = 3)", "NOT ("],
      ["json_valid(document)", '"document" IS JSON'],
      ["length(payload) <= 32", 'octet_length("payload")'],
      ["length(CAST(name AS BLOB)) <= 32", "octet_length(convert_to("],
      ["name IS optional", '"name" IS NOT DISTINCT FROM "optional"'],
      ["name IS NOT optional", '"name" IS DISTINCT FROM "optional"'],
      ["trim(name) = name", 'btrim("name")'],
      ["substr(name, 1, 2) = 'aa'", 'substr("name", 1, 2)'],
      ["coalesce(optional, name) = name", 'coalesce("optional", "name")'],
      ["ifnull(optional, '') = name", "coalesce(\"optional\", '')"],
      ["octet_length(name) <= 32", 'octet_length("name")'],
      ["name NOT LIKE '%/%' AND name NOT LIKE '%\\%'", "strpos(\"name\", '/') = 0"],
      ["typeof(value) = 'integer'", "ELSE 'integer' END"],
      ["name GLOB 'run-?.*'", String.raw`\Arun-.\..*\Z`],
      ["name NOT GLOB '*[^A-Za-z0-9_-]*'", String.raw`!~ '\A.*[^A-Za-z0-9_-].*\Z'`],
    ];
    const refused = [
      "json_extract(document, '$.kind') = 'x'",
      "name COLLATE NOCASE = 'x'",
      "value",
      "name = 1",
      "name GLOB '[[]'",
    ];
    const directory = fixture(`
      CREATE TABLE records (
        value INTEGER, optional TEXT, document TEXT, payload BLOB, name TEXT,
        unsupported_default INTEGER DEFAULT (abs(-1)),
        ${[...accepted.map(([source]) => source), ...refused].map((source) => `CHECK (${source})`).join(",\n")}
      ) STRICT;
      CREATE INDEX record_length ON records(length(name)) WHERE value >= 0;
      CREATE UNIQUE INDEX refused_expression ON records(json_extract(document, '$.kind'));
      CREATE UNIQUE INDEX refused_predicate ON records(name) WHERE abs(value) = 1;
      CREATE INDEX refused_collation ON records(name COLLATE NOCASE);
    `);
    await expect(generatePostgresSchemas(directory)).rejects.toThrow(
      /Unsupported shared-state default records.unsupported_default.*abs/,
    );
    const { files, report } = await reportOnly(directory);
    const objects = report.catalogs.state!.objects;
    const checks = objects.filter((item) => item.kind === "check");
    expect(checks).toHaveLength(accepted.length + refused.length);
    for (const [index, [source, expected]] of accepted.entries()) {
      expect(checks[index]?.sql, source).toContain(expected);
      expect(files["state.postgres.sql"]).toContain(`CHECK (${checks[index]!.sql})`);
    }
    for (const item of checks.slice(accepted.length)) {
      expect(item.sql, item.source).toBeNull();
      expect(item.reason).toBeTruthy();
    }
    expect(files["state.postgres.sql"]).toContain('(char_length("name")) ASC NULLS FIRST');
    for (const name of [
      "unsupported_default",
      "refused_expression",
      "refused_predicate",
      "refused_collation",
    ]) {
      const item = objects.find(
        (entry) => entry.name === name && ["default", "index"].includes(entry.kind),
      );
      expect(item, name).toMatchObject({ sql: null, reason: expect.any(String) });
      expect(files["state.postgres.sql"]).not.toContain(`INDEX "${name}"`);
    }
    expect(files["state.postgres.sql"]).not.toContain("abs(");
  });

  it("reports an unrepresentable table and dependent foreign key without dangling DDL", async () => {
    const directory = fixture(`
      CREATE TABLE mixed (id ANY PRIMARY KEY) STRICT;
      CREATE TABLE child (id TEXT PRIMARY KEY, mixed_id ANY REFERENCES mixed(id)) STRICT;
      CREATE TABLE dependent (id INTEGER PRIMARY KEY, target TEXT REFERENCES mixed(id)) STRICT;
      CREATE VIEW projection AS SELECT id FROM mixed;
    `);
    const { files, report } = await reportOnly(directory);
    const objects = report.catalogs.state!.objects;
    for (const [kind, table, reason] of [
      ["table", "mixed", expect.stringContaining("ANY")],
      ["foreignKey", "dependent", expect.any(String)],
      ["view", "projection", expect.any(String)],
    ]) {
      expect(objects.find((item) => item.kind === kind && item.table === table)).toMatchObject({
        sql: null,
        reason,
      });
    }
    expect(files["state.postgres.sql"]).not.toContain('REFERENCES "mixed"');
    expect(report.catalogs.state!.tables.map((table) => table.name)).toEqual(["dependent"]);
  });

  it.each([
    ["standalone unique index", "INTEGER", "INTEGER", false],
    ["omitted parent unique constraint", "TEXT COLLATE NOCASE UNIQUE", "TEXT", true],
    ["incompatible mapped column types", "TEXT PRIMARY KEY", "INTEGER", true],
  ] as const)("ports or reports a foreign key with %s", async (_, parent, child, omitted) => {
    const directory = fixture(
      `CREATE TABLE parent (id ${parent}) ${omitted ? "STRICT" : ""};
       ${omitted ? "" : "CREATE UNIQUE INDEX parent_id ON parent(id);"}
       CREATE TABLE child (parent_id ${child} REFERENCES parent(id)) ${omitted ? "STRICT" : ""};`,
      (db) => {
        db.exec("INSERT INTO parent VALUES ('1'); INSERT INTO child VALUES (1);");
        expect(db.prepare("SELECT COUNT(*) AS count FROM child").get()?.count).toBe(1);
        expect(() => db.exec("INSERT INTO child VALUES (2)")).toThrow(/FOREIGN KEY/);
      },
    );
    const { files, report } = await generatePostgresSchemas(directory, "openclaw", {
      reportOnly: omitted,
    });
    const sql = files["state.postgres.sql"]!;
    const catalog = report.catalogs.state!;
    expect(catalog.tables.map((table) => table.name).toSorted()).toEqual(["child", "parent"]);
    expect(sql).toContain('CREATE TABLE "parent"');
    expect(sql).toContain('CREATE TABLE "child"');
    if (omitted) {
      const foreignKey = catalog.objects.find((item) => item.kind === "foreignKey");
      expect(foreignKey).toMatchObject({ sql: null });
      expect(foreignKey?.reason).toBeTruthy();
      expect(sql).not.toContain("ADD FOREIGN KEY");
    } else {
      expect(sql).toContain('CREATE UNIQUE INDEX "parent_id"');
      expect(sql).toContain('ADD FOREIGN KEY ("parent_id")');
      expect(sql.indexOf('CREATE UNIQUE INDEX "parent_id"')).toBeLessThan(
        sql.indexOf("ADD FOREIGN KEY"),
      );
    }
  });

  it.each(["PRIMARY KEY", "UNIQUE", "NOT NULL"])(
    "reports the discarded %s conflict policy",
    async (constraint) => {
      const directory = fixture(
        `CREATE TABLE records (value TEXT ${constraint} ON CONFLICT IGNORE) STRICT;`,
        (db) => {
          const insert = db.prepare("INSERT INTO records VALUES (?)");
          expect(insert.run("first").changes).toBe(1);
          expect(insert.run(constraint === "NOT NULL" ? null : "first").changes).toBe(0);
          expect(db.prepare("SELECT COUNT(*) AS count FROM records").get()?.count).toBe(1);
        },
      );
      const { report } = await reportOnly(directory);
      const objects = report.catalogs.state!.objects;
      expect(
        objects.some(
          (item) =>
            item.table === "records" &&
            item.sql === null &&
            /ON CONFLICT IGNORE/i.test(item.source) &&
            /conflict/i.test(item.reason ?? ""),
        ),
      ).toBe(true);
      const table = objects.find((item) => item.kind === "table" && item.name === "records")!;
      if (table.sql !== null) {
        expect(table.sql).toContain(constraint);
      }
    },
  );

  it("reports nullable non-STRICT primary keys instead of forbidding valid NULL rows", async () => {
    const directory = fixture("CREATE TABLE nullable_key (id TEXT PRIMARY KEY);", (db) => {
      db.exec("INSERT INTO nullable_key VALUES (NULL), (NULL)");
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM nullable_key WHERE id IS NULL").get()?.count,
      ).toBe(2);
    });
    const { files, report } = await reportOnly(directory);
    expect(report.catalogs.state!.objects.find((item) => item.kind === "table")).toMatchObject({
      sql: null,
      reason: expect.stringMatching(/nullable.*primary|primary.*nullable/i),
    });
    expect(files["state.postgres.sql"]).not.toContain('CREATE TABLE "nullable_key"');
  });

  it("reports a translated boolean default that is incompatible with its bigint column", async () => {
    const directory = fixture(
      "CREATE TABLE defaults (flag INTEGER DEFAULT (1 = 1)) STRICT;",
      (db) => {
        db.exec("INSERT INTO defaults DEFAULT VALUES");
        expect(db.prepare("SELECT flag, typeof(flag) AS type FROM defaults").get()).toEqual({
          flag: 1,
          type: "integer",
        });
      },
    );
    const { files, report } = await reportOnly(directory);
    expect(report.catalogs.state!.objects.find((item) => item.kind === "default")).toMatchObject({
      sql: null,
      reason: expect.stringMatching(/type|bigint|boolean/i),
    });
    expect(files["state.postgres.sql"]).toContain('"flag" bigint');
    expect(files["state.postgres.sql"]).not.toMatch(/\bDEFAULT\b/);
  });

  it("preserves nested unary operators as executable expression tokens", async () => {
    const directory = fixture(
      "CREATE TABLE records (value INTEGER CHECK (value >= - -1)) STRICT;",
      (db) => {
        db.exec("INSERT INTO records VALUES (1)");
        expect(() => db.exec("INSERT INTO records VALUES (0)")).toThrow(/CHECK/);
      },
    );
    const { files, report } = await generatePostgresSchemas(directory);
    const expression = report.catalogs.state!.objects.find((item) => item.kind === "check")!.sql;
    expect(expression).not.toBeNull();
    expect(expression).not.toContain("--");
    expect(files["state.postgres.sql"]).toContain(`CHECK (${expression})`);
    withDatabase((db) => {
      const predicate = db.prepare(`SELECT ${expression} AS accepted FROM (SELECT ? AS value)`);
      expect(predicate.get(0)?.accepted).toBe(0);
      expect(predicate.get(1)?.accepted).toBe(1);
    });
  });
});
