import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  generatePostgresSchemas,
  generateWorkboardPostgresSchema,
  pendingPromotion,
} from "../../scripts/generate-postgres-schema.mts";
import { listOpenClawStateFeatureSchemas } from "../../src/state/openclaw-state-feature-schema.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(sql: string) {
  const directory = tempDirs.make("postgres-schema-");
  fs.mkdirSync(path.join(directory, "src/state"), { recursive: true });
  fs.writeFileSync(path.join(directory, "src/state/openclaw-state-schema.sql"), sql);
  fs.writeFileSync(path.join(directory, "src/state/openclaw-agent-schema.sql"), "");
  return directory;
}

function verifiedFixture(sql: string, verify: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys = ON; ${sql}`);
    verify(db);
  } finally {
    db.close();
  }
  return fixture(sql);
}

describe("PostgreSQL schema generation", () => {
  it("keeps the complete workboard artifact current and uses the admitted search path", async () => {
    const { sql, catalog } = await generateWorkboardPostgresSchema();
    expect(sql).toBe(
      fs.readFileSync(
        path.join(root, "extensions/workboard/src/workboard-schema.postgres.sql"),
        "utf8",
      ),
    );
    expect(catalog.objects.filter((item) => item.sql === null)).toEqual([]);
    expect(sql).toContain('CREATE TABLE "workboard_cards" (');
    expect(sql).toContain('"content" bytea NOT NULL');
    expect(sql).toContain("CHECK ((\"source\" IN ('state', 'model', 'operator')))");
    expect(sql).toContain(
      'REFERENCES "workboard_cards" ("id") ON UPDATE NO ACTION ON DELETE CASCADE',
    );
    expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT|CREATE SCHEMA)\b/);
    expect(sql).toMatch(/[^\n]\n$/);
  });

  it("renders eager and lazy state DDL inside the connection owner's namespace and transaction", async () => {
    const { files, report } = await generatePostgresSchemas(root);
    for (const file of [
      "state.runtime.postgres.sql",
      ...report.fragments.map((item) => item.runtimeFile),
    ]) {
      expect(files[file], file).not.toMatch(/^(?:BEGIN|COMMIT|SET|CREATE SCHEMA)\b/m);
      expect(files[file], file).not.toContain('"openclaw_state".');
    }
    expect(files["state.runtime.postgres.sql"]).toContain('CREATE TABLE "schema_meta" (');
    const backgrounds = report.fragments.find((item) =>
      item.tables.includes("user_background_images"),
    )!;
    expect(files[backgrounds.runtimeFile]).toContain('CREATE TABLE "user_background_images" (');
    expect(files[backgrounds.runtimeFile]).toContain('REFERENCES "user_profiles"');
    expect(files["state.runtime.postgres.sql"]).not.toContain(
      'CREATE TABLE "user_background_images"',
    );
  });

  it("accounts for every canonical SQLite object and generates identical bytes twice", async () => {
    const generated = await generatePostgresSchemas(root);
    expect((await generatePostgresSchemas(root)).files).toEqual(generated.files);
    expect(Object.keys(generated.files).toSorted()).toEqual(
      [
        "agent.postgres.sql",
        ...generated.report.fragments.flatMap((fragment) => [fragment.file, fragment.runtimeFile]),
        "manifest.json",
        "portability-report.md",
        "state.postgres.sql",
        "state.runtime.postgres.sql",
      ].toSorted(),
    );
    expect(
      generated.report.catalogs
        .state!.objects.filter((item) => item.sql === null && item.kind === "index")
        .map((item) => item.name)
        .toSorted(),
    ).toEqual(pendingPromotion.map((item) => item.name).toSorted());
    for (const fragment of generated.report.fragments) {
      expect(generated.files[fragment.file]).toContain(
        "SET LOCAL standard_conforming_strings = on;",
      );
      for (const table of fragment.tables) {
        expect(generated.files["state.postgres.sql"]).not.toContain(
          `CREATE TABLE "openclaw_state"."${table}"`,
        );
        expect(generated.files[fragment.file]).toContain(
          `CREATE TABLE "openclaw_state"."${table}"`,
        );
      }
    }
    const exported = await generatePostgresSchemas(root, "openclaw", { includeJsonReport: true });
    expect(JSON.parse(exported.files["portability-report.json"]!)).toEqual(generated.report);
    for (const name of ["state", "agent"]) {
      const db = new DatabaseSync(":memory:");
      try {
        db.exec(fs.readFileSync(path.join(root, `src/state/openclaw-${name}-schema.sql`), "utf8"));
        if (name === "state") {
          for (const fragment of listOpenClawStateFeatureSchemas()) {
            db.exec(fragment.sql());
          }
        }
        const expected: string[] = [];
        const add = (kind: string, table: unknown, item: unknown) =>
          expected.push(JSON.stringify([kind, table, item]));
        const rows = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema").all();
        const tableKinds = new Map(
          db
            .prepare("PRAGMA table_list")
            .all()
            .map((row) => [row.name, row.type]),
        );
        for (const row of rows) {
          if (row.type === "index") {
            continue;
          }
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
          for (const col of db
            .prepare("SELECT name FROM pragma_table_xinfo(?)")
            .all(String(row.name))) {
            add("column", row.name, col.name);
          }
          for (const index of db
            .prepare("SELECT name FROM pragma_index_list(?)")
            .all(String(row.name))) {
            add("index", row.name, index.name);
          }
          for (const fk of db
            .prepare("SELECT DISTINCT id FROM pragma_foreign_key_list(?)")
            .all(String(row.name))) {
            add("foreignKey", row.name, String(fk.id));
          }
          if (!excluded) {
            const checks = String(row.sql).match(/\bCHECK\s*\(/gi) ?? [];
            checks.forEach((_, index) => add("check", row.name, String(index)));
          }
        }
        const catalog = generated.report.catalogs[name]!;
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
            expect(generated.files["portability-report.md"]).toContain(
              `\`${item.table}.${item.name}\``,
            );
          } else {
            expect(
              Object.values(generated.files).join("\n"),
              `${item.kind} ${item.table}.${item.name}`,
            ).toContain(item.sql);
          }
        }
      } finally {
        db.close();
      }
    }
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
    expect(sql).toContain('CREATE SCHEMA "proof""scope_state";');
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
      'REFERENCES "proof""scope_state"."parent" ("id") ON UPDATE CASCADE ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED',
    );
    expect(sql.indexOf('CREATE TABLE "proof""scope_state"."parent"')).toBeLessThan(
      sql.indexOf("ADD FOREIGN KEY"),
    );
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
    const { files, report } = await generatePostgresSchemas(directory, "openclaw", {
      reportOnly: true,
    });
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
    const { files, report } = await generatePostgresSchemas(directory, "openclaw", {
      reportOnly: true,
    });
    const objects = report.catalogs.state!.objects;
    expect(objects.find((item) => item.kind === "table" && item.name === "mixed")).toMatchObject({
      sql: null,
      reason: expect.stringContaining("ANY"),
    });
    expect(
      objects.find((item) => item.kind === "foreignKey" && item.table === "dependent"),
    ).toMatchObject({
      sql: null,
      reason: expect.any(String),
    });
    expect(objects.find((item) => item.kind === "view")).toMatchObject({
      sql: null,
      reason: expect.any(String),
    });
    expect(files["state.postgres.sql"]).not.toContain('REFERENCES "openclaw_state"."mixed"');
    expect(report.catalogs.state!.tables.map((table) => table.name)).toEqual(["dependent"]);
  });

  it("creates standalone unique indexes before foreign keys that depend on them", async () => {
    const directory = verifiedFixture(
      `
      CREATE TABLE parent (id INTEGER);
      CREATE UNIQUE INDEX parent_id ON parent(id);
      CREATE TABLE child (parent_id INTEGER REFERENCES parent(id));
    `,
      (db) => {
        db.exec("INSERT INTO parent VALUES (1); INSERT INTO child VALUES (1);");
        expect(() => db.exec("INSERT INTO child VALUES (2)")).toThrow(/FOREIGN KEY/);
      },
    );
    const { files } = await generatePostgresSchemas(directory);
    const sql = files["state.postgres.sql"]!;
    expect(sql).toContain('CREATE UNIQUE INDEX "parent_id"');
    expect(sql).toContain('ADD FOREIGN KEY ("parent_id")');
    expect(sql.indexOf('CREATE UNIQUE INDEX "parent_id"')).toBeLessThan(
      sql.indexOf("ADD FOREIGN KEY"),
    );
  });

  it.each([
    {
      name: "an omitted parent unique constraint",
      parent: "TEXT COLLATE NOCASE UNIQUE",
      child: "TEXT",
    },
    { name: "incompatible mapped column types", parent: "TEXT PRIMARY KEY", child: "INTEGER" },
  ])("reports foreign keys with $name while retaining both tables", async ({ parent, child }) => {
    const directory = verifiedFixture(
      `CREATE TABLE parent (id ${parent}) STRICT;
       CREATE TABLE child (id ${child} REFERENCES parent(id)) STRICT;`,
      (db) => {
        db.exec("INSERT INTO parent VALUES ('1'); INSERT INTO child VALUES (1);");
        expect(db.prepare("SELECT COUNT(*) AS count FROM child").get()?.count).toBe(1);
        expect(() => db.exec("INSERT INTO child VALUES (2)")).toThrow(/FOREIGN KEY/);
      },
    );
    const { files, report } = await generatePostgresSchemas(directory, "openclaw", {
      reportOnly: true,
    });
    const catalog = report.catalogs.state!;
    const foreignKey = catalog.objects.find((item) => item.kind === "foreignKey");
    expect(foreignKey).toMatchObject({ sql: null });
    expect(foreignKey?.reason).toBeTruthy();
    expect(catalog.tables.map((table) => table.name).toSorted()).toEqual(["child", "parent"]);
    expect(files["state.postgres.sql"]).toContain('CREATE TABLE "openclaw_state"."parent"');
    expect(files["state.postgres.sql"]).toContain('CREATE TABLE "openclaw_state"."child"');
    expect(files["state.postgres.sql"]).not.toContain("ADD FOREIGN KEY");
  });

  it.each(["PRIMARY KEY", "UNIQUE", "NOT NULL"])(
    "reports the discarded %s conflict policy",
    async (constraint) => {
      const directory = verifiedFixture(
        `CREATE TABLE records (value TEXT ${constraint} ON CONFLICT IGNORE) STRICT;`,
        (db) => {
          const insert = db.prepare("INSERT INTO records VALUES (?)");
          expect(insert.run("first").changes).toBe(1);
          expect(insert.run(constraint === "NOT NULL" ? null : "first").changes).toBe(0);
          expect(db.prepare("SELECT COUNT(*) AS count FROM records").get()?.count).toBe(1);
        },
      );
      const { report } = await generatePostgresSchemas(directory, "openclaw", { reportOnly: true });
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
    const directory = verifiedFixture("CREATE TABLE nullable_key (id TEXT PRIMARY KEY);", (db) => {
      db.exec("INSERT INTO nullable_key VALUES (NULL), (NULL)");
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM nullable_key WHERE id IS NULL").get()?.count,
      ).toBe(2);
    });
    const { files, report } = await generatePostgresSchemas(directory, "openclaw", {
      reportOnly: true,
    });
    expect(report.catalogs.state!.objects.find((item) => item.kind === "table")).toMatchObject({
      sql: null,
      reason: expect.stringMatching(/nullable.*primary|primary.*nullable/i),
    });
    expect(files["state.postgres.sql"]).not.toContain(
      'CREATE TABLE "openclaw_state"."nullable_key"',
    );
  });

  it("reports a translated boolean default that is incompatible with its bigint column", async () => {
    const directory = verifiedFixture(
      "CREATE TABLE defaults (flag INTEGER DEFAULT (1 = 1)) STRICT;",
      (db) => {
        db.exec("INSERT INTO defaults DEFAULT VALUES");
        expect(db.prepare("SELECT flag, typeof(flag) AS type FROM defaults").get()).toEqual({
          flag: 1,
          type: "integer",
        });
      },
    );
    const { files, report } = await generatePostgresSchemas(directory, "openclaw", {
      reportOnly: true,
    });
    expect(report.catalogs.state!.objects.find((item) => item.kind === "default")).toMatchObject({
      sql: null,
      reason: expect.stringMatching(/type|bigint|boolean/i),
    });
    expect(files["state.postgres.sql"]).toContain('"flag" bigint');
    expect(files["state.postgres.sql"]).not.toMatch(/\bDEFAULT\b/);
  });

  it("preserves nested unary operators as executable expression tokens", async () => {
    const directory = verifiedFixture(
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
    const db = new DatabaseSync(":memory:");
    try {
      const predicate = db.prepare(`SELECT ${expression} AS accepted FROM (SELECT ? AS value)`);
      expect(predicate.get(0)?.accepted).toBe(0);
      expect(predicate.get(1)?.accepted).toBe(1);
    } finally {
      db.close();
    }
  });
});
