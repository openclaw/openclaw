import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import { readSqliteDatabaseIntegrityVerification } from "./sqlite-database-admission.js";
import {
  assertSqliteIntegrity,
  assertSqliteTableIntegrity,
  isTerminalSqliteIntegrityError,
  runSqliteIntegrityOperationSync,
  SqliteIntegrityError,
  sqliteIntegrityCheckSteps,
  type SqliteIntegrityDiagnostics,
  type SqliteIntegrityOperation,
} from "./sqlite-integrity.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function withMaintenanceCheck(
  check: "quick" | "full" | undefined,
  run: () => void | Promise<void>,
) {
  const scope = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    sqliteIntegrityCheck: check,
    assertOwnerCurrent() {},
  });
  try {
    await scope.run(run);
  } finally {
    await scope.close();
  }
}

function tableFixture(sql = "CREATE TABLE items(value INTEGER)", withSibling = false) {
  const filename = path.join(tempDirs.make("sqlite-table-integrity-"), "database.sqlite");
  const database = openNodeSqliteDatabase(filename);
  database.exec(sql);
  const sibling = withSibling ? openNodeSqliteDatabase(filename) : undefined;
  const observer = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
  return {
    database,
    sibling,
    count: (statement: string) => observer.queries.filter((query) => query === statement).length,
    [Symbol.dispose]() {
      observer.restore();
      sibling?.close();
      database.close();
    },
  };
}

describe("maintenance table integrity", () => {
  it("shares passing table checks across handles until a write, and retains QUICK and FK", async () => {
    using fixture = tableFixture("CREATE TABLE items(value INTEGER CHECK(value > 0))", true);
    const { database, count } = fixture;
    const sibling = fixture.sibling!;
    await withMaintenanceCheck("quick", () => {
      for (const handle of [database, sibling]) {
        assertSqliteIntegrity(handle, "items", { check: "quick", tables: ["items"] });
      }
      expect(count("PRAGMA integrity_check('items');")).toBe(1);
      expect(count("PRAGMA quick_check;")).toBe(2);
      expect(count("PRAGMA foreign_key_check;")).toBe(2);
      database.exec("PRAGMA ignore_check_constraints = ON; INSERT INTO items VALUES (-1)");
      expect(() => assertSqliteTableIntegrity(sibling, "items", "items")).toThrow(
        /CHECK constraint/u,
      );
      expect(count("PRAGMA integrity_check('items');")).toBe(2);
      database.exec("DELETE FROM items");
      assertSqliteTableIntegrity(sibling, "items", "items");
      expect(count("PRAGMA integrity_check('items');")).toBe(3);
    });
    await withMaintenanceCheck("quick", () =>
      assertSqliteTableIntegrity(database, "items", "items"),
    );
    expect(count("PRAGMA integrity_check('items');")).toBe(4);
  });

  it("rechecks transaction-local writes, DDL, and rollback", async () => {
    using fixture = tableFixture();
    const { database, count } = fixture;
    const check = () => assertSqliteTableIntegrity(database, "items", "items");
    await withMaintenanceCheck("quick", () => {
      const mutations = [
        "BEGIN",
        "INSERT INTO items VALUES (1)",
        "CREATE INDEX idx_items ON items(value)",
        "ROLLBACK",
      ];
      for (const [index, mutation] of mutations.entries()) {
        database.exec(mutation);
        check();
        check();
        expect(count("PRAGMA integrity_check('items');"), mutation).toBe(index + 1);
      }
      expect(database.prepare("SELECT * FROM items").all()).toEqual([]);
    });
  });

  it("retains every explicit FULL check", async () => {
    using fixture = tableFixture();
    const { database, count } = fixture;
    await withMaintenanceCheck("full", () => {
      for (let i = 0; i < 2; i += 1) {
        assertSqliteIntegrity(database, "items", { check: "full", tables: ["items"] });
        assertSqliteTableIntegrity(database, "items", "items");
      }
    });
    expect(count("PRAGMA integrity_check;")).toBe(2);
    expect(count("PRAGMA integrity_check('items');")).toBe(2);
    expect(count("PRAGMA foreign_key_check;")).toBe(2);
  });
});

