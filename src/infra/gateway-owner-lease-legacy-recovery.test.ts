import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as pidAlive from "../shared/pid-alive.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { readGatewayLockProcessNamespace } from "./gateway-lock-payload.js";
import { acquireGatewayLock, resolveGatewayLockPaths } from "./gateway-lock.js";
import {
  acquireGatewayOwnerLease,
  readGatewayOwnerLease,
  type GatewayOwnerLease,
} from "./gateway-owner-lease.js";
import { acquireGatewayStateOwner } from "./gateway-state-owner.js";
import { requireNodeSqlite } from "./node-sqlite.js";

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
      processNamespace: readGatewayLockProcessNamespace(),
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
  {
    pid = process.pid,
    host = hostname(),
    startedAt = pidAlive.getFileLockProcessStartTime(process.pid),
    expiresAt = Date.now() + 300_000,
    heartbeatAt = Date.now(),
    processNamespace = readGatewayLockProcessNamespace(),
  }: {
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
        expiresAt,
        heartbeatAt,
        JSON.stringify({
          owner: { pid, host, processNamespace, startedAt },
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

async function seedClosedOwner(
  params: Parameters<typeof seedOwner>[1] = {},
  setup?: (env: NodeJS.ProcessEnv) => void,
) {
  let env: NodeJS.ProcessEnv;
  {
    await using owner = fixture();
    env = owner.env;
    seedOwner(env, params);
    setup?.(env);
  }
  await closeOpenClawStateDatabaseAsync();
  return env;
}

function acquireLock(
  env: NodeJS.ProcessEnv,
  params: Partial<Parameters<typeof acquireGatewayLock>[0]> = {},
) {
  return acquireGatewayLock({
    env,
    allowInTests: true,
    port: 19483,
    listenerMode: "foreground",
    ...params,
  });
}

describe("legacy Gateway owner lease recovery", () => {
  it.skipIf(process.platform !== "linux").each(["expired", "missing"] as const)(
    "preserves a namespace-less legacy Gateway lock when its matching lease is %s",
    async (kind) => {
      const env = await seedClosedOwner({}, (stateEnv) => {
        withOpenClawStateStartupMigrationCheckpointDatabase(
          (db) => {
            db.prepare(
              "UPDATE state_leases SET payload_json = json_remove(payload_json, '$.owner.processNamespace') WHERE scope = 'gateway-owner'",
            ).run();
          },
          { env: stateEnv },
        );
      });
      const databasePath = resolveOpenClawStateSqlitePath(env);
      const paths = resolveGatewayLockPaths(env);
      const payload = {
        pid: 2_147_483_647,
        ownerId: "previous-generation",
        role: "gateway",
        createdAt: new Date(Date.now() - 300_001).toISOString(),
        configPath: paths.configPath,
        stateDir: paths.stateDir,
      };
      fs.mkdirSync(path.dirname(paths.ownerLockPath), { recursive: true });
      const writeLocks = (value: object) => {
        for (const file of [paths.ownerLockPath, paths.stateLockPath]) {
          fs.writeFileSync(file, JSON.stringify(value));
        }
      };
      const acquire = () => acquireLock(env, { role: "sqlite-maintenance", timeoutMs: 0 });
      writeLocks(payload);
      const old = new Date(Date.now() - 600_000);
      fs.utimesSync(paths.ownerLockPath, old, old);
      await expect(acquire()).rejects.toThrow("cannot verify Gateway ownership");

      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(databasePath);
      try {
        if (kind === "missing") {
          db.prepare("DELETE FROM state_leases WHERE scope = 'gateway-owner'").run();
        } else {
          db.prepare("UPDATE state_leases SET expires_at = ? WHERE scope = 'gateway-owner'").run(
            Date.now() - 1,
          );
        }
      } finally {
        db.close();
      }
      writeLocks(payload);
      await expect(acquire()).rejects.toThrow("cannot verify Gateway ownership");
      await expect(acquire()).rejects.toThrow("openclaw gateway recover-lock --json");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "admits maintenance after an expired legacy Gateway lease without leftover lock files",
    async () => {
      const env = await seedClosedOwner({ expiresAt: Date.now() - 1 }, (stateEnv) => {
        withOpenClawStateStartupMigrationCheckpointDatabase(
          (db) => {
            db.prepare(
              "UPDATE state_leases SET payload_json = json_remove(payload_json, '$.owner.processNamespace') WHERE scope = 'gateway-owner'",
            ).run();
          },
          { env: stateEnv },
        );
      });
      const owner = await acquireLock(env, { role: "sqlite-maintenance", timeoutMs: 0 });
      expect(owner).not.toBeNull();
      await owner?.release();
    },
  );

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
      const startup = acquireLock(env, {
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
      await expect(startup).rejects.toThrow("cannot verify Gateway ownership from this process");
      expect(readGatewayOwnerLease({ env })?.owner).toBe("previous-generation");
      expect(now - began).toBe(95_000);
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
});
