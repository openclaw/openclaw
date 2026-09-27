import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as pidAlive from "../shared/pid-alive.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  repairOpenClawStateDatabaseSchema,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as leaseHeartbeat from "../state/openclaw-state-lease-heartbeat.js";
import { renewOpenClawStateLeaseInTransaction } from "../state/openclaw-state-lease-store.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import {
  acquireGatewayOwnerLease,
  readGatewayOwnerLease,
  type GatewayOwnerLease,
} from "./gateway-owner-lease.js";
import { tryAcquireExclusiveSqliteCoordinator } from "./sqlite-coordinator.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import * as lifecycleCoordinators from "./state-database-coordinator.js";
import {
  acquireGatewayLifecycleCoordinator,
  acquireStateDatabaseHandleExclusion,
} from "./state-database-coordinator.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

function fixture() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-gateway-owner-") };
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const coordinator = acquireGatewayLifecycleCoordinator({ databasePath });
  return { env, databasePath, coordinator };
}

function seedOwner(
  env: NodeJS.ProcessEnv,
  params: { pid?: number; host?: string; startedAt?: number | null; expiresAt?: number } = {},
) {
  withOpenClawStateStartupMigrationCheckpointDatabase(
    (db) => {
      db.prepare(
        `INSERT INTO state_leases
         (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
         VALUES ('gateway-owner', 'global', 'previous-generation', ?, ?, ?, ?, ?)`,
      ).run(
        params.expiresAt ?? Date.now() + 300_000,
        Date.now(),
        JSON.stringify({
          owner: {
            pid: params.pid ?? process.pid,
            host: params.host ?? hostname(),
            startedAt:
              params.startedAt === undefined
                ? pidAlive.getFileLockProcessStartTime(process.pid)
                : params.startedAt,
          },
          port: 19483,
          mode: "foreground",
          supervisor: null,
        }),
        Date.now(),
        Date.now(),
      );
    },
    { env },
  );
}

