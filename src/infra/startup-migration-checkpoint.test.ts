import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { seedNativeVersionZeroState } from "../state/native-version-zero.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { STATE_SUPERVISION_KEY } from "../state/openclaw-state-ownership.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { OpenClawStateOwnershipError } from "./sqlite-lifecycle-errors.js";
import {
  acquireStartupMigrationLeaseWithWait,
  hasActiveStartupMigrationLease,
  STARTUP_MIGRATION_LEASE_TTL_MS,
} from "./startup-migration-checkpoint.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

const startupMigrationTempDirs = useAutoCleanupTempDirTracker(afterEach);

type StartupMigrationLeaseTestDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "schema_meta" | "state_leases"
>;

/** Rewrites only the recorded owner start time so the live owner PID looks recycled. */
function overwriteStartupMigrationLeaseOwnerStartedAt(
  env: NodeJS.ProcessEnv,
  startedAt: number,
): void {
  withOpenClawStateStartupMigrationCheckpointDatabase(
    (db) => {
      const kysely = getNodeSqliteKysely<StartupMigrationLeaseTestDatabase>(db);
      const row = executeSqliteQueryTakeFirstSync(
        db,
        kysely.selectFrom("state_leases").select("payload_json as payloadJson"),
      );
      const payload = JSON.parse(row?.payloadJson ?? "{}") as { owner?: { startedAt?: number } };
      executeSqliteQuerySync(
        db,
        kysely.updateTable("state_leases").set({
          payload_json: JSON.stringify({ ...payload, owner: { ...payload.owner, startedAt } }),
        }),
      );
    },
    { env },
  );
}

