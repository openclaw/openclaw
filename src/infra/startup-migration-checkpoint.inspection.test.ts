import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as schemaHelpers from "../state/openclaw-state-db-schema-helpers.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as sqliteIntegrity from "./sqlite-integrity.js";
import {
  acquireStartupMigrationLease,
  STARTUP_MIGRATION_LEASE_TTL_MS,
  inspectStartupMigrationCheckpointWithLease,
  readMigrationCheckpointStatus,
  readStartupMigrationVersion,
  recordSuccessfulStateMigrations,
  recordSuccessfulStartupMigrations,
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
const identity = {
  effectiveConfigFingerprint: "config",
  pluginDoctorConfigFingerprint: "doctor",
  pluginMigrationFingerprint: "plugins",
};
function parameters() {
  return {
    env,
    buildIdentity: "synthetic-build",
    version: "2026.9.5",
    identity,
    stateMigrations: true,
    startupMigrations: true,
    forceLease: false,
    sleep: async () => {},
  };
}
function integrityScans(prepare: MockInstance<DatabaseSync["prepare"]>) {
  return prepare.mock.calls.filter(([sql]) => sql === "PRAGMA integrity_check;").length;
}

describe("startup checkpoint inspection and lease", () => {
  it("reduces the complete startup checkpoint sequence from six scans to five", async () => {
    readStartupMigrationVersion(env);
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const inspected = await inspectStartupMigrationCheckpointWithLease(parameters());
    expect(inspected.status).toBe("stale");
    expect(inspected.lease).toBeDefined();
    try {
      expect(integrityScans(prepare)).toBe(1);
      expect(readMigrationCheckpointStatus(parameters())).toBe("stale");
      expect(integrityScans(prepare)).toBe(2);
      recordSuccessfulStateMigrations({ ...parameters(), lease: inspected.lease });
      expect(integrityScans(prepare)).toBe(3);
      recordSuccessfulStartupMigrations({ ...parameters(), lease: inspected.lease });
      expect(integrityScans(prepare)).toBe(4);
    } finally {
      inspected.lease?.release();
    }
    expect(integrityScans(prepare)).toBe(5);
    expect(prepare.mock.calls.filter(([sql]) => sql === "PRAGMA foreign_key_check;")).toHaveLength(
      5,
    );
    expect(readMigrationCheckpointStatus(parameters())).toBe("startup-current");
    const next = acquireStartupMigrationLease({ env, owner: "after-release" });
    next.release();
  });

  it.each([false, true])(
    "allows WAL writers during verification and discards invalidated proof (corrupt=%s)",
    async (corrupt) => {
      readStartupMigrationVersion(env);
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
      let lease: Awaited<ReturnType<typeof inspectStartupMigrationCheckpointWithLease>>["lease"];
      try {
        const operation = inspectStartupMigrationCheckpointWithLease(parameters());
        if (corrupt) {
          await expect(operation).rejects.toThrow("foreign_key_check failed");
          expect(
            competing
              .prepare("SELECT owner FROM state_leases WHERE scope = 'startup-migrations'")
              .all(),
          ).toEqual([]);
        } else {
          lease = (await operation).lease;
          expect(lease).toBeDefined();
          expect(() => acquireStartupMigrationLease({ env })).toThrow("already running");
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
      readStartupMigrationVersion(env);
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
      let lease: Awaited<ReturnType<typeof inspectStartupMigrationCheckpointWithLease>>["lease"];
      try {
        const operation = inspectStartupMigrationCheckpointWithLease({
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
          lease = (await operation).lease;
          expect(lease).toBeDefined();
          expect(sleep).toHaveBeenCalledTimes(1);
          expect(checker).toHaveBeenCalledTimes(2);
          expect(() => acquireStartupMigrationLease({ env })).toThrow("already running");
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
      readStartupMigrationVersion(env);
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
      let lease: Awaited<ReturnType<typeof inspectStartupMigrationCheckpointWithLease>>["lease"];
      try {
        lease = (
          await inspectStartupMigrationCheckpointWithLease({ ...parameters(), now: () => nowMs })
        ).lease;
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

  it("bootstraps fresh canonical state and releases its initial claim", async () => {
    expect(existsSync(resolveOpenClawStateSqlitePath(env))).toBe(false);
    const inspected = await inspectStartupMigrationCheckpointWithLease(parameters());
    try {
      expect(inspected.status).toBe("stale");
      expect(inspected.lease).toBeDefined();
      recordSuccessfulStartupMigrations({ ...parameters(), lease: inspected.lease });
      expect(readMigrationCheckpointStatus(parameters())).toBe("startup-current");
    } finally {
      inspected.lease?.release();
    }
    const next = acquireStartupMigrationLease({ env });
    next.release();
  });

  it.each([false, true])(
    "rechecks schema repair and rolls back damage (snapshot invalidated=%s)",
    async (invalidateSnapshot) => {
      readStartupMigrationVersion(env);
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
        await expect(inspectStartupMigrationCheckpointWithLease(parameters())).rejects.toThrow(
          "integrity_check failed",
        );
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

  it("rolls back a conditional claim when the combined operation cannot commit", async () => {
    readStartupMigrationVersion(env);
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
      await expect(inspectStartupMigrationCheckpointWithLease(parameters())).rejects.toThrow(
        "synthetic inspection commit failure",
      );
    } finally {
      spy.mockRestore();
    }
    const next = acquireStartupMigrationLease({ env, owner: "after-rollback" });
    next.release();
  });

  it.each([
    {
      marker: "startup",
      stateMigrations: true,
      startupMigrations: true,
      forceLease: false,
      status: "startup-current",
      claimed: false,
    },
    {
      marker: "state",
      stateMigrations: true,
      startupMigrations: false,
      forceLease: false,
      status: "state-current",
      claimed: false,
    },
    {
      marker: "state",
      stateMigrations: true,
      startupMigrations: true,
      forceLease: false,
      status: "state-current",
      claimed: true,
    },
    {
      marker: "startup",
      stateMigrations: true,
      startupMigrations: true,
      forceLease: true,
      status: "startup-current",
      claimed: true,
    },
  ])(
    "preserves $marker checkpoint scope (startup=$startupMigrations, forced=$forceLease)",
    async (scenario) => {
      const params = { ...parameters(), ...scenario };
      if (scenario.marker === "startup") {
        recordSuccessfulStartupMigrations(params);
      } else {
        recordSuccessfulStateMigrations(params);
      }
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const inspected = await inspectStartupMigrationCheckpointWithLease(params);
      try {
        expect(inspected.status).toBe(scenario.status);
        expect(Boolean(inspected.lease)).toBe(scenario.claimed);
        expect(integrityScans(prepare)).toBe(1);
      } finally {
        inspected.lease?.release();
      }
      const next = acquireStartupMigrationLease({ env });
      next.release();
    },
  );

  it("does not create state when no checkpoint or lease is requested", async () => {
    const inspected = await inspectStartupMigrationCheckpointWithLease({
      ...parameters(),
      stateMigrations: false,
      startupMigrations: false,
    });
    expect(inspected).toEqual({ status: "stale" });
    expect(existsSync(resolveOpenClawStateSqlitePath(env))).toBe(false);
  });

  it("keeps migrations required without build provenance", async () => {
    recordSuccessfulStartupMigrations(parameters());
    const inspected = await inspectStartupMigrationCheckpointWithLease({
      ...parameters(),
      buildIdentity: null,
    });
    try {
      expect(inspected.status).toBe("stale");
      expect(inspected.lease).toBeDefined();
    } finally {
      inspected.lease?.release();
    }
  });

  it("still acquires and refreshes after a competing startup completes while waiting", async () => {
    const holder = acquireStartupMigrationLease({ env });
    let waits = 0;
    try {
      const inspected = await inspectStartupMigrationCheckpointWithLease({
        ...parameters(),
        owner: "waiting-startup",
        sleep: async () => {
          waits++;
          recordSuccessfulStartupMigrations({ ...parameters(), lease: holder });
          holder.release();
        },
      });
      try {
        expect(waits).toBe(1);
        expect(inspected.status).toBe("startup-current");
        expect(inspected.lease?.owner).toBe("waiting-startup");
        expect(readMigrationCheckpointStatus(parameters())).toBe("startup-current");
        expect(() => acquireStartupMigrationLease({ env })).toThrow("already running");
      } finally {
        inspected.lease?.release();
      }
    } finally {
      holder.release();
    }
  });

  it("refuses corruption before checkpoint bootstrap or lease writes", async () => {
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
    await expect(inspectStartupMigrationCheckpointWithLease(parameters())).rejects.toThrow(
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
