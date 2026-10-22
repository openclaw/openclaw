import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { seedNativeVersionZeroState } from "../state/native-version-zero.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { withStateMigrationBackupForTest } from "../state/openclaw-state-schema.test-support.js";
import { runClientCredentialOperation } from "./client-credential-store.js";
import { generateStoredDeviceIdentity } from "./device-identity-material.js";
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

const { DatabaseSync } = requireNodeSqlite();
let env: NodeJS.ProcessEnv;
let databasePath: string;
beforeEach(() => {
  env = { OPENCLAW_STATE_DIR: startupMigrationTempDirs.make("openclaw-startup-migration-") };
  databasePath = resolveOpenClawStateSqlitePath(env);
});
function acquireLease(options: Parameters<typeof acquireStartupMigrationLeaseWithWait>[0] = {}) {
  return acquireStartupMigrationLeaseWithWait({ env, timeoutMs: 0, ...options });
}
function readRow(sql: string) {
  using db = new DatabaseSync(databasePath, { readOnly: true });
  return db.prepare(sql).get();
}
function seedDatabase(seed: (db: import("node:sqlite").DatabaseSync) => void) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  using db = new DatabaseSync(databasePath);
  seed(db);
}

/** Models a prior host or recycled PID without replacing the real lease store. */
function overwriteStartupMigrationLeaseOwner(
  leaseEnv: NodeJS.ProcessEnv,
  changes: { host?: string; startedAt?: number },
): void {
  withOpenClawStateStartupMigrationCheckpointDatabase(
    (db) => {
      const row = db.prepare("SELECT payload_json FROM state_leases").get();
      const payload = JSON.parse(String(row?.payload_json ?? "{}")) as {
        owner?: { startedAt?: number };
      };
      db.prepare("UPDATE state_leases SET payload_json = ?").run(
        JSON.stringify({ ...payload, owner: { ...payload.owner, ...changes } }),
      );
    },
    { env: leaseEnv },
  );
}

