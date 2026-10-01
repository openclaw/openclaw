import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as schemaHelpers from "../state/openclaw-state-db-schema-helpers.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as sqliteIntegrity from "./sqlite-integrity.js";
import {
  acquireStartupMigrationLeaseWithWait,
  STARTUP_MIGRATION_LEASE_TTL_MS,
  type StartupMigrationLease,
} from "./startup-migration-checkpoint.js";
import * as tempRoot from "./tmp-openclaw-dir.js";
import { resolveManagedUpdateLeaseDatabasePath } from "./update-managed-service-handoff-lease.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    cleanup();
  }),
);
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  const root = dirs.make("openclaw-checkpoint-inspection-");
  env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
  const handoffRoot = path.join(root, "handoff");
  mkdirSync(handoffRoot, { mode: 0o700 });
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(handoffRoot);
  expect(resolveManagedUpdateLeaseDatabasePath()).toBe(
    path.join(handoffRoot, "managed-update-handoffs.sqlite"),
  );
});
function parameters() {
  return { env, timeoutMs: 0, sleep: async () => {} };
}
async function initializeLeaseDatabase() {
  const lease = await acquireStartupMigrationLeaseWithWait(parameters());
  lease.release();
}

describe("startup lease integrity and admission", () => {
  it.each([false, true])(
    "allows WAL writers during verification and discards invalidated proof (corrupt=%s)",
    async (corrupt) => {
      await initializeLeaseDatabase();
      const competing = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
      competing.exec(`
        PRAGMA busy_timeout = 0; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (parent_id INTEGER REFERENCES parent(id));
      `);
      const assertIntegrity = sqliteIntegrity.assertSqliteIntegrity;
      let committed = false;
      const checker = vi
        .spyOn(sqliteIntegrity, "assertSqliteIntegrity")
        .mockImplementation((db, label, check) => {
          const prepare = db.prepare.bind(db);
          vi.spyOn(db, "prepare").mockImplementation((sql) => {
            // Keep both real native checks. Commit between them, after integrity_check
            // established the snapshot, to exercise SQLite's stale-writer refusal.
            if (sql === "PRAGMA foreign_key_check;" && !committed) {
              expect(db.isTransaction).toBe(true);
              competing.exec(
                corrupt
                  ? "INSERT INTO child VALUES (1)"
                  : "UPDATE schema_meta SET updated_at = updated_at + 1 WHERE meta_key = 'primary'",
              );
              committed = true;
            }
            return prepare(sql);
          });
          return assertIntegrity(db, label, check);
        });
      let lease: StartupMigrationLease | undefined;
      try {
        const operation = acquireStartupMigrationLeaseWithWait({
          ...parameters(),
          timeoutMs: 1000,
        });
        if (corrupt) {
          await expect(operation).rejects.toThrow("foreign_key_check failed");
          expect(
            competing
              .prepare("SELECT owner FROM state_leases WHERE scope = 'startup-migrations'")
              .all(),
          ).toEqual([]);
        } else {
          lease = await operation;
          expect(lease).toBeDefined();
          await expect(acquireStartupMigrationLeaseWithWait(parameters())).rejects.toThrow(
            "already running",
          );
        }
        expect(committed).toBe(true);
        expect(checker).toHaveBeenCalledTimes(corrupt ? 2 : 3);
      } finally {
        checker.mockRestore();
        if (corrupt) {
          competing.exec("DELETE FROM child");
        }
        lease?.release();
        competing.close();
      }
    },
  );

  it.each([false, true])(
    "waits for an active WAL writer within the existing budget (exhausted=%s)",
    async (exhausted) => {
      await initializeLeaseDatabase();
      const peer = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
      peer.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 0;");
      const assertIntegrity = sqliteIntegrity.assertSqliteIntegrity;
      let started = false;
      let clock = 0;
      const checker = vi
        .spyOn(sqliteIntegrity, "assertSqliteIntegrity")
        .mockImplementation((db, label, check) => {
          const result = assertIntegrity(db, label, check);
          if (!started) {
            peer.exec(
              "BEGIN IMMEDIATE; UPDATE schema_meta SET updated_at = updated_at + 1 WHERE meta_key = 'primary'",
            );
            started = true;
          }
          return result;
        });
      const sleep = vi.fn(async () => {
        clock += 1;
        peer.exec("COMMIT");
      });
      let lease: StartupMigrationLease | undefined;
      try {
        const operation = acquireStartupMigrationLeaseWithWait({
          ...parameters(),
          sleep,
          monotonicNow: () => clock,
          timeoutMs: exhausted ? 0 : 10,
        });
        if (exhausted) {
          await expect(operation).rejects.toMatchObject({ errcode: 5 });
          expect(sleep).not.toHaveBeenCalled();
          expect(
            peer.prepare("SELECT owner FROM state_leases WHERE scope = 'startup-migrations'").all(),
          ).toEqual([]);
        } else {
          lease = await operation;
          expect(lease).toBeDefined();
          expect(sleep).toHaveBeenCalledTimes(1);
          expect(checker).toHaveBeenCalledTimes(2);
          await expect(acquireStartupMigrationLeaseWithWait(parameters())).rejects.toThrow(
            "already running",
          );
        }
      } finally {
        checker.mockRestore();
        if (peer.isTransaction) {
          peer.exec("ROLLBACK");
        }
        lease?.release();
        peer.close();
      }
    },
  );

  it.each([false, true])(
    "starts lease lifetime after slow verification (snapshot invalidated=%s)",
    async (invalidateSnapshot) => {
      await initializeLeaseDatabase();
      const pathname = resolveOpenClawStateSqlitePath(env);
      const peer = new DatabaseSync(pathname);
      peer.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 0;");
      let nowMs = Date.now();
      let committed = false;
      const assertIntegrity = sqliteIntegrity.assertSqliteIntegrity;
      const checker = vi
        .spyOn(sqliteIntegrity, "assertSqliteIntegrity")
        .mockImplementation((db, label, check) => {
          const result = assertIntegrity(db, label, check);
          // Advance the injected lease clock, not real timers, after native verification.
          nowMs += STARTUP_MIGRATION_LEASE_TTL_MS + 1;
          if (invalidateSnapshot && !committed) {
            peer.exec(
              "UPDATE schema_meta SET updated_at = updated_at + 1 WHERE meta_key = 'primary'",
            );
            committed = true;
          }
          return result;
        });
      let lease: StartupMigrationLease | undefined;
      try {
        lease = await acquireStartupMigrationLeaseWithWait({
          ...parameters(),
          timeoutMs: 1000,
          now: () => nowMs,
        });
        expect(lease).toBeDefined();
        const row = peer
          .prepare("SELECT expires_at FROM state_leases WHERE owner = ?")
          .get(lease!.owner);
        expect(row?.expires_at).toBeGreaterThan(nowMs);
        expect(committed).toBe(invalidateSnapshot);
      } finally {
        checker.mockRestore();
        lease?.release();
        peer.close();
      }
    },
  );

  it.each([false, true])(
    "rechecks schema repair and rolls back damage (snapshot invalidated=%s)",
    async (invalidateSnapshot) => {
      await initializeLeaseDatabase();
      const pathname = resolveOpenClawStateSqlitePath(env);
      const fixture = new DatabaseSync(pathname);
      try {
        fixture.exec(`
        PRAGMA journal_mode = WAL;
        ALTER TABLE schema_meta DROP COLUMN app_version;
        CREATE TABLE repair_fixture (value INTEGER CHECK(value > 0));
      `);
      } finally {
        fixture.close();
      }
      const assertIntegrity = sqliteIntegrity.assertSqliteIntegrity;
      let invalidated = false;
      const checker = vi
        .spyOn(sqliteIntegrity, "assertSqliteIntegrity")
        .mockImplementation((db, label, check) => {
          const result = assertIntegrity(db, label, check);
          if (invalidateSnapshot && !invalidated) {
            const peer = new DatabaseSync(pathname);
            try {
              peer.exec(
                "UPDATE schema_meta SET updated_at = updated_at + 1 WHERE meta_key = 'primary'",
              );
              invalidated = true;
            } finally {
              peer.close();
            }
          }
          return result;
        });
      const ensureColumn = schemaHelpers.ensureColumn;
      const repair = vi
        .spyOn(schemaHelpers, "ensureColumn")
        .mockImplementation((db, table, column) => {
          const changed = ensureColumn(db, table, column);
          if (table === "schema_meta" && changed) {
            // Damage is introduced after the real additive repair, in its transaction.
            db.exec(
              "PRAGMA ignore_check_constraints = ON; INSERT INTO repair_fixture VALUES (-1); PRAGMA ignore_check_constraints = OFF;",
            );
          }
          return changed;
        });
      try {
        await expect(
          acquireStartupMigrationLeaseWithWait({ ...parameters(), timeoutMs: 1000 }),
        ).rejects.toThrow("integrity_check failed");
      } finally {
        repair.mockRestore();
        checker.mockRestore();
      }
      expect(invalidated).toBe(invalidateSnapshot);
      const verify = new DatabaseSync(pathname, { readOnly: true });
      try {
        expect(
          verify
            .prepare("PRAGMA table_info(schema_meta)")
            .all()
            .map((row) => row.name),
        ).not.toContain("app_version");
        expect(verify.prepare("SELECT * FROM repair_fixture").all()).toEqual([]);
        expect(
          verify.prepare("SELECT owner FROM state_leases WHERE scope = 'startup-migrations'").all(),
        ).toEqual([]);
      } finally {
        verify.close();
      }
    },
  );

  it("rolls back a lease claim when its verified transaction cannot commit", async () => {
    await initializeLeaseDatabase();
    const assertIntegrity = sqliteIntegrity.assertSqliteIntegrity;
    const spy = vi
      .spyOn(sqliteIntegrity, "assertSqliteIntegrity")
      .mockImplementation((db, label, check) => {
        const verified = assertIntegrity(db, label, check);
        const exec = db.exec.bind(db);
        vi.spyOn(db, "exec").mockImplementation((sql) => {
          if (sql === "COMMIT") {
            throw new Error("synthetic inspection commit failure");
          }
          exec(sql);
        });
        return verified;
      });
    try {
      await expect(acquireStartupMigrationLeaseWithWait(parameters())).rejects.toThrow(
        "synthetic inspection commit failure",
      );
    } finally {
      spy.mockRestore();
    }
    const next = await acquireStartupMigrationLeaseWithWait({
      ...parameters(),
      owner: "after-rollback",
    });
    next.release();
  });

  it("refuses corruption before schema bootstrap or lease writes", async () => {
    const pathname = resolveOpenClawStateSqlitePath(env);
    mkdirSync(path.dirname(pathname), { recursive: true });
    const corrupt = new DatabaseSync(pathname);
    try {
      corrupt.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (parent_id INTEGER REFERENCES parent(id));
      INSERT INTO child VALUES (1);
    `);
    } finally {
      corrupt.close();
    }
    await expect(acquireStartupMigrationLeaseWithWait(parameters())).rejects.toThrow(
      "foreign_key_check failed",
    );
    const verify = new DatabaseSync(pathname, { readOnly: true });
    try {
      expect(
        verify
          .prepare("SELECT name FROM sqlite_schema WHERE name IN ('schema_meta', 'state_leases')")
          .all(),
      ).toEqual([]);
      expect(verify.prepare("SELECT parent_id FROM child").all()).toEqual([{ parent_id: 1 }]);
    } finally {
      verify.close();
    }
  });
});
