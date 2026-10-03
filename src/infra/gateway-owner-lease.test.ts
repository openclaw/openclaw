import fs, { existsSync, renameSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withDoctorSqliteMaintenanceLock } from "../commands/doctor-sqlite-maintenance-lock.js";
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
import {
  GATEWAY_OWNER_HEARTBEAT_STALE_MS,
  readGatewayLockProcessNamespace,
} from "./gateway-lock-payload.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import {
  acquireGatewayOwnerLease,
  readGatewayOwnerLease,
  type GatewayOwnerLease,
} from "./gateway-owner-lease.js";
import * as ownerLeaseRead from "./gateway-owner-lease.read.js";
import * as stateOwners from "./gateway-state-owner.js";
import { acquireGatewayStateOwner, tryAcquireGatewayStateOwner } from "./gateway-state-owner.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import * as bootReader from "./update-managed-service-handoff-boot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

function fixture() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-gateway-owner-") };
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const coordinator = acquireGatewayStateOwner({
    databasePath,
    payload: {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      configPath: path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"),
      role: "gateway",
    },
  });
  let lease: GatewayOwnerLease | undefined;
  return {
    env,
    acquire(params: Partial<Omit<Parameters<typeof acquireGatewayOwnerLease>[0], "env">> = {}) {
      lease = acquireGatewayOwnerLease({
        env,
        port: 19483,
        mode: "foreground",
        supervisor: null,
        ...params,
      });
      return lease;
    },
    async [Symbol.asyncDispose]() {
      try {
        await lease?.ready;
      } finally {
        await lease?.release();
        coordinator.release();
      }
    },
  };
}