describe("startup migration lease", () => {
  it("checks migration activity without creating shared state", () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const dbPath = resolveOpenClawStateSqlitePath(env);

    expect(hasActiveStartupMigrationLease({ env })).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("initializes the canonical schema before acquiring the first startup lease", async () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-fresh-"),
    };

    const lease = await acquireStartupMigrationLeaseWithWait({
      env,
      owner: "fresh-startup",
      timeoutMs: 0,
    });

    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(resolveOpenClawStateSqlitePath(env), { readOnly: true });
    try {
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        database
          .prepare("SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ role: "global", schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
      expect(
        database
          .prepare("SELECT 1 AS present FROM sqlite_schema WHERE name = 'plugin_state_entries'")
          .get(),
      ).toEqual({ present: 1 });
    } finally {
      database.close();
      lease.release();
    }
  });

  it.each([false, true])(
    "adopts native version-zero state before lease acquisition (existing lease tables: %s)",
    async (hasExistingLeaseTables) => {
      const env = {
        OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-native-"),
      };
      const databasePath = resolveOpenClawStateSqlitePath(env);
      mkdirSync(path.dirname(databasePath), { recursive: true });
      const { DatabaseSync } = requireNodeSqlite();
      const native = new DatabaseSync(databasePath);
      try {
        seedNativeVersionZeroState(native, hasExistingLeaseTables);
      } finally {
        native.close();
      }

      const lease = await acquireStartupMigrationLeaseWithWait({
        env,
        owner: "native-bootstrap",
        timeoutMs: 0,
      });
      try {
        const initialized = new DatabaseSync(databasePath, { readOnly: true });
        try {
          expect(initialized.prepare("PRAGMA user_version").get()).toEqual({
            user_version: OPENCLAW_STATE_SCHEMA_VERSION,
          });
          expect(
            initialized
              .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
              .get(),
          ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
          expect(
            initialized
              .prepare("SELECT device_id FROM device_identities WHERE identity_key = 'node'")
              .get(),
          ).toEqual({ device_id: "native-device" });
          expect(
            initialized
              .prepare("SELECT config_key FROM exec_approvals_config WHERE config_key = 'current'")
              .get(),
          ).toEqual({ config_key: "current" });
        } finally {
          initialized.close();
        }
      } finally {
        lease.release();
      }
    },
  );

  it("serializes startup migrations with an expiring shared-state lease", async () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const lease = await acquireStartupMigrationLeaseWithWait({
      env,
      now: () => 1000,
      owner: "first",
      timeoutMs: 0,
    });

    expect(hasActiveStartupMigrationLease({ env, nowMs: 1001 })).toBe(true);

    await expect(
      acquireStartupMigrationLeaseWithWait({
        env,
        now: () => 1001,
        owner: "second",
        timeoutMs: 0,
      }),
    ).rejects.toThrow(
      `OpenClaw startup migrations are already running for this state directory; retry after the other OpenClaw process finishes or after 1970-01-01T00:05:01.000Z. (held by pid ${process.pid})`,
    );

    lease.release();

    expect(hasActiveStartupMigrationLease({ env, nowMs: 1002 })).toBe(false);

    const next = await acquireStartupMigrationLeaseWithWait({
      env,
      now: () => 1002,
      owner: "second",
      timeoutMs: 0,
    });
    next.release();
  });

  it("rechecks external ownership inside the final lease write transaction", async () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    runOpenClawStateWriteTransaction(() => undefined, { env });
    closeOpenClawStateDatabaseForTest();
    const databasePath = resolveOpenClawStateSqlitePath(env);
    const { DatabaseSync } = requireNodeSqlite();
    const originalExec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec")?.value as
      | ((this: import("node:sqlite").DatabaseSync, sql: string) => void)
      | undefined;
    if (!originalExec) {
      throw new Error("DatabaseSync.exec descriptor is unavailable");
    }
    // External custody can change after outer admission but before the verified
    // write transaction. Its inner authority check must refuse the new owner.
    let claimed = false;
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: import("node:sqlite").DatabaseSync,
      sql: string,
    ) {
      if (sql === "BEGIN" && !claimed) {
        claimed = true;
        const claimant = new DatabaseSync(databasePath);
        try {
          claimant
            .prepare(
              `INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
               VALUES (?, ?, ?)`,
            )
            .run(
              STATE_SUPERVISION_KEY,
              JSON.stringify({
                version: 1,
                mode: "external",
                managerId: "race-manager",
                claimedAt: 1,
              }),
              1,
            );
        } finally {
          claimant.close();
        }
      }
      return originalExec.call(this, sql);
    });

    try {
      await expect(
        acquireStartupMigrationLeaseWithWait({
          env,
          owner: "unmarked",
          now: () => 1,
          timeoutMs: 0,
        }),
      ).rejects.toThrow(OpenClawStateOwnershipError);
      expect(claimed).toBe(true);
    } finally {
      exec.mockRestore();
    }

    const verify = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        verify
          .prepare(
            `SELECT COUNT(*) AS count
             FROM state_leases
             WHERE scope = 'startup-migrations' AND lease_key = 'global'`,
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        verify
          .prepare(
            `SELECT COUNT(*) AS count
             FROM schema_meta
             WHERE meta_key IN ('state-migrations', 'startup-migrations')`,
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      verify.close();
    }
  });

  it("waits for a live same-host startup migration lease to be released", async () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    let nowMs = 1001;
    let elapsedMs = 0;
    let sleepCount = 0;
    const lease = await acquireStartupMigrationLeaseWithWait({
      env,
      now: () => 1000,
      owner: "first",
      timeoutMs: 0,
    });
    const acquired = await acquireStartupMigrationLeaseWithWait({
      env,
      owner: "second",
      timeoutMs: 1000,
      pollIntervalMs: 250,
      now: () => nowMs,
      monotonicNow: () => elapsedMs,
      sleep: async (ms) => {
        sleepCount += 1;
        lease.release();
        nowMs += ms;
        elapsedMs += ms;
      },
    });

    expect(sleepCount).toBe(1);
    expect(acquired.owner).toBe("second");
    acquired.release();
  });

  it("preserves the existing lease error when the wait bound expires", async () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    let nowMs = 1001;
    let elapsedMs = 0;
    const lease = await acquireStartupMigrationLeaseWithWait({
      env,
      now: () => 1000,
      owner: "first",
      timeoutMs: 0,
    });

    await expect(
      acquireStartupMigrationLeaseWithWait({
        env,
        owner: "second",
        timeoutMs: 500,
        pollIntervalMs: 250,
        now: () => nowMs,
        monotonicNow: () => elapsedMs,
        sleep: async (ms) => {
          nowMs += ms;
          elapsedMs += ms;
        },
      }),
    ).rejects.toThrow(
      `OpenClaw startup migrations are already running for this state directory; retry after the other OpenClaw process finishes or after 1970-01-01T00:05:01.000Z. (held by pid ${process.pid})`,
    );

    lease.release();
  });

  it("reclaims an active startup migration lease whose owner process is gone", async () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const deadPid = 2_147_483_647;
    const stale = await acquireStartupMigrationLeaseWithWait({
      env,
      now: () => 1000,
      owner: "stale",
      ownerPid: deadPid,
      timeoutMs: 0,
    });

    expect(hasActiveStartupMigrationLease({ env, nowMs: 1001 })).toBe(false);

    const replacement = await acquireStartupMigrationLeaseWithWait({
      env,
      owner: "replacement",
      now: () => 1001,
    });
    stale.release();
    expect(hasActiveStartupMigrationLease({ env, nowMs: 1002 })).toBe(true);
    replacement.release();
  });

  // PID numbers are recycled by the OS. Without the start-time guard a stale lease whose PID was
  // reassigned to an unrelated live process would block startup for the full TTL.
  it.skipIf(process.platform === "win32")(
    "reclaims a startup migration lease whose owner PID was recycled",
    async () => {
      const env = {
        OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
      };
      const stale = await acquireStartupMigrationLeaseWithWait({
        env,
        now: () => 1000,
        owner: "stale",
        timeoutMs: 0,
      });

      // The owner PID is this live test process; only the recorded start identity is stale.
      overwriteStartupMigrationLeaseOwnerStartedAt(env, 1);

      expect(hasActiveStartupMigrationLease({ env, nowMs: 1001 })).toBe(false);

      const replacement = await acquireStartupMigrationLeaseWithWait({
        env,
        now: () => 1001,
        owner: "replacement",
        timeoutMs: 0,
      });
      stale.release();
      expect(hasActiveStartupMigrationLease({ env, nowMs: 1002 })).toBe(true);
      replacement.release();
    },
  );

  it("does not report an expired startup migration lease as active", async () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const lease = await acquireStartupMigrationLeaseWithWait({
      env,
      now: () => 1000,
      owner: "first",
      timeoutMs: 0,
    });

    expect(hasActiveStartupMigrationLease({ env, nowMs: 301_001 })).toBe(false);

    lease.release();
  });

  it("renews startup migration leases while the owner is still running", async () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const lease = await acquireStartupMigrationLeaseWithWait({
      env,
      now: () => 1000,
      owner: "first",
      timeoutMs: 0,
    });

    const onActivity = vi.fn();
    expect(hasActiveStartupMigrationLease({ env, nowMs: 1001, onActivity })).toBe(true);
    lease.heartbeat({ nowMs: 300_000 });
    expect(hasActiveStartupMigrationLease({ env, nowMs: 301_001, onActivity })).toBe(true);
    expect(onActivity).toHaveBeenLastCalledWith({
      owner: "first",
      pid: process.pid,
      heartbeatAt: 300_000,
    });

    await expect(
      acquireStartupMigrationLeaseWithWait({
        env,
        now: () => 301_001,
        owner: "second",
        timeoutMs: 0,
      }),
    ).rejects.toThrow("OpenClaw startup migrations are already running");

    lease.release();
    expect(hasActiveStartupMigrationLease({ env, nowMs: 301_002, onActivity })).toBe(false);
    expect(onActivity).toHaveBeenCalledTimes(2);
  });

  it("checks exact lease ownership inside the caller write transaction", async () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const nowMs = Date.now();
    const first = await acquireStartupMigrationLeaseWithWait({
      env,
      now: () => nowMs,
      owner: "first",
      timeoutMs: 0,
    });
    const second = await acquireStartupMigrationLeaseWithWait({
      env,
      now: () => nowMs + STARTUP_MIGRATION_LEASE_TTL_MS + 1,
      owner: "second",
      timeoutMs: 0,
    });

    runOpenClawStateWriteTransaction(
      ({ db }) => {
        expect(() => first.assertOwnedInTransaction(db)).toThrow(
          "startup migration lease was lost",
        );
        expect(() => second.assertOwnedInTransaction(db)).not.toThrow();
      },
      { env },
    );

    first.release();
    second.release();
  });

  it("acquires a lease without requiring the full state schema to be canonical", async () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const sqlite = requireNodeSqlite();
    const dbPath = resolveOpenClawStateSqlitePath(env);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE agent_databases (
        agent_id TEXT NOT NULL PRIMARY KEY,
        path TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        size_bytes INTEGER
      );
    `);
    db.close();

    const lease = await acquireStartupMigrationLeaseWithWait({
      env,
      now: () => 1000,
      owner: "first",
      timeoutMs: 0,
    });
    const leased = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    expect(leased.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    leased.close();
    lease.release();
  });

  it("refuses future-version state databases before creating lease tables", async () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-"),
    };
    const sqlite = requireNodeSqlite();
    const dbPath = resolveOpenClawStateSqlitePath(env);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    db.close();

    await expect(
      acquireStartupMigrationLeaseWithWait({
        env,
        now: () => 1000,
        owner: "first",
        timeoutMs: 0,
      }),
    ).rejects.toThrow(`newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);

    const verify = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const row = verify
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'state_leases'")
      .get() as { ok?: unknown } | undefined;
    verify.close();
    expect(row).toBeUndefined();
  });

  it("rejects foreign-key corruption before acquiring a startup lease", async () => {
    const env = {
      OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-corrupt-"),
    };
    const dbPath = resolveOpenClawStateSqlitePath(env);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE legacy_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE legacy_child (parent_id INTEGER REFERENCES legacy_parent(id));
      INSERT INTO legacy_child VALUES (1);
    `);
    db.close();

    await expect(
      acquireStartupMigrationLeaseWithWait({ env, owner: "corrupt-state", timeoutMs: 0 }),
    ).rejects.toThrow("foreign_key_check failed");
    const verify = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        verify.prepare("SELECT name FROM sqlite_schema WHERE name = 'schema_meta'").get(),
      ).toBeUndefined();
    } finally {
      verify.close();
    }
  });
});