function memoryDatabase(sql: string) {
  const database = new (requireNodeSqlite().DatabaseSync)(":memory:");
  try {
    database.exec(sql);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function taskOrphans(parent = "task_id", child = "task_id", action = "CASCADE", extra = "") {
  return `
    PRAGMA foreign_keys = OFF;
    CREATE TABLE task_runs (task_id TEXT PRIMARY KEY, other_id TEXT UNIQUE);
    CREATE TABLE task_delivery_state (
      ${child} TEXT PRIMARY KEY REFERENCES task_runs(${parent}) ON DELETE ${action}
    );
    INSERT INTO task_delivery_state (${child})
    VALUES ('missing-1'), ('missing-2'), ('missing-3'), ('missing-4'), ('missing-5'), ('missing-6');
    ${extra}
  `;
}

describe("assertSqliteIntegrity", () => {
  it("retains every finding for offline repair without repeating the check", () => {
    using database = memoryDatabase(
      `CREATE TABLE damaged (value INTEGER CHECK(value > 0));
       PRAGMA ignore_check_constraints = ON;
       WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM rows WHERE n < 105)
       INSERT INTO damaged SELECT -n FROM rows;
       PRAGMA ignore_check_constraints = OFF;`,
    );
    const observer = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    try {
      const failure = caught(() =>
        assertSqliteIntegrity(database, "offline repair", { allFindings: true }),
      );
      expect(failure).toBeInstanceOf(SqliteIntegrityError);
      expect(failure).toHaveProperty("findings.length", 105);
      expect(observer.queries).toEqual(["PRAGMA integrity_check(2147483647);"]);
    } finally {
      observer.restore();
    }
  });

  it.each([
    { check: "quick", tables: ["touched"], refuses: false },
    { check: "quick", tables: ["untouched"], refuses: true },
    { check: "full", tables: ["touched"], refuses: true },
  ] as const)(
    "checks index consistency with $check verification scoped to $tables",
    ({ check, tables, refuses }) => {
      using database = new (requireNodeSqlite().DatabaseSync)(":memory:");
      database.exec(`
        CREATE TABLE touched(value TEXT);
        CREATE TABLE untouched(id INTEGER PRIMARY KEY, value TEXT);
        CREATE INDEX idx_untouched ON untouched(id);
        INSERT INTO untouched VALUES (1, 'retained'), (2, 'history');
      `);
      database.enableDefensive?.(false);
      database.exec("PRAGMA writable_schema = ON");
      database
        .prepare("UPDATE sqlite_schema SET sql = ? WHERE name = 'idx_untouched'")
        .run("CREATE INDEX idx_untouched ON untouched(value)");
      database.exec("PRAGMA writable_schema = OFF");
      const version = Number(database.prepare("PRAGMA schema_version").get()?.schema_version);
      database.exec(`PRAGMA schema_version = ${version + 1}`);

      const verify = () => assertSqliteIntegrity(database, "migration source", { check, tables });
      if (refuses) {
        expect(verify).toThrow(/integrity_check.*idx_untouched/su);
      } else {
        expect(verify).not.toThrow();
      }
    },
  );

  it("classifies cascade-owned task delivery orphans without admitting writes", () => {
    using database = memoryDatabase(taskOrphans());
    const failure = caught(() => assertSqliteIntegrity(database, "test database"));
    expect(failure).toMatchObject({
      name: "SqliteRepairableForeignKeyError",
      repair: {
        kind: "task-delivery-orphans",
        relation: "task_delivery_state.task_id",
        parentTable: "task_runs",
        orphanCount: 6,
      },
      message: expect.stringMatching(/foreign_key_check failed.*openclaw doctor --fix/u),
    });
    if (!(failure instanceof Error)) {
      throw new Error("Expected integrity admission to refuse unrepaired rows");
    }
    expect(isTerminalSqliteIntegrityError(failure)).toBe(false);
    expect(database.prepare("SELECT count(*) AS count FROM task_delivery_state").get()).toEqual({
      count: 6,
    });
  });

  it.each<{
    label: string;
    parent?: string;
    child?: string;
    action?: string;
    extra?: string;
  }>([
    { label: "non-cascade deletion", action: "NO ACTION" },
    { label: "different parent column", parent: "other_id" },
    { label: "different child column", child: "other_id" },
    {
      label: "unrelated violation beyond the diagnostic sample",
      extra: `CREATE TABLE unrelated (id TEXT REFERENCES task_runs(task_id));
              INSERT INTO unrelated (id) VALUES ('missing');`,
    },
    {
      label: "structural damage alongside otherwise repairable orphans",
      extra: `CREATE TABLE damaged (id INTEGER CHECK (id > 0));
              PRAGMA ignore_check_constraints = ON;
              INSERT INTO damaged (id) VALUES (-1);
              PRAGMA ignore_check_constraints = OFF;`,
    },
  ])("refuses task delivery violations with $label", ({ parent, child, action, extra }) => {
    using database = memoryDatabase(taskOrphans(parent, child, action, extra));
    expect(() => assertSqliteIntegrity(database, "test database")).toThrow(
      expect.objectContaining({ name: "SqliteIntegrityError" }),
    );
  });

  it("does not classify a component of a composite foreign key as repairable", () => {
    using database = memoryDatabase(
      `
        PRAGMA foreign_keys = OFF;
        CREATE TABLE task_runs (task_id TEXT, revision INTEGER, PRIMARY KEY (task_id, revision));
        CREATE TABLE task_delivery_state (
          task_id TEXT PRIMARY KEY,
          revision INTEGER,
          FOREIGN KEY (task_id, revision) REFERENCES task_runs(task_id, revision) ON DELETE CASCADE
        );
        INSERT INTO task_delivery_state (task_id, revision) VALUES ('missing', 1);
      `,
    );
    expect(() => assertSqliteIntegrity(database, "test database")).toThrow(
      expect.objectContaining({ name: "SqliteIntegrityError" }),
    );
  });

  it.each([
    [
      "64-bit rowids in deterministic order",
      "(9007199254740993, 99), (1, 99)",
      /children row 1 references parents \(foreign key 0\); children row 9007199254740993 references parents \(foreign key 0\)/u,
    ],
    [
      "a shadowing schema object",
      "(1, 99)",
      /foreign_key_check failed for test database: children row 1 references parents \(foreign key 0\)/u,
    ],
    [
      "WITHOUT ROWID tables",
      "('child-1', 'missing-parent')",
      /foreign_key_check failed for test database: children row without rowid references parents \(foreign key 0\)/u,
    ],
  ] as const)("reports foreign key violations with %s", (variant, rows, expected) => {
    const withoutRowid = variant === "WITHOUT ROWID tables";
    const type = withoutRowid ? "TEXT" : "INTEGER";
    using database = memoryDatabase(
      `PRAGMA foreign_keys = OFF;
       CREATE TABLE parents (id ${type} PRIMARY KEY);
       CREATE TABLE children (id ${type} PRIMARY KEY, parent_id ${type} NOT NULL REFERENCES parents(id))
         ${withoutRowid ? "WITHOUT ROWID" : ""};
       INSERT INTO children (id, parent_id) VALUES ${rows};`,
    );
    if (variant === "a shadowing schema object") {
      database.exec(
        'CREATE TABLE pragma_foreign_key_check ("table" TEXT NOT NULL, rowid INTEGER, parent TEXT NOT NULL, fkid INTEGER NOT NULL)',
      );
      expect(database.prepare("SELECT * FROM pragma_foreign_key_check").all()).toEqual([]);
    }
    expect(() => assertSqliteIntegrity(database, "test database")).toThrow(expected);
  });
});

const syncDiagnostics = {
  integrityGateMode: "full",
  integrityGateMs: 4,
  integrityGateOutcome: "healthy",
  integrityCheckSyncMs: 4,
  integrityOutsideCheckMs: 0,
};

describe("integrity gate attribution", () => {
  afterEach(() => vi.restoreAllMocks());

  function createTimedDatabase(checkMs: number, foreignKeyViolation = false) {
    const database = new (requireNodeSqlite().DatabaseSync)(":memory:");
    database.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE parents (id INTEGER PRIMARY KEY);
      CREATE TABLE children (parent_id INTEGER REFERENCES parents(id));
      INSERT INTO parents VALUES (1);
      INSERT INTO children VALUES (${foreignKeyViolation ? 2 : 1});
    `);
    let elapsedMs = 0;
    const advance = (durationMs: number) => {
      elapsedMs += durationMs;
    };
    vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
    const prepare = database.prepare.bind(database);
    vi.spyOn(database, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql === "PRAGMA integrity_check;") {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...parameters) => {
          try {
            return all(...parameters);
          } finally {
            advance(checkMs);
          }
        });
      }
      return statement;
    });
    const diagnostics: SqliteIntegrityDiagnostics = {};
    const steps = () => sqliteIntegrityCheckSteps(database, "timed database", diagnostics);
    return {
      database,
      advance,
      diagnostics,
      steps,
      sync() {
        runSqliteIntegrityOperationSync(steps());
        expect(diagnostics).toEqual(syncDiagnostics);
      },
      [Symbol.dispose]: () => database.close(),
    };
  }

  it.each([
    { label: "measured zero", checkMs: 0.25, foreignKeyViolation: false, gateMs: 4, syncMs: 0 },
    { label: "failed check", checkMs: 4.75, foreignKeyViolation: true, gateMs: 9, syncMs: 4 },
  ])(
    "splits a $label without changing the gate outcome or error",
    ({ checkMs, foreignKeyViolation, gateMs, syncMs }) => {
      using fixture = createTimedDatabase(checkMs, foreignKeyViolation);
      const { advance, diagnostics, steps } = fixture;
      let suppliedError: unknown;
      function* operation(): SqliteIntegrityOperation<void> {
        const gate = steps();
        const step = gate.next();
        if (step.done) {
          throw new Error("Integrity check did not yield");
        }
        advance(1.75);
        try {
          yield step.value;
        } catch (error) {
          suppliedError = error;
          advance(2.75);
          gate.throw(error);
          return;
        }
        advance(2.75);
        gate.next();
      }

      const failure = caught(() => runSqliteIntegrityOperationSync(operation()));
      if (foreignKeyViolation) {
        expect(failure).toMatchObject({
          name: "SqliteIntegrityError",
          message: expect.stringContaining("foreign_key_check failed for timed database"),
        });
        expect(failure).toBe(suppliedError);
      } else {
        expect(failure).toBeUndefined();
      }
      expect(diagnostics).toEqual({
        integrityGateMode: "full",
        integrityGateMs: gateMs,
        integrityGateOutcome: foreignKeyViolation ? "failed" : "healthy",
        integrityCheckSyncMs: syncMs,
        integrityOutsideCheckMs: gateMs - syncMs,
      });
    },
  );

  it.each([
    { label: "fractional", checkMs: 4.75, lifetimeMs: 8.75, outcome: "healthy" },
    { label: "failed check", checkMs: 4.75, lifetimeMs: 8.75, outcome: "failed" },
    { label: "failed before checking", checkMs: undefined, lifetimeMs: 8.75, outcome: "failed" },
  ] as const)(
    "attributes $label worker time without leaking measurements into later gates",
    ({ checkMs, lifetimeMs, outcome }) => {
      using fixture = createTimedDatabase(4.75);
      const { advance, diagnostics, steps } = fixture;
      const failure = new Error("external integrity driver failed");
      const finish = (operation: SqliteIntegrityOperation<void>) => {
        if (outcome === "failed") {
          expect(caught(() => operation.throw(failure))).toBe(failure);
        } else {
          expect(operation.next().done).toBe(true);
        }
      };
      for (const nextDriver of ["sync", "unmeasured"] as const) {
        fixture.sync();

        const worker = steps();
        const step = worker.next();
        if (step.done || !step.value.timing) {
          throw new Error("Integrity check did not yield a timing owner");
        }
        step.value.timing.workerLifetimeElapsedMs = lifetimeMs;
        if (checkMs !== undefined) {
          step.value.timing.workerCheckElapsedMs = checkMs;
        }
        advance(lifetimeMs + 4.5);
        finish(worker);
        expect(diagnostics).toEqual({
          integrityGateMode: "full",
          integrityGateMs: Math.floor(lifetimeMs + 4.5),
          integrityGateOutcome: outcome,
          ...(checkMs === undefined ? {} : { integrityWorkerCheckMs: Math.floor(checkMs) }),
          integrityWorkerLifetimeMs: Math.floor(lifetimeMs),
          integrityOutsideWorkerMs: Math.floor(lifetimeMs + 4.5) - Math.floor(lifetimeMs),
        });

        if (nextDriver === "sync") {
          fixture.sync();
          continue;
        }
        const manual = steps();
        expect(manual.next().done).toBe(false);
        advance(12.5);
        finish(manual);
        expect(diagnostics).toEqual({
          integrityGateMode: "full",
          integrityGateMs: 12,
          integrityGateOutcome: outcome,
        });
      }
    },
  );
});

describe("isTerminalSqliteIntegrityError", () => {
  it("distinguishes persistent damage from transient pragma failures", () => {
    for (const [message, errcode, terminal] of [
      ["integrity check found damage", undefined, true],
      ["database is locked", 5, false],
      ["database disk image is malformed", 11, true],
      ["database index is malformed", 779, true],
    ] as const) {
      const cause =
        errcode === undefined ? undefined : Object.assign(new Error(message), { errcode });
      const failure = Object.assign(new Error(message, { cause }), {
        name: "SqliteIntegrityError",
      });
      expect(isTerminalSqliteIntegrityError(failure)).toBe(terminal);
    }
  });
});

describe("captured maintenance integrity", () => {
  afterEach(() => vi.restoreAllMocks());
  type Capture = (check?: "quick" | "full") => Promise<unknown>;
  async function withCapture(run: (sourcePath: string, capture: Capture) => Promise<void>) {
    const directory = fs.realpathSync(tempDirs.make("sqlite-maintenance-integrity-"));
    const sourcePath = path.join(directory, "source.sqlite");
    {
      using source = openNodeSqliteDatabase(sourcePath);
      source.exec("PRAGMA journal_mode = WAL");
      for (const table of ["touched", "untouched"]) {
        source.exec(
          `CREATE TABLE ${table}(value INTEGER CHECK(value > 0)); INSERT INTO ${table} VALUES(1);`,
        );
      }
    }
    // Doctor's header preflight leaves an empty WAL behind after a read-only open.
    {
      using source = openNodeSqliteDatabase(sourcePath, { readOnly: true });
      source.prepare("PRAGMA user_version").get();
    }
    await withMaintenanceCheck(undefined, () =>
      run(sourcePath, (check = "quick") =>
        createVerifiedSqliteSnapshot({
          sourcePath,
          targetPath: path.join(directory, "backup.sqlite"),
          preserveRowIds: true,
          integrity: { check, tables: ["touched"] },
          transform() {},
        }),
      ),
    );
  }

  function checkSteps(
    source: ReturnType<typeof openNodeSqliteDatabase>,
    sourcePath: string,
    check: "quick" | "full" = "quick",
  ) {
    return sqliteIntegrityCheckSteps(source, sourcePath, undefined, { check, tables: ["touched"] });
  }

  it.each(["quick", "full"] as const)(
    "reuses only the captured QUICK source proof before migration (%s)",
    async (check) => {
      await withCapture(async (sourcePath, capture) => {
        await capture(check);
        using source = openNodeSqliteDatabase(sourcePath);
        const prepare = vi.spyOn(source, "prepare");
        runSqliteIntegrityOperationSync(checkSteps(source, sourcePath, check));
        const checks = prepare.mock.calls.filter(([sql]) =>
          /^PRAGMA (quick|integrity)_check;/.test(sql),
        );
        expect(checks).toHaveLength(check === "quick" ? 0 : 1);
        expect(readSqliteDatabaseIntegrityVerification(source) !== undefined).toBe(
          check === "full",
        );
      });
    },
  );

  it("refuses untouched-table corruption before publishing a migration backup", async () => {
    await withCapture(async (sourcePath, capture) => {
      let offset: number;
      {
        using source = openNodeSqliteDatabase(sourcePath);
        const root = source
          .prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'untouched'")
          .get();
        const page = source.prepare("PRAGMA page_size").get();
        offset = (Number(root?.rootpage) - 1) * Number(page?.page_size);
      }
      const bytes = fs.readFileSync(sourcePath);
      bytes[offset] = 0xff;
      fs.writeFileSync(sourcePath, bytes);
      {
        using source = openNodeSqliteDatabase(sourcePath);
        expect(() =>
          assertSqliteIntegrity(source, "migration source", {
            check: "quick",
            tables: ["touched"],
          }),
        ).toThrow(expect.objectContaining({ name: "SqliteIntegrityError" }));
      }
      await expect(capture()).rejects.toThrow(/malformed|quick_check/);
    });
  });

  it.each([false, true])(
    "invalidates captured proof after an unscoped write (uncommitted=%s)",
    async (uncommitted) => {
      await withCapture(async (sourcePath, capture) => {
        await capture();
        using source = openNodeSqliteDatabase(sourcePath);
        source.exec(
          `PRAGMA ignore_check_constraints = ON; ${uncommitted ? "BEGIN;" : ""} INSERT INTO untouched VALUES(-1); PRAGMA ignore_check_constraints = OFF;`,
        );
        try {
          expect(() => runSqliteIntegrityOperationSync(checkSteps(source, sourcePath))).toThrow(
            /quick_check.*CHECK constraint failed in untouched/s,
          );
        } finally {
          if (source.isTransaction) {
            source.exec("ROLLBACK");
          }
        }
      });
    },
  );

  it("keeps the post-migration scoped FULL check after reusing source proof", async () => {
    await withCapture(async (sourcePath, capture) => {
      await capture();
      using source = openNodeSqliteDatabase(sourcePath);
      expect(checkSteps(source, sourcePath).next().done).toBe(true);
      source.exec(
        "PRAGMA ignore_check_constraints = ON; INSERT INTO touched VALUES(-1); PRAGMA ignore_check_constraints = OFF;",
      );
      expect(() => assertSqliteTableIntegrity(source, sourcePath, "touched")).toThrow(
        /integrity_check.*CHECK constraint failed in touched/s,
      );
    });
  });
});