function seedOwner(
  env: NodeJS.ProcessEnv,
  params: {
    pid?: number;
    host?: string;
    startedAt?: number | null;
    expiresAt?: number | null;
    heartbeatAt?: number;
    processNamespace?: unknown;
  } = {},
) {
  withOpenClawStateStartupMigrationCheckpointDatabase(
    (db) => {
      db.prepare(
        `INSERT INTO state_leases
         (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
         VALUES ('gateway-owner', 'global', 'previous-generation', ?, ?, ?, ?, ?)`,
      ).run(
        params.expiresAt === undefined ? Date.now() + 300_000 : params.expiresAt,
        params.heartbeatAt ?? Date.now(),
        JSON.stringify({
          owner: {
            pid: params.pid ?? process.pid,
            host: params.host ?? hostname(),
            ...(params.processNamespace === undefined
              ? {}
              : { processNamespace: params.processNamespace }),
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

function mockLinuxNamespace(root: string) {
  if (process.platform !== "linux") {
    vi.spyOn(bootReader, "createManagedHandoffBootIdentityReader").mockReturnValue(() => ({
      platform: "linux",
      identity: "01234567-89ab-cdef-0123-456789abcdef",
    }));
    const stat = fs.statSync.bind(fs);
    vi.spyOn(fs, "statSync").mockImplementation((file, options) =>
      stat(file === "/proc/self/ns/pid" ? root : file, options),
    );
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    readGatewayLockProcessNamespace();
    platform.mockRestore();
  }
  const namespace = readGatewayLockProcessNamespace();
  if (!namespace || !("pidNsInode" in namespace)) {
    throw new Error("Expected Linux process namespace identity");
  }
  return namespace;
}

function readFreshProcessNamespace() {
  const otherPlatform = process.platform === "linux" ? "darwin" : "linux";
  const platform = vi.spyOn(process, "platform", "get").mockReturnValue(otherPlatform);
  readGatewayLockProcessNamespace();
  platform.mockRestore();
  return readGatewayLockProcessNamespace();
}

describe("Gateway owner lease", () => {
  it("reclaims when the heartbeat becomes stale after the initial observation", async () => {
    await using owner = fixture();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    seedOwner(owner.env, {
      host: "previous-container",
      heartbeatAt: now - GATEWAY_OWNER_HEARTBEAT_STALE_MS,
    });
    const read = ownerLeaseRead.readGatewayOwnerLeaseFromDatabase;
    const observations: Array<ReturnType<typeof read>> = [];
    vi.spyOn(ownerLeaseRead, "readGatewayOwnerLeaseFromDatabase").mockImplementation((...args) => {
      const previous = read(...args);
      observations.push(previous);
      now += 1;
      return previous;
    });
    const lease = owner.acquire();
    await lease.ready;
    expect(observations[0]?.state).toBe("unknown");
    expect(readGatewayOwnerLease({ env: owner.env })).toMatchObject({
      owner: lease.owner,
      state: "live",
    });
  });

  it.each(["legacy", "qualified"] as const)(
    "reclaims a crashed container's %s lease after its heartbeat goes stale",
    async (kind) => {
      await using owner = fixture();
      const namespace = mockLinuxNamespace(owner.env.OPENCLAW_STATE_DIR);
      seedOwner(owner.env, {
        host: "previous-container",
        pid: 2_147_483_647,
        expiresAt: null,
        heartbeatAt: Date.now() - GATEWAY_OWNER_HEARTBEAT_STALE_MS - 1,
        ...(kind === "qualified"
          ? {
              processNamespace: { ...namespace, host: "previous-container", pidNsInode: "foreign" },
            }
          : {}),
      });
      const lease = owner.acquire();
      await lease.ready;
      expect(readGatewayOwnerLease({ env: owner.env })).toMatchObject({
        owner: lease.owner,
        state: "live",
      });
    },
  );

  it.each([
    { age: 0, pid: process.pid },
    { age: 0, pid: 2_147_483_647 },
    { age: GATEWAY_OWNER_HEARTBEAT_STALE_MS, pid: 2_147_483_647 },
  ])(
    "preserves a foreign namespace with a $age ms heartbeat regardless of local PID $pid",
    async ({ age, pid }) => {
      await using owner = fixture();
      const namespace = mockLinuxNamespace(owner.env.OPENCLAW_STATE_DIR);
      vi.spyOn(Date, "now").mockReturnValue(Date.now());
      seedOwner(owner.env, {
        pid,
        processNamespace: { ...namespace, pidNsInode: "foreign" },
        heartbeatAt: Date.now() - age,
      });
      expect(() => owner.acquire()).toThrow(
        "run this command inside the Gateway container or with a shared PID namespace",
      );
      expect(readGatewayOwnerLease({ env: owner.env })).toMatchObject({
        owner: "previous-generation",
        state: "unknown",
      });
    },
  );

  it.each([
    { label: "unavailable", processNamespace: null },
    { label: "invalid", processNamespace: { platform: "unknown" } },
  ])(
    "preserves a fresh foreign host with $label namespace identity",
    async ({ processNamespace }) => {
      await using owner = fixture();
      seedOwner(owner.env, { host: "previous-container", pid: 2_147_483_647, processNamespace });
      expect(() => owner.acquire()).toThrow("owner heartbeat is fresh");
      expect(readGatewayOwnerLease({ env: owner.env })?.owner).toBe("previous-generation");
    },
  );

  it.each(["local identity unavailable", "different host boot"] as const)(
    "preserves a fresh foreign lease when its namespace is not comparable: %s",
    async (condition) => {
      await using owner = fixture();
      const namespace = readFreshProcessNamespace();
      if (!namespace) {
        throw new Error("Expected the test host's boot identity");
      }
      seedOwner(owner.env, {
        host: "previous-container",
        pid: 2_147_483_647,
        processNamespace: {
          ...namespace,
          host: "previous-container",
          ...(condition === "different host boot"
            ? {
                identity:
                  namespace.platform === "win32"
                    ? "2000-01-01T00:00:00.0000000Z"
                    : namespace.platform === "freebsd"
                      ? "00000000000000000000000000000000"
                      : "87654321-abcd-0123-abcd-0123456789ab",
              }
            : {}),
        },
      });
      const failedProbe = vi.fn(() => {
        throw new Error("boot identity unavailable");
      });
      if (condition === "local identity unavailable") {
        vi.spyOn(bootReader, "createManagedHandoffBootIdentityReader").mockReturnValue(failedProbe);
        const otherPlatform = process.platform === "linux" ? "darwin" : "linux";
        const platform = vi.spyOn(process, "platform", "get").mockReturnValue(otherPlatform);
        readGatewayLockProcessNamespace();
        platform.mockRestore();
      }
      try {
        expect(() => owner.acquire()).toThrow("owner heartbeat is fresh");
        expect(readGatewayOwnerLease({ env: owner.env })?.owner).toBe("previous-generation");
        if (condition === "local identity unavailable") {
          expect(failedProbe).toHaveBeenCalled();
        }
      } finally {
        vi.restoreAllMocks();
        readFreshProcessNamespace();
      }
    },
  );

  it("Doctor refuses a fresh foreign lease and names the heartbeat wait", async () => {
    let env: NodeJS.ProcessEnv;
    {
      await using owner = fixture();
      env = owner.env;
      seedOwner(env, { host: "previous-container" });
    }
    const run = vi.fn();
    await expect(
      withDoctorSqliteMaintenanceLock({ env, operation: "state repair", run }),
    ).rejects.toThrow("wait up to 90 seconds");
    expect(run).not.toHaveBeenCalled();
    expect(readGatewayOwnerLease({ env })?.owner).toBe("previous-generation");
  });

  it.each([false, true])(
    "startup waits at most 95 seconds for an unverifiable lease (renewing=%s)",
    async (renewing) => {
      let env: NodeJS.ProcessEnv;
      let now = Date.now();
      const began = now;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      {
        await using owner = fixture();
        env = owner.env;
        seedOwner(env, { host: "previous-container" });
      }
      const startup = acquireGatewayLock({
        env,
        allowInTests: true,
        port: 19483,
        listenerMode: "foreground",
        now: () => now,
        sleep: async (ms) => {
          expect(ms).toBe(5_000);
          // Resume at the deadline without repeatedly booting physical heartbeat workers.
          now = began + 95_000;
          if (renewing) {
            withOpenClawStateStartupMigrationCheckpointDatabase(
              (db) => {
                db.prepare(
                  "UPDATE state_leases SET heartbeat_at = ? WHERE scope = 'gateway-owner'",
                ).run(now);
              },
              { env },
            );
          }
        },
      });
      if (renewing) {
        await expect(startup).rejects.toThrow("owner heartbeat is fresh");
        expect(readGatewayOwnerLease({ env })?.owner).toBe("previous-generation");
      } else {
        const lock = await startup;
        try {
          expect(readGatewayOwnerLease({ env })).toMatchObject({ pid: process.pid, state: "live" });
        } finally {
          await lock?.release();
        }
      }
      expect(now - began).toBe(95_000);
    },
  );

  it.each([
    { label: "replacement generation", owner: "replacement", startedAt: null },
    { label: "already recorded identity", owner: "previous-generation", startedAt: 1 },
    { label: "expired generation", owner: "previous-generation", startedAt: null, expired: true },
  ])(
    "does not repair the process identity of an $label",
    async ({ owner: recordedOwner, startedAt, expired }) => {
      await using owner = fixture();
      const { env } = owner;
      seedOwner(env, { startedAt, ...(expired ? { expiresAt: Date.now() - 1 } : {}) });
      withOpenClawStateStartupMigrationCheckpointDatabase(
        (db) => {
          db.prepare("UPDATE state_leases SET owner = ? WHERE scope = 'gateway-owner'").run(
            recordedOwner,
          );
          const before = readGatewayOwnerLease({ env });
          runSqliteImmediateTransactionSync(db, () =>
            renewOpenClawStateLeaseInTransaction(
              db,
              { scope: "gateway-owner", key: "global", owner: "previous-generation" },
              300_000,
              { pid: process.pid, host: hostname(), startedAt: 2 },
            ),
          );
          expect(readGatewayOwnerLease({ env })).toEqual({
            ...before,
            heartbeatAt: expect.any(Number),
          });
        },
        { env },
      );
    },
  );

  it("retries a transient own-process identity lookup before publishing", async () => {
    await using owner = fixture();
    const { env } = owner;
    const readStartTime = pidAlive.getFileLockProcessStartTime;
    vi.spyOn(pidAlive, "getFileLockProcessStartTime")
      .mockReturnValueOnce(null)
      .mockImplementation(readStartTime);
    const lease = owner.acquire();
    await lease.ready;
    expect(readGatewayOwnerLease({ env })?.state).toBe("live");
  });

  it("repairs a missing publication identity on heartbeat and becomes live", async () => {
    await using owner = fixture();
    const { env } = owner;
    const startHeartbeat = leaseHeartbeat.startOpenClawStateLeaseHeartbeat;
    vi.spyOn(leaseHeartbeat, "startOpenClawStateLeaseHeartbeat").mockImplementation((params) =>
      startHeartbeat({ ...params, heartbeatMs: 100 }),
    );
    const lookup = vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(null);
    const lease = owner.acquire();
    expect(readGatewayOwnerLease({ env })).toMatchObject({ startedAt: null, state: "unknown" });
    lookup.mockRestore();
    await lease.ready;
    await expect.poll(() => readGatewayOwnerLease({ env })?.state).toBe("live");
    expect(readGatewayOwnerLease({ env })).toMatchObject({
      owner: lease.owner,
      startedAt: pidAlive.getFileLockProcessStartTime(process.pid),
    });
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
    const acquire = stateOwners.acquireGatewayStateOwner;
    let coordinator: ReturnType<typeof acquire> | undefined;
    vi.spyOn(stateOwners, "acquireGatewayStateOwner").mockImplementation((params) => {
      coordinator = acquire(params);
      return coordinator;
    });
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
        throw new Error("Gateway did not acquire its process owner");
      }
      const contender = tryAcquireGatewayStateOwner(resolveOpenClawStateSqlitePath(env));
      contender?.release();
      expect(contender).toBeNull();
    } finally {
      coordinator?.release();
    }
  });

  it("releases lost physical custody without changing its recorded lease", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-gateway-owner-lost-") };
    const acquire = stateOwners.acquireGatewayStateOwner;
    let coordinator: ReturnType<typeof acquire> | undefined;
    vi.spyOn(stateOwners, "acquireGatewayStateOwner").mockImplementation((params) => {
      coordinator = acquire(params);
      return coordinator;
    });
    const lock = await acquireGatewayLock({
      env,
      allowInTests: true,
      port: 19483,
      listenerMode: "foreground",
    });
    if (!lock) {
      throw new Error("Expected gateway lock");
    }
    try {
      const recorded = readGatewayOwnerLease({ env });
      expect(recorded).toBeDefined();
      renameSync(lock.lockPath, `${lock.lockPath}.retired`);
      expect(() => lock.assertCurrent()).toThrow("no longer current");
      await lock.release();
      expect(existsSync(lock.stateLockPath)).toBe(false);
      expect(readGatewayOwnerLease({ env })?.owner).toBe(recorded?.owner);
      const successor = tryAcquireGatewayStateOwner(resolveOpenClawStateSqlitePath(env));
      expect(successor).not.toBeNull();
      successor?.release();
    } finally {
      coordinator?.release();
    }
  });

  it("does not create shared state while looking for a previous Gateway", () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-gateway-owner-missing-") };
    expect(readGatewayOwnerLease({ env })).toBeUndefined();
    expect(existsSync(resolveOpenClawStateSqlitePath(env))).toBe(false);
  });

  it("publishes a readable owner while holding the physical process owner and releases its publication", async () => {
    await using owner = fixture();
    const { env } = owner;
    const lease = owner.acquire({ owner: "gateway-generation" });
    await lease.ready;
    expect(tryAcquireGatewayStateOwner(resolveOpenClawStateSqlitePath(env))).toBeNull();
    expect(readGatewayOwnerLease({ env })).toEqual({
      owner: "gateway-generation",
      pid: process.pid,
      host: hostname(),
      processNamespace: readGatewayLockProcessNamespace(),
      heartbeatAt: expect.any(Number),
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
    await closeOpenClawStateDatabaseAsync();
  });

  it.each([
    { label: "dead", pid: 2_147_483_647, startedAt: 1 },
    { label: "dead without expiry", pid: 2_147_483_647, startedAt: 1, expiresAt: null },
    { label: "recycled", pid: process.pid, startedAt: 1 },
  ])(
    "reclaims an unexpired $label owner without waiting for its lease deadline",
    async (previous) => {
      await using owner = fixture();
      const { env } = owner;
      seedOwner(env, previous);
      expect(readGatewayOwnerLease({ env })).toMatchObject({
        state: "dead",
        expired: previous.expiresAt === null,
      });
      const lease = owner.acquire({
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
    },
  );

  it("preserves a slow live owner after the lease deadline instead of declaring it stale", async () => {
    await using owner = fixture();
    const { env } = owner;
    seedOwner(env, {
      expiresAt: Date.now() - 1,
      heartbeatAt: Date.now() - GATEWAY_OWNER_HEARTBEAT_STALE_MS - 1,
      processNamespace: readGatewayLockProcessNamespace(),
    });
    expect(readGatewayOwnerLease({ env })).toMatchObject({
      owner: "previous-generation",
      state: "live",
      expired: true,
    });
    expect(() => owner.acquire()).toThrow("Another Gateway owner lease is still active");
  });

  it.each([
    { label: "foreign host", host: "other-gateway-host" },
    { label: "missing start identity", startedAt: null },
  ])("preserves an unverifiable $label owner", async (previous) => {
    await using owner = fixture();
    const { env } = owner;
    seedOwner(env, previous);
    expect(readGatewayOwnerLease({ env })).toMatchObject({ state: "unknown", expired: false });
    expect(() => owner.acquire()).toThrow(
      previous.label === "foreign host"
        ? "owner heartbeat is fresh"
        : "Another Gateway owner lease is still active",
    );
    expect(readGatewayOwnerLease({ env })?.owner).toBe("previous-generation");
  });

  it("keeps an unreadable process start identity unknown", async () => {
    await using owner = fixture();
    const { env } = owner;
    seedOwner(env);
    vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(null);
    expect(readGatewayOwnerLease({ env })?.state).toBe("unknown");
  });

  it("does not delete a replacement generation during an older owner's release", async () => {
    await using owner = fixture();
    const { env } = owner;
    const lease = owner.acquire();
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
  });
});