describe("startup migration lease", () => {
  it("initializes the canonical schema before acquiring the first startup lease", async () => {
    const lease = await acquireLease({ owner: "fresh-startup" });

    try {
      expect({
        version: readRow("PRAGMA user_version"),
        meta: readRow("SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary'"),
        plugin: readRow(
          "SELECT 1 AS present FROM sqlite_schema WHERE name = 'plugin_state_entries'",
        ),
      }).toEqual({
        version: { user_version: OPENCLAW_STATE_SCHEMA_VERSION },
        meta: { role: "global", schema_version: OPENCLAW_STATE_SCHEMA_VERSION },
        plugin: { present: 1 },
      });
    } finally {
      lease.release();
    }
  });

  it.each([false, true])(
    "adopts captured native version-zero state before lease acquisition (existing lease tables: %s)",
    async (hasExistingLeaseTables) => {
      const identity = generateStoredDeviceIdentity(1);
      seedDatabase((native) => {
        seedNativeVersionZeroState(native, hasExistingLeaseTables);
        native
          .prepare(
            "UPDATE device_identities SET device_id=?, public_key_pem=?, private_key_pem=? WHERE identity_key='node'",
          )
          .run(identity.deviceId, identity.publicKeyPem, identity.privateKeyPem);
      });

      await withStateMigrationBackupForTest({ env }, () => openOpenClawStateDatabase({ env }));
      const lease = await acquireLease({ owner: "native-bootstrap" });
      try {
        expect({
          version: readRow("PRAGMA user_version"),
          meta: readRow("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'"),
          legacy: readRow("SELECT name FROM sqlite_schema WHERE name='device_identities'"),
          approvals: readRow(
            "SELECT config_key FROM exec_approvals_config WHERE config_key = 'current'",
          ),
        }).toEqual({
          version: { user_version: OPENCLAW_STATE_SCHEMA_VERSION },
          meta: { schema_version: OPENCLAW_STATE_SCHEMA_VERSION },
          legacy: undefined,
          approvals: { config_key: "current" },
        });
        expect(
          runClientCredentialOperation(env, { kind: "identity.read", identity_key: "node" }),
        ).toEqual({
          kind: "identity",
          identity: {
            identity_key: "node",
            device_id: identity.deviceId,
            public_key_pem: identity.publicKeyPem,
            private_key_pem: identity.privateKeyPem,
            created_at_ms: 1,
            updated_at_ms: 1,
          },
        });
      } finally {
        lease.release();
      }
    },
  );

  it.each([false, true])(
    "fences a published ownership claim before the final lease write (cached handle: %s)",
    async (admittedOwner) => {
      const database = runOpenClawStateWriteTransaction(({ db }) => db, { env });
      if (!admittedOwner) {
        closeOpenClawStateDatabaseForTest();
      }
      // Enter before the cached handle's native observer, not from its callback scope.
      const execTarget = admittedOwner ? database : DatabaseSync.prototype;
      const originalExec = Object.getOwnPropertyDescriptor(execTarget, "exec")?.value as
        | ((this: import("node:sqlite").DatabaseSync, sql: string) => void)
        | undefined;
      if (!originalExec) {
        throw new Error("DatabaseSync.exec descriptor is unavailable");
      }
      // Closing a handle leaves process admission warm. The real claim owner must
      // publish its committed authority before this transaction can write.
      let claimed = false;
      const exec = vi.spyOn(execTarget, "exec").mockImplementation(function (
        this: import("node:sqlite").DatabaseSync,
        sql: string,
      ) {
        if ((sql === "BEGIN" || sql === "BEGIN IMMEDIATE") && !claimed) {
          claimed = true;
          claimOpenClawStateOwnership("race-manager", {
            env: { ...env, OPENCLAW_SUPERVISOR_MODE: "external" },
          });
        }
        return originalExec.call(this, sql);
      });

      try {
        const acquisition = acquireLease({ owner: "unmarked", now: () => 1 });
        expect(claimed).toBe(true);
        await expect(acquisition).rejects.toThrow(OpenClawStateOwnershipError);
      } finally {
        exec.mockRestore();
      }

      expect({
        leases: readRow(
          "SELECT COUNT(*) AS count FROM state_leases WHERE scope = 'startup-migrations' AND lease_key = 'global'",
        ),
        checkpoints: readRow(
          "SELECT COUNT(*) AS count FROM schema_meta WHERE meta_key IN ('state-migrations', 'startup-migrations')",
        ),
      }).toEqual({ leases: { count: 0 }, checkpoints: { count: 0 } });
    },
  );

  it.each([false, true])(
    "waits for a startup migration lease to be released (other host: %s)",
    async (otherHost) => {
      let nowMs = 1001;
      let elapsedMs = 0;
      let sleepCount = 0;
      const lease = await acquireLease({ now: () => 1000, owner: "first" });
      if (otherHost) {
        overwriteStartupMigrationLeaseOwner(env, { host: "previous-pod" });
      }
      const acquired = await acquireLease({
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
    },
  );

  it.each([false, true])(
    "preserves the lease and error when the wait bound expires (other host: %s)",
    async (otherHost) => {
      let nowMs = 1001;
      let elapsedMs = 0;
      const lease = await acquireLease({ now: () => 1000, owner: "first" });
      if (otherHost) {
        overwriteStartupMigrationLeaseOwner(env, { host: "previous-pod" });
      }

      await expect(
        acquireLease({
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
      expect(elapsedMs).toBe(500);
      expect(hasActiveStartupMigrationLease({ env, nowMs })).toBe(true);
      lease.release();
    },
  );

  it("waits for an unknown prior-host owner to expire before acquiring its lease", async () => {
    const prior = await acquireLease({ now: () => 1000, owner: "prior" });
    overwriteStartupMigrationLeaseOwner(env, { host: "previous-pod" });
    let nowMs = 1000 + STARTUP_MIGRATION_LEASE_TTL_MS - 1;
    let elapsedMs = 0;
    const acquired = await acquireLease({
      owner: "replacement",
      timeoutMs: 500,
      pollIntervalMs: 250,
      now: () => nowMs,
      monotonicNow: () => elapsedMs,
      sleep: async (ms) => {
        expect(hasActiveStartupMigrationLease({ env, nowMs })).toBe(true);
        nowMs += ms;
        elapsedMs += ms;
      },
    });
    expect(elapsedMs).toBe(250);
    prior.release();
    expect(hasActiveStartupMigrationLease({ env, nowMs })).toBe(true);
    acquired.release();
  });

  it("reclaims an active startup migration lease whose owner process is gone", async () => {
    const deadPid = 2_147_483_647;
    const stale = await acquireLease({ now: () => 1000, owner: "stale", ownerPid: deadPid });

    expect(hasActiveStartupMigrationLease({ env, nowMs: 1001 })).toBe(false);

    const replacement = await acquireLease({
      owner: "replacement",
      now: () => 1001,
      timeoutMs: STARTUP_MIGRATION_LEASE_TTL_MS,
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
      const stale = await acquireLease({ now: () => 1000, owner: "stale" });

      // The owner PID is this live test process; only the recorded start identity is stale.
      overwriteStartupMigrationLeaseOwner(env, { startedAt: 1 });

      expect(hasActiveStartupMigrationLease({ env, nowMs: 1001 })).toBe(false);

      const replacement = await acquireLease({ now: () => 1001, owner: "replacement" });
      stale.release();
      expect(hasActiveStartupMigrationLease({ env, nowMs: 1002 })).toBe(true);
      replacement.release();
    },
  );

  it.each([false, true])(
    "renews startup migration leases while the owner is still running (admitted owner: %s)",
    async (admittedOwner) => {
      if (admittedOwner) {
        runOpenClawStateWriteTransaction(() => undefined, { env });
      }
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const lease = await acquireLease({ now: () => 1000, owner: "first" });

      const onActivity = vi.fn();
      expect(hasActiveStartupMigrationLease({ env, nowMs: 1001, onActivity })).toBe(true);
      lease.heartbeat({ nowMs: 300_000 });
      expect(hasActiveStartupMigrationLease({ env, nowMs: 301_001, onActivity })).toBe(true);
      expect(onActivity).toHaveBeenLastCalledWith({
        owner: "first",
        pid: process.pid,
        heartbeatAt: 300_000,
      });

      await expect(acquireLease({ now: () => 301_001, owner: "second" })).rejects.toThrow(
        "OpenClaw startup migrations are already running",
      );

      lease.release();
      expect(hasActiveStartupMigrationLease({ env, nowMs: 301_002, onActivity })).toBe(false);
      expect(onActivity).toHaveBeenCalledTimes(2);
      if (admittedOwner) {
        expect(
          prepare.mock.calls.filter(([sql]) =>
            /\b(?:integrity_check|foreign_key_check)\b/i.test(sql),
          ),
        ).toHaveLength(0);
      }
    },
  );

  it("checks exact lease ownership inside the caller write transaction", async () => {
    const nowMs = Date.now();
    const first = await acquireLease({ now: () => nowMs, owner: "first" });
    const second = await acquireLease({
      now: () => nowMs + STARTUP_MIGRATION_LEASE_TTL_MS + 1,
      owner: "second",
    });

    runOpenClawStateWriteTransaction(
      ({ db }) => {
        expect(() => first.assertOwnedInTransaction(db)).toThrow(
          "startup migration lease was lost",
        );
        expect(() => second.assertOwnedInTransaction(db)).not.toThrow();
        expect(() => first.assertOwned()).toThrow("startup migration lease was lost");
        expect(() => second.assertOwned()).not.toThrow();
        const replaceOwner = (owner: string) =>
          db
            .prepare(
              "UPDATE state_leases SET owner = ? WHERE scope = 'startup-migrations' AND lease_key = 'global'",
            )
            .run(owner);
        replaceOwner("reassigned-before-commit");
        expect(() => second.assertOwned()).toThrow("startup migration lease was lost");
        replaceOwner(second.owner);
      },
      { env },
    );

    first.release();
    second.release();
  });

  it("acquires a lease without requiring the full state schema to be canonical", async () => {
    seedDatabase((db) =>
      db.exec(`
      CREATE TABLE agent_databases (
        agent_id TEXT NOT NULL PRIMARY KEY,
        path TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        size_bytes INTEGER
      );
    `),
    );

    const lease = await acquireLease({ now: () => 1000, owner: "first" });
    expect(readRow("PRAGMA user_version")).toEqual({ user_version: 0 });
    lease.release();
  });

  it("refuses future-version state databases before creating lease tables", async () => {
    seedDatabase((db) => db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`));

    await expect(acquireLease({ now: () => 1000, owner: "first" })).rejects.toThrow(
      `newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`,
    );

    expect(
      readRow("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'state_leases'"),
    ).toBeUndefined();
  });
});
