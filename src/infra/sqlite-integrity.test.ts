import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "./node-sqlite.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  assertSqliteIntegrity,
  confirmSqliteFileIntegrity,
  isTerminalSqliteIntegrityError,
  runSqliteIntegrityOperationSync,
  sqliteIntegrityCheckSteps,
  type SqliteIntegrityDiagnostics,
  type SqliteIntegrityOperation,
} from "./sqlite-integrity.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("assertSqliteIntegrity", () => {
  it("accepts structurally and referentially consistent databases", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parents(id)
        );
        INSERT INTO parents (id) VALUES (1);
        INSERT INTO children (id, parent_id) VALUES (1, 1);
      `);

      expect(assertSqliteIntegrity(database, "test database")).toEqual({
        integrityCheck: "ok",
      });
    } finally {
      database.close();
    }
  });

  it("rejects foreign-key violations that structural checks do not detect", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parents(id)
        );
        INSERT INTO children (id, parent_id) VALUES (1, 99);
      `);
      expect(database.prepare("PRAGMA quick_check;").get()).toEqual({ quick_check: "ok" });
      expect(database.prepare("PRAGMA integrity_check;").get()).toEqual({
        integrity_check: "ok",
      });

      let failure: unknown;
      try {
        assertSqliteIntegrity(database, "test database");
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ name: "SqliteIntegrityError" });
      expect(String(failure)).toMatch(
        /foreign_key_check failed for test database: children row 1 references parents \(foreign key 0\)/u,
      );
    } finally {
      database.close();
    }
  });

  it("names integrity-check failures", () => {
    const database = {
      prepare: () => ({ all: () => [{ integrity_check: "broken index" }] }),
    } as unknown as DatabaseSync;

    let failure: unknown;
    try {
      assertSqliteIntegrity(database, "test database");
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: "SqliteIntegrityError",
      message: expect.stringContaining(
        "SQLite integrity_check failed for test database: broken index",
      ),
    });
  });

  it("classifies cascade-owned task delivery orphans without admitting writes", () => {
    const database = new (requireNodeSqlite().DatabaseSync)(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE task_runs (task_id TEXT PRIMARY KEY);
        CREATE TABLE task_delivery_state (
          task_id TEXT PRIMARY KEY REFERENCES task_runs(task_id) ON DELETE CASCADE
        );
        INSERT INTO task_delivery_state (task_id)
        VALUES ('missing-1'), ('missing-2'), ('missing-3'), ('missing-4'),
               ('missing-5'), ('missing-6');
      `);

      let failure: unknown;
      try {
        assertSqliteIntegrity(database, "test database");
      } catch (error) {
        failure = error;
      }
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
    } finally {
      database.close();
    }
  });

  it.each([
    {
      label: "non-cascade deletion",
      parent: "task_id",
      child: "task_id",
      action: "NO ACTION",
      extra: "",
    },
    {
      label: "different parent column",
      parent: "other_id",
      child: "task_id",
      action: "CASCADE",
      extra: "",
    },
    {
      label: "different child column",
      parent: "task_id",
      child: "other_id",
      action: "CASCADE",
      extra: "",
    },
    {
      label: "unrelated violation beyond the diagnostic sample",
      parent: "task_id",
      child: "task_id",
      action: "CASCADE",
      extra: `CREATE TABLE unrelated (id TEXT REFERENCES task_runs(task_id));
              INSERT INTO unrelated (id) VALUES ('missing');`,
    },
    {
      label: "structural damage alongside otherwise repairable orphans",
      parent: "task_id",
      child: "task_id",
      action: "CASCADE",
      extra: `CREATE TABLE damaged (id INTEGER CHECK (id > 0));
              PRAGMA ignore_check_constraints = ON;
              INSERT INTO damaged (id) VALUES (-1);
              PRAGMA ignore_check_constraints = OFF;`,
    },
  ])("refuses task delivery violations with $label", ({ parent, child, action, extra }) => {
    const database = new (requireNodeSqlite().DatabaseSync)(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE task_runs (task_id TEXT PRIMARY KEY, other_id TEXT UNIQUE);
        CREATE TABLE task_delivery_state (
          ${child} TEXT PRIMARY KEY REFERENCES task_runs(${parent}) ON DELETE ${action}
        );
        INSERT INTO task_delivery_state (${child})
        VALUES ('missing-1'), ('missing-2'), ('missing-3'), ('missing-4'),
               ('missing-5'), ('missing-6');
        ${extra}
      `);

      expect(() => assertSqliteIntegrity(database, "test database")).toThrow(
        expect.objectContaining({ name: "SqliteIntegrityError" }),
      );
    } finally {
      database.close();
    }
  });

  it("does not classify a component of a composite foreign key as repairable", () => {
    const database = new (requireNodeSqlite().DatabaseSync)(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE task_runs (task_id TEXT, revision INTEGER, PRIMARY KEY (task_id, revision));
        CREATE TABLE task_delivery_state (
          task_id TEXT PRIMARY KEY,
          revision INTEGER,
          FOREIGN KEY (task_id, revision) REFERENCES task_runs(task_id, revision) ON DELETE CASCADE
        );
        INSERT INTO task_delivery_state (task_id, revision) VALUES ('missing', 1);
      `);

      expect(() => assertSqliteIntegrity(database, "test database")).toThrow(
        expect.objectContaining({ name: "SqliteIntegrityError" }),
      );
    } finally {
      database.close();
    }
  });

  it("reports violations deterministically without truncating 64-bit rowids", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parents(id)
        );
        INSERT INTO children (id, parent_id)
        VALUES (9007199254740993, 99), (1, 99);
      `);

      expect(() => assertSqliteIntegrity(database, "test database")).toThrow(
        /children row 1 references parents \(foreign key 0\); children row 9007199254740993 references parents \(foreign key 0\)/u,
      );
    } finally {
      database.close();
    }
  });

  it("bounds foreign-key violation diagnostics", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parents(id)
        );
        INSERT INTO children (id, parent_id)
        VALUES (1, 99), (2, 99), (3, 99), (4, 99), (5, 99), (6, 99);
      `);

      expect(() => assertSqliteIntegrity(database, "test database")).toThrow(
        /children row 5 references parents \(foreign key 0\); additional violations omitted$/u,
      );
    } finally {
      database.close();
    }
  });

  it("cannot be bypassed by a schema object shadowing the table-valued pragma", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parents(id)
        );
        INSERT INTO children (id, parent_id) VALUES (1, 99);
        CREATE TABLE pragma_foreign_key_check (
          "table" TEXT NOT NULL,
          rowid INTEGER,
          parent TEXT NOT NULL,
          fkid INTEGER NOT NULL
        );
      `);
      expect(
        database.prepare('SELECT "table", rowid, parent, fkid FROM pragma_foreign_key_check').all(),
      ).toEqual([]);

      expect(() => assertSqliteIntegrity(database, "test database")).toThrow(
        /foreign_key_check failed for test database: children row 1 references parents \(foreign key 0\)/u,
      );
    } finally {
      database.close();
    }
  });

  it("identifies violations in WITHOUT ROWID tables", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parents (id TEXT PRIMARY KEY);
        CREATE TABLE children (
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL REFERENCES parents(id)
        ) WITHOUT ROWID;
        INSERT INTO children (id, parent_id) VALUES ('child-1', 'missing-parent');
      `);

      expect(() => assertSqliteIntegrity(database, "test database")).toThrow(
        /foreign_key_check failed for test database: children row without rowid references parents \(foreign key 0\)/u,
      );
    } finally {
      database.close();
    }
  });
});

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
    return { database, advance };
  }

  it.each([
    { label: "fractional check", checkMs: 4.75, foreignKeyViolation: false, gateMs: 9, syncMs: 4 },
    { label: "measured zero", checkMs: 0.25, foreignKeyViolation: false, gateMs: 4, syncMs: 0 },
    { label: "failed check", checkMs: 4.75, foreignKeyViolation: true, gateMs: 9, syncMs: 4 },
  ])(
    "splits a $label without changing the gate outcome or error",
    ({ checkMs, foreignKeyViolation, gateMs, syncMs }) => {
      const { database, advance } = createTimedDatabase(checkMs, foreignKeyViolation);
      const diagnostics: SqliteIntegrityDiagnostics = {};
      let suppliedError: unknown;
      function* operation(): SqliteIntegrityOperation<void> {
        const gate = sqliteIntegrityCheckSteps(database, "timed database", diagnostics);
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

      try {
        let failure: unknown;
        try {
          runSqliteIntegrityOperationSync(operation());
        } catch (error) {
          failure = error;
        }
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
          integrityGateMs: gateMs,
          integrityGateOutcome: foreignKeyViolation ? "failed" : "healthy",
          integrityCheckSyncMs: syncMs,
          integrityOutsideCheckMs: gateMs - syncMs,
        });
      } finally {
        database.close();
      }
    },
  );

  it.each([
    { label: "fractional", checkMs: 4.75, lifetimeMs: 8.75, outcome: "healthy" },
    { label: "zero", checkMs: 0, lifetimeMs: 0, outcome: "healthy" },
    { label: "failed check", checkMs: 4.75, lifetimeMs: 8.75, outcome: "failed" },
    { label: "failed before checking", checkMs: undefined, lifetimeMs: 8.75, outcome: "failed" },
  ] as const)(
    "attributes $label worker time without leaking measurements into later gates",
    ({ checkMs, lifetimeMs, outcome }) => {
      const { database, advance } = createTimedDatabase(4.75);
      const diagnostics: SqliteIntegrityDiagnostics = {};
      const failure = new Error("external integrity driver failed");
      try {
        for (const nextDriver of ["sync", "unmeasured"] as const) {
          runSqliteIntegrityOperationSync(
            sqliteIntegrityCheckSteps(database, "timed database", diagnostics),
          );
          expect(diagnostics).toEqual({
            integrityGateMs: 4,
            integrityGateOutcome: "healthy",
            integrityCheckSyncMs: 4,
            integrityOutsideCheckMs: 0,
          });

          const worker = sqliteIntegrityCheckSteps(database, "timed database", diagnostics);
          const step = worker.next();
          if (step.done || !step.value.timing) {
            throw new Error("Integrity check did not yield a timing owner");
          }
          step.value.timing.workerLifetimeElapsedMs = lifetimeMs;
          if (checkMs !== undefined) {
            step.value.timing.workerCheckElapsedMs = checkMs;
          }
          advance(lifetimeMs + 4.5);
          if (outcome === "failed") {
            let thrown: unknown;
            try {
              worker.throw(failure);
            } catch (error) {
              thrown = error;
            }
            expect(thrown).toBe(failure);
          } else {
            expect(worker.next().done).toBe(true);
          }
          expect(diagnostics).toEqual({
            integrityGateMs: Math.floor(lifetimeMs + 4.5),
            integrityGateOutcome: outcome,
            ...(checkMs === undefined ? {} : { integrityWorkerCheckMs: Math.floor(checkMs) }),
            integrityWorkerLifetimeMs: Math.floor(lifetimeMs),
            integrityOutsideWorkerMs: Math.floor(lifetimeMs + 4.5) - Math.floor(lifetimeMs),
          });

          if (nextDriver === "sync") {
            runSqliteIntegrityOperationSync(
              sqliteIntegrityCheckSteps(database, "timed database", diagnostics),
            );
            expect(diagnostics).toEqual({
              integrityGateMs: 4,
              integrityGateOutcome: "healthy",
              integrityCheckSyncMs: 4,
              integrityOutsideCheckMs: 0,
            });
            continue;
          }
          const manual = sqliteIntegrityCheckSteps(database, "timed database", diagnostics);
          expect(manual.next().done).toBe(false);
          advance(12.5);
          if (outcome === "failed") {
            let thrown: unknown;
            try {
              manual.throw(failure);
            } catch (error) {
              thrown = error;
            }
            expect(thrown).toBe(failure);
          } else {
            expect(manual.next().done).toBe(true);
          }
          expect(diagnostics).toEqual({
            integrityGateMs: 12,
            integrityGateOutcome: outcome,
          });
          expect(diagnostics).not.toHaveProperty("integrityCheckSyncMs");
          expect(diagnostics).not.toHaveProperty("integrityOutsideCheckMs");
        }
      } finally {
        database.close();
      }
    },
  );
});

describe("isTerminalSqliteIntegrityError", () => {
  it("distinguishes persistent damage from transient pragma failures", () => {
    const corrupt = new Error("integrity check found damage");
    corrupt.name = "SqliteIntegrityError";
    const busy = new Error("integrity check could not run", {
      cause: Object.assign(new Error("database is locked"), { errcode: 5 }),
    });
    busy.name = "SqliteIntegrityError";
    const malformed = new Error("integrity check could not read the database", {
      cause: Object.assign(new Error("database disk image is malformed"), { errcode: 11 }),
    });
    malformed.name = "SqliteIntegrityError";
    const corruptIndex = new Error("integrity check found a corrupt index", {
      cause: Object.assign(new Error("database index is malformed"), { errcode: 779 }),
    });
    corruptIndex.name = "SqliteIntegrityError";

    expect(isTerminalSqliteIntegrityError(corrupt)).toBe(true);
    expect(isTerminalSqliteIntegrityError(busy)).toBe(false);
    expect(isTerminalSqliteIntegrityError(malformed)).toBe(true);
    expect(isTerminalSqliteIntegrityError(corruptIndex)).toBe(true);
  });
});

describe("confirmSqliteFileIntegrity", () => {
  it("leaves SQLite open failures unbound because the failed file identity is unknown", () => {
    const databasePath = path.join(tempDirs.make("sqlite-open-integrity-"), "database.sqlite");
    fs.writeFileSync(databasePath, "not a sqlite database");
    const openError = Object.assign(new Error("file is not a database"), { errcode: 26 });
    const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementationOnce(() => {
      throw openError;
    });

    try {
      expect(confirmSqliteFileIntegrity(databasePath, "test database")).toEqual({
        status: "failed",
        error: openError,
        terminal: false,
      });
    } finally {
      open.mockRestore();
    }
  });
});
