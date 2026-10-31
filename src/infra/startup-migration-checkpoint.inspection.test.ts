import { copyFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as schemaHelpers from "../state/openclaw-state-db-schema-helpers.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as sqliteIntegrity from "./sqlite-integrity.js";
import {
  acquireStartupMigrationLeaseWithWait as acquireWithWait,
  STARTUP_MIGRATION_LEASE_TTL_MS as LEASE_TTL_MS,
  type StartupMigrationLease,
} from "./startup-migration-checkpoint.js";
import * as tempRoot from "./tmp-openclaw-dir.js";

const dirs = createTempDirTracker();
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  dirs.cleanup();
});
const checkIntegrity = sqliteIntegrity.assertSqliteIntegrity;
const LEASE_SQL = "SELECT owner FROM state_leases WHERE scope = 'startup-migrations'";
const FOREIGN_KEY_SCHEMA = `PRAGMA foreign_keys = OFF;
CREATE TABLE parent (id INTEGER PRIMARY KEY);
CREATE TABLE child (parent_id INTEGER REFERENCES parent(id));`;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  const root = dirs.make("openclaw-checkpoint-inspection-");
  env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
  const handoffRoot = path.join(root, "handoff");
  mkdirSync(handoffRoot, { mode: 0o700 });
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(handoffRoot);
});
function acquire(options: Parameters<typeof acquireWithWait>[0] = {}) {
  return acquireWithWait({ env, timeoutMs: 0, sleep: async () => {}, ...options });
}
function seed(sql: string) {
  const pathname = resolveOpenClawStateSqlitePath(env);
  mkdirSync(path.dirname(pathname), { recursive: true });
  using db = new DatabaseSync(pathname);
  db.exec(sql);
}
function query(sql: string) {
  using db = new DatabaseSync(resolveOpenClawStateSqlitePath(env), { readOnly: true });
  return db.prepare(sql).all();
}
async function initializeLeaseDatabase() {
  const lease = await acquire();
  lease.release();
  closeOpenClawStateDatabaseForTest();
  const pathname = resolveOpenClawStateSqlitePath(env);
  // Integrity hooks exercise first admission, before this physical file has a receipt.
  const seedPath = `${pathname}.seed`;
  renameSync(pathname, seedPath);
  copyFileSync(seedPath, pathname);
}

it.each(["stale", "corrupt", "writer", "timeout"])("%s WAL interference", async (scenario) => {
  const phase = ["stale", "corrupt"].includes(scenario) ? "stale" : "writer";
  const fails = ["corrupt", "timeout"].includes(scenario);
  await initializeLeaseDatabase();
  using peer = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
  peer.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 0;");
  if (phase === "stale") {
    peer.exec(FOREIGN_KEY_SCHEMA);
  }
  let interfered = false,
    nowMs = Date.now(),
    clock = 0;
  const checker = vi
    .spyOn(sqliteIntegrity, "assertSqliteIntegrity")
    .mockImplementation((db, label, check) => {
      if (phase === "stale") {
        const prepare = db.prepare.bind(db);
        vi.spyOn(db, "prepare").mockImplementation((sql) => {
          // Commit after integrity_check establishes its snapshot, before foreign_key_check.
          if (sql === "PRAGMA foreign_key_check;" && !interfered) {
            expect(db.isTransaction).toBe(true);
            peer.exec(
              fails
                ? "INSERT INTO child VALUES (1)"
                : "UPDATE schema_meta SET updated_at = updated_at + 1 WHERE meta_key = 'primary'",
            );
            interfered = true;
          }
          return prepare(sql);
        });
      }
      const result = checkIntegrity(db, label, check);
      if (phase === "stale") {
        nowMs += LEASE_TTL_MS + 1;
      } else if (!interfered) {
        peer.exec(
          "BEGIN IMMEDIATE; UPDATE schema_meta SET updated_at = updated_at + 1 WHERE meta_key = 'primary'",
        );
        interfered = true;
      }
      return result;
    });
  const sleep = vi.fn(async () => {
    clock += 1;
    peer.exec("COMMIT");
  });
  let lease: StartupMigrationLease | undefined;
  try {
    const operation = acquire(
      phase === "stale"
        ? { timeoutMs: 1000, now: () => nowMs }
        : { sleep, monotonicNow: () => clock, timeoutMs: fails ? 0 : 10 },
    );
    if (fails) {
      if (phase === "stale") {
        await expect(operation).rejects.toThrow("foreign_key_check failed");
      } else {
        await expect(operation).rejects.toMatchObject({ errcode: 5 });
        expect(sleep).not.toHaveBeenCalled();
      }
      expect(peer.prepare(LEASE_SQL).all()).toEqual([]);
    } else {
      lease = await operation;
      if (phase === "stale") {
        expect(
          peer.prepare("SELECT expires_at FROM state_leases WHERE owner = ?").get(lease.owner)
            ?.expires_at,
        ).toBeGreaterThan(nowMs);
      } else {
        expect(sleep).toHaveBeenCalledTimes(1);
      }
      expect(checker).toHaveBeenCalledTimes(2);
      await expect(acquire()).rejects.toThrow("already running");
    }
    if (phase === "stale") {
      expect(interfered).toBe(true);
      expect(checker).toHaveBeenCalledTimes(2);
    }
  } finally {
    checker.mockRestore();
    if (phase === "stale" && fails) {
      peer.exec("DELETE FROM child");
    }
    if (peer.isTransaction) {
      peer.exec("ROLLBACK");
    }
    lease?.release();
  }
});

