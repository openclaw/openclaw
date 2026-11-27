// Tests that an unactionable lock timeout names the lock file the operator must inspect.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { acquireGatewayLock, resolveGatewayLockPaths } from "./gateway-lock.js";
import {
  acquireGatewayStateOwner,
  acquireStateDatabaseSchemaLease,
} from "./gateway-state-owner.js";

const fixtureRootTracker = createSuiteTempRootTracker({
  prefix: "openclaw-gateway-lock-unactionable-",
});

/**
 * Deterministic deadline control: `now` and `sleep` are the pair acquireGatewayLock
 * already takes, so the poll loop advances virtual time instead of waiting. It starts
 * from the real clock so staleness checks against real lock files stay meaningful.
 */
function createDeadlineClock() {
  let currentMs = Date.now();
  return {
    now: () => currentMs,
    sleep: async (ms: number) => {
      currentMs += ms;
    },
  };
}

async function pathExists(target: string): Promise<boolean> {
  return fs
    .access(target)
    .then(() => true)
    .catch(() => false);
}

async function makeCase() {
  const stateDir = await fixtureRootTracker.make("case");
  const lockDir = path.join(stateDir, "__locks");
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(configPath, "{}", "utf8");
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
  };
  return { env, lockDir, ...resolveGatewayLockPaths(env, lockDir) };
}

function attemptLock({
  env,
  lockDir,
}: Pick<Awaited<ReturnType<typeof makeCase>>, "env" | "lockDir">) {
  const clock = createDeadlineClock();
  return acquireGatewayLock({
    allowInTests: true,
    env,
    lockDir,
    role: "sqlite-maintenance",
    timeoutMs: 250,
    pollIntervalMs: 25,
    now: clock.now,
    sleep: clock.sleep,
  });
}

describe("Gateway lock timeout diagnostics", () => {
  beforeAll(async () => {
    await fixtureRootTracker.setup();
  });

  afterAll(async () => {
    await fixtureRootTracker.cleanup();
  });

  it.each([
    { kind: "schema", releaseOnWait: true, expectedWaits: 1 },
    { kind: "schema", releaseOnWait: false, expectedWaits: 2 },
    { kind: "offline", releaseOnWait: false, expectedWaits: 0 },
  ])(
    "waits only for transient schema custody ($kind, releases: $releaseOnWait)",
    async ({ kind, releaseOnWait, expectedWaits }) => {
      const { env, lockDir, stateDir } = await makeCase();
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      const holder =
        kind === "schema"
          ? acquireStateDatabaseSchemaLease(databasePath)
          : acquireGatewayStateOwner({ databasePath });
      const clock = createDeadlineClock();
      let waits = 0;
      try {
        const attempt = acquireGatewayLock({
          waitForTransientSchemaOwner: true,
          allowInTests: true,
          env,
          lockDir,
          role: "sqlite-maintenance",
          timeoutMs: 50,
          pollIntervalMs: 25,
          now: clock.now,
          sleep: async (ms) => {
            waits += 1;
            if (releaseOnWait) {
              holder.release();
            }
            await clock.sleep(ms);
          },
        });
        if (releaseOnWait) {
          const lock = await attempt;
          try {
            expect(lock).not.toBeNull();
          } finally {
            await lock?.release();
          }
        } else {
          await expect(attempt).rejects.toThrow("state database is busy");
        }
        expect(waits).toBe(expectedWaits);
      } finally {
        if (!releaseOnWait || waits === 0) {
          holder.release();
        }
      }
    },
  );

  it("names the process owner sidecar when a held owner cannot be verified", async () => {
    const { env, lockDir, stateDir, ownerLockPath, stateLockPath } = await makeCase();
    // Primary-only holder: the process owner sidecar, without the compatibility
    // projection that a fully acquired Gateway lock publishes beside it. This is
    // the lifecycle that made the diagnostic name a `gateway.state.lock` nothing
    // ever wrote, so the assertion below pins the sidecar that really blocked.
    const holder = acquireGatewayStateOwner({
      databasePath: path.join(stateDir, "state", "openclaw.sqlite"),
    });
    expect(await pathExists(stateLockPath)).toBe(false);

    try {
      // withLegacyMigrationStateLock budgets: 250 ms to win, poll every 25 ms.
      const attempt = attemptLock({ env, lockDir });
      await expect(attempt).rejects.toThrow(ownerLockPath);
    } finally {
      holder.release();
    }
  });

  it.each(["stateLockPath", "configLockPath"] as const)(
    "names %s when its recorded owner cannot be verified",
    async (lockKey) => {
      const fixture = await makeCase();
      const { env, lockDir, configPath, stateDir } = fixture;
      const lockPath = fixture[lockKey];
      await fs.mkdir(lockDir, { recursive: true });
      // Keep the primary sidecar free so it cannot mask either historical lock.
      // A live but unverifiable recorded owner must remain unreclaimed.
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
          configPath,
          stateDir,
        }),
        "utf8",
      );
      await expect(attemptLock({ env, lockDir })).rejects.toThrow(lockPath);
    },
  );

  it("names the process owner sidecar when the failure never reached contention", async () => {
    // A failure that is not a GatewayStateOwnerContentionError never gets a lock
    // file attributed to it by the retry loop, so the message used to end at
    // "failed to acquire gateway state ownership" with nothing for the operator
    // to go and look at. Ownership lives in the process owner sidecar, so name it.
    const { env, lockDir, ownerLockPath } = await makeCase();
    await fs.mkdir(lockDir, { recursive: true });
    // A regular file where the owner lock directory belongs: creating it fails
    // with a filesystem error, which is not a contention error, so the loop
    // cannot name a path itself.
    await fs.mkdir(path.dirname(path.dirname(ownerLockPath)), { recursive: true });
    await fs.writeFile(path.dirname(ownerLockPath), "not a directory", "utf8");

    const attempt = attemptLock({ env, lockDir });
    await expect(attempt).rejects.toThrow(ownerLockPath);
  });

  it("names the state lock file left by a Gateway in another PID namespace", async () => {
    const { env, lockDir, stateLockPath, configPath, stateDir } = await makeCase();
    await fs.mkdir(lockDir, { recursive: true });
    // A containerized Gateway sharing this state dir records its own namespace,
    // so the strict payload check refuses it before any owner contention.
    await fs.writeFile(
      stateLockPath,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath,
        stateDir,
        role: "gateway",
        processNamespace: { platform: "linux", host: "gateway-container", pidNsInode: "1" },
      }),
      "utf8",
    );

    const attempt = attemptLock({ env, lockDir });
    await expect(attempt).rejects.toThrow(stateLockPath);
  });
});
