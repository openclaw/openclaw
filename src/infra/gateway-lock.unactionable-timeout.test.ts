// Tests that an unactionable lock timeout names the lock file the operator must inspect.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { acquireGatewayLock, resolveGatewayLockPaths } from "./gateway-lock.js";
import { acquireGatewayStateOwner } from "./gateway-state-owner.js";

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

// A live PID whose identity the inspector cannot confirm: `/proc` reads fail
// when the reader runs outside the container that wrote the lock, so the owner
// stays "unknown" and the lock is never reclaimed, whatever its age.
const unverifiableOwner = {
  readProcessCmdline: () => null,
  readProcessStartTime: () => null,
};

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

describe("Gateway lock timeout diagnostics", () => {
  beforeAll(async () => {
    await fixtureRootTracker.setup();
  });

  afterAll(async () => {
    await fixtureRootTracker.cleanup();
  });

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

    const clock = createDeadlineClock();
    try {
      // withLegacyMigrationStateLock budgets: 250 ms to win, poll every 25 ms.
      const attempt = acquireGatewayLock({
        allowInTests: true,
        env,
        lockDir,
        role: "sqlite-maintenance",
        timeoutMs: 250,
        pollIntervalMs: 25,
        staleMs: 10 * 60_000,
        now: clock.now,
        sleep: clock.sleep,
        ...unverifiableOwner,
      });
      await expect(attempt).rejects.toThrow(ownerLockPath);
    } finally {
      holder.release();
    }
  });

  it("names the state lock file when its recorded owner cannot be verified", async () => {
    const { env, lockDir, stateLockPath, configPath, stateDir } = await makeCase();
    await fs.mkdir(lockDir, { recursive: true });
    // A Gateway that exited without releasing leaves this payload behind. Its PID
    // is live, but the reader cannot confirm it, so the lock is never reclaimed.
    // The process owner sidecar stays free on purpose: acquireGatewayLock takes
    // it first, so a held owner would mask this call site.
    await fs.writeFile(
      stateLockPath,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath,
        stateDir,
      }),
      "utf8",
    );

    const clock = createDeadlineClock();
    const attempt = acquireGatewayLock({
      allowInTests: true,
      env,
      lockDir,
      role: "sqlite-maintenance",
      timeoutMs: 250,
      pollIntervalMs: 25,
      staleMs: 10 * 60_000,
      now: clock.now,
      sleep: clock.sleep,
      ...unverifiableOwner,
    });
    await expect(attempt).rejects.toThrow(stateLockPath);
  });

  it("names the config lock file when its recorded owner cannot be verified", async () => {
    const { env, lockDir, configLockPath, configPath, stateDir } = await makeCase();
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      configLockPath,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath,
        stateDir,
      }),
      "utf8",
    );

    const clock = createDeadlineClock();
    const attempt = acquireGatewayLock({
      allowInTests: true,
      env,
      lockDir,
      role: "sqlite-maintenance",
      timeoutMs: 250,
      pollIntervalMs: 25,
      staleMs: 10 * 60_000,
      now: clock.now,
      sleep: clock.sleep,
      ...unverifiableOwner,
    });
    await expect(attempt).rejects.toThrow(configLockPath);
  });

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

    const clock = createDeadlineClock();
    const attempt = acquireGatewayLock({
      allowInTests: true,
      env,
      lockDir,
      role: "sqlite-maintenance",
      timeoutMs: 250,
      pollIntervalMs: 25,
      staleMs: 10 * 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    await expect(attempt).rejects.toThrow(ownerLockPath);
  });
});