describe("Gateway owner lease", () => {
  it.each([
    { label: "replacement generation", owner: "replacement", startedAt: null },
    { label: "already recorded identity", owner: "previous-generation", startedAt: 1 },
    { label: "expired generation", owner: "previous-generation", startedAt: null, expired: true },
  ])("does not repair the process identity of an $label", ({ owner, startedAt, expired }) => {
    const { env, coordinator } = fixture();
    try {
      seedOwner(env, { startedAt, ...(expired ? { expiresAt: Date.now() - 1 } : {}) });
      withOpenClawStateStartupMigrationCheckpointDatabase(
        (db) => {
          db.prepare("UPDATE state_leases SET owner = ? WHERE scope = 'gateway-owner'").run(owner);
          const before = readGatewayOwnerLease({ env });
          runSqliteImmediateTransactionSync(db, () =>
            renewOpenClawStateLeaseInTransaction(
              db,
              { scope: "gateway-owner", key: "global", owner: "previous-generation" },
              300_000,
              { pid: process.pid, host: hostname(), startedAt: 2 },
            ),
          );
          expect(readGatewayOwnerLease({ env })).toEqual(before);
        },
        { env },
      );
    } finally {
      coordinator.release();
    }
  });

  it("retries a transient own-process identity lookup before publishing", async () => {
    const { env, coordinator } = fixture();
    const readStartTime = pidAlive.getFileLockProcessStartTime;
    vi.spyOn(pidAlive, "getFileLockProcessStartTime")
      .mockReturnValueOnce(null)
      .mockImplementation(readStartTime);
    let lease: GatewayOwnerLease | undefined;
    try {
      lease = acquireGatewayOwnerLease({ env, port: 19483, mode: "foreground", supervisor: null });
      await lease.ready;
      expect(readGatewayOwnerLease({ env })?.state).toBe("live");
    } finally {
      await lease?.release();
      coordinator.release();
    }
  });

  it("repairs a missing publication identity on heartbeat and becomes live", async () => {
    const { env, coordinator } = fixture();
    const startHeartbeat = leaseHeartbeat.startOpenClawStateLeaseHeartbeat;
    vi.spyOn(leaseHeartbeat, "startOpenClawStateLeaseHeartbeat").mockImplementation((params) =>
      startHeartbeat({ ...params, heartbeatMs: 100 }),
    );
    const lookup = vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(null);
    let lease: GatewayOwnerLease | undefined;
    try {
      lease = acquireGatewayOwnerLease({ env, port: 19483, mode: "foreground", supervisor: null });
      expect(readGatewayOwnerLease({ env })).toMatchObject({ startedAt: null, state: "unknown" });
      lookup.mockRestore();
      await lease.ready;
      await expect.poll(() => readGatewayOwnerLease({ env })?.state).toBe("live");
      expect(readGatewayOwnerLease({ env })).toMatchObject({
        owner: lease.owner,
        startedAt: pidAlive.getFileLockProcessStartTime(process.pid),
      });
    } finally {
      await lease?.release();
      coordinator.release();
    }
  });

  it("records the Gateway owner before listening and releases its identity with the lock", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-gateway-owner-publication-") };
    const lock = await acquireGatewayLock({
      env,
      allowInTests: true,
      port: 18789,
      listenerMode: "foreground",
    });
    if (!lock) {
      throw new Error("Expected gateway lock");
    }
    try {
      expect(readGatewayOwnerLease({ env })).toMatchObject({
        pid: process.pid,
        port: 18789,
        mode: "foreground",
        supervisor: null,
        state: "live",
        expired: false,
      });
    } finally {
      await lock.release();
    }
    expect(readGatewayOwnerLease({ env })).toBeUndefined();
  });

  it("retains physical custody when heartbeat startup and cleanup both fail", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-gateway-owner-startup-failure-") };
    const acquire = lifecycleCoordinators.acquireGatewayLifecycleCoordinator;
    let coordinator: ReturnType<typeof acquire> | undefined;
    vi.spyOn(lifecycleCoordinators, "acquireGatewayLifecycleCoordinator").mockImplementation(
      (params) => {
        coordinator = acquire(params);
        return coordinator;
      },
    );
    vi.spyOn(leaseHeartbeat, "startOpenClawStateLeaseHeartbeat").mockImplementation(() => ({
      ready: Promise.reject(new Error("heartbeat startup failed")),
      assertRunning() {
        throw new Error("heartbeat startup failed");
      },
      async verify() {
        throw new Error("heartbeat startup failed");
      },
      async renew() {
        throw new Error("heartbeat startup failed");
      },
      close: () => undefined,
      stop: async () => {
        throw new Error("heartbeat cleanup retained native custody");
      },
      assertResponsive: () => undefined,
    }));
    try {
      await expect(
        acquireGatewayLock({
          allowInTests: true,
          env,
          port: 19483,
          listenerMode: "foreground",
        }),
      ).rejects.toThrow("heartbeat cleanup retained native custody");
      if (!coordinator) {
        throw new Error("Gateway did not acquire its lifecycle coordinator");
      }
      const contender = tryAcquireExclusiveSqliteCoordinator(coordinator.path);
      contender?.release();
      expect(contender).toBeNull();
    } finally {
      coordinator?.release();
    }
  });

  it("does not create shared state while looking for a previous Gateway", () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-gateway-owner-missing-") };
    expect(readGatewayOwnerLease({ env })).toBeUndefined();
    expect(existsSync(resolveOpenClawStateSqlitePath(env))).toBe(false);
  });

  it("publishes a readable owner while holding the physical coordinator and releases both pins", async () => {
    const { env, databasePath, coordinator } = fixture();
    let lease: GatewayOwnerLease | undefined;
    try {
      lease = acquireGatewayOwnerLease({
        env,
        port: 19483,
        mode: "foreground",
        supervisor: null,
        owner: "gateway-generation",
      });
      await lease.ready;
      expect(tryAcquireExclusiveSqliteCoordinator(coordinator.path)).toBeNull();
      expect(readGatewayOwnerLease({ env })).toEqual({
        owner: "gateway-generation",
        pid: process.pid,
        host: hostname(),
        startedAt: pidAlive.getFileLockProcessStartTime(process.pid),
        port: 19483,
        mode: "foreground",
        supervisor: null,
        state: "live",
        expired: false,
      });
      expect(readGatewayOwnerLease({ env, port: 19484 })).toBeUndefined();
      const heartbeat = withOpenClawStateStartupMigrationCheckpointDatabase(
        (db) =>
          db
            .prepare(
              "SELECT created_at, heartbeat_at FROM state_leases WHERE scope = 'gateway-owner'",
            )
            .get(),
        { env },
      );
      expect(Number(heartbeat?.heartbeat_at)).toBeGreaterThan(Number(heartbeat?.created_at));

      expect(repairOpenClawStateDatabaseSchema({ env }).warnings).toEqual([]);
      await closeOpenClawStateDatabaseAsync();
      expect(readGatewayOwnerLease({ env })?.owner).toBe("gateway-generation");

      await lease.release();
      expect(readGatewayOwnerLease({ env })).toBeUndefined();
      const exclusion = acquireStateDatabaseHandleExclusion({ databasePath, busyTimeoutMs: 0 });
      exclusion.release();
    } finally {
      await lease?.release();
      coordinator.release();
    }
  });

  it.each([
    { label: "dead", pid: 2_147_483_647, startedAt: 1 },
    { label: "recycled", pid: process.pid, startedAt: 1 },
  ])(
    "reclaims an unexpired $label owner without waiting for its lease deadline",
    async (previous) => {
      const { env, coordinator } = fixture();
      let lease: GatewayOwnerLease | undefined;
      try {
        seedOwner(env, previous);
        expect(readGatewayOwnerLease({ env })).toMatchObject({ state: "dead", expired: false });
        lease = acquireGatewayOwnerLease({
          env,
          port: 19483,
          mode: "supervised",
          supervisor: { kind: "schtasks", name: "OpenClaw Gateway" },
        });
        await lease.ready;
        expect(readGatewayOwnerLease({ env })).toMatchObject({
          owner: lease.owner,
          pid: process.pid,
          mode: "supervised",
          state: "live",
        });
      } finally {
        await lease?.release();
        coordinator.release();
      }
    },
  );

  it("preserves a slow live owner after the lease deadline instead of declaring it stale", () => {
    const { env, coordinator } = fixture();
    try {
      seedOwner(env, { expiresAt: Date.now() - 1 });
      expect(readGatewayOwnerLease({ env })).toMatchObject({
        owner: "previous-generation",
        state: "live",
        expired: true,
      });
      expect(readGatewayOwnerLease({ env })?.owner).toBe("previous-generation");
    } finally {
      coordinator.release();
    }
  });

  it.each([
    { label: "foreign host", host: "other-gateway-host" },
    { label: "missing start identity", startedAt: null },
  ])("preserves an unverifiable $label owner", (previous) => {
    const { env, coordinator } = fixture();
    try {
      seedOwner(env, previous);
      expect(readGatewayOwnerLease({ env })).toMatchObject({ state: "unknown", expired: false });
      expect(() =>
        acquireGatewayOwnerLease({ env, port: 19483, mode: "foreground", supervisor: null }),
      ).toThrow("Another Gateway owner lease is still active");
      expect(readGatewayOwnerLease({ env })?.owner).toBe("previous-generation");
    } finally {
      coordinator.release();
    }
  });

  it("keeps an unreadable process start identity unknown", () => {
    const { env, coordinator } = fixture();
    try {
      seedOwner(env);
      vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(null);
      expect(readGatewayOwnerLease({ env })?.state).toBe("unknown");
    } finally {
      coordinator.release();
    }
  });

  it("does not delete a replacement generation during an older owner's release", async () => {
    const { env, coordinator } = fixture();
    let lease: GatewayOwnerLease | undefined;
    try {
      lease = acquireGatewayOwnerLease({ env, port: 19483, mode: "foreground", supervisor: null });
      await lease.ready;
      withOpenClawStateStartupMigrationCheckpointDatabase(
        (db) => {
          db.prepare(
            "UPDATE state_leases SET owner = 'replacement' WHERE scope = 'gateway-owner'",
          ).run();
        },
        { env },
      );
      await lease.release();
      expect(readGatewayOwnerLease({ env })?.owner).toBe("replacement");
    } finally {
      await lease?.release();
      coordinator.release();
    }
  });
});