it.each(["repair", "commit"] as const)("rolls back a failed %s", async (failure) => {
  await initializeLeaseDatabase();
  const ensureColumn = schemaHelpers.ensureColumn;
  if (failure === "repair") {
    seed(`
      PRAGMA journal_mode = WAL;
      ALTER TABLE schema_meta DROP COLUMN app_version;
      CREATE TABLE repair_fixture (value INTEGER CHECK(value > 0));
    `);
  }
  const spy =
    failure === "repair"
      ? vi.spyOn(schemaHelpers, "ensureColumn").mockImplementation((db, table, column) => {
          const changed = ensureColumn(db, table, column);
          if (table === "schema_meta" && changed) {
            db.exec(
              "PRAGMA ignore_check_constraints = ON; INSERT INTO repair_fixture VALUES (-1); PRAGMA ignore_check_constraints = OFF;",
            );
          }
          return changed;
        })
      : vi
          .spyOn(sqliteIntegrity, "assertSqliteIntegrity")
          .mockImplementation((db, label, check) => {
            const verified = checkIntegrity(db, label, check);
            const exec = db.exec.bind(db);
            vi.spyOn(db, "exec").mockImplementation((sql) => {
              if (sql === "COMMIT") {
                throw new Error("synthetic inspection commit failure");
              }
              exec(sql);
            });
            return verified;
          });
  await expect(
    acquire({ timeoutMs: failure === "repair" ? 1000 : 0 }).finally(() => spy.mockRestore()),
  ).rejects.toThrow(
    failure === "repair" ? "integrity_check failed" : "synthetic inspection commit failure",
  );
  if (failure === "repair") {
    expect(query("PRAGMA table_info(schema_meta)").map((row) => row.name)).not.toContain(
      "app_version",
    );
    expect({ repairRows: query("SELECT * FROM repair_fixture"), leases: query(LEASE_SQL) }).toEqual(
      { repairRows: [], leases: [] },
    );
  } else {
    const next = await acquire({ owner: "after-rollback" });
    next.release();
  }
});

it("refuses corruption before schema bootstrap or lease writes", async () => {
  seed(`${FOREIGN_KEY_SCHEMA} INSERT INTO child VALUES (1);`);
  await expect(acquire()).rejects.toThrow("foreign_key_check failed");
  expect({
    tables: query("SELECT name FROM sqlite_schema WHERE name IN ('schema_meta', 'state_leases')"),
    children: query("SELECT parent_id FROM child"),
  }).toEqual({ tables: [], children: [{ parent_id: 1 }] });
});
