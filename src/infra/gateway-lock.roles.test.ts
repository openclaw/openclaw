// Tests Gateway lock roles, lifecycle ownership, and active-port compatibility.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as nativeSleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  acquireGatewayLock,
  GatewayLockError,
  readActiveGatewayLockIdentity,
  readActiveGatewayLockPort,
} from "./gateway-lock.js";
import { acquireGatewayStateOwner } from "./gateway-state-owner.js";

const lifecycleChildren = new Map<ChildProcess, Promise<unknown[]>>();
const lifecycleDatabases = new Set<string>();
const fixtureRootTracker = createSuiteTempRootTracker({
  prefix: "openclaw-gateway-lock-workshop-",
});
let fixtureRoot = "";

async function holdLifecycleCoordinator() {
  const stateDir = await fixtureRootTracker.make("lifecycle-handoff");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  const coordinator = acquireGatewayStateOwner({ databasePath });
  lifecycleDatabases.add(databasePath);
  coordinator.release();
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { acquireFileLockSync } from "@openclaw/fs-safe/file-lock";
       const pathname = process.argv[1];
       const lock = acquireFileLockSync(pathname, {
         lockPath: pathname, retry: { retries: 0 },
         payload: () => ({ pid: process.pid, createdAt: new Date().toISOString(), configPath: "synthetic", role: "gateway" }),
       });
       process.on("message", () => {
         lock.release(); process.disconnect();
       });
       process.send("held");`,
      coordinator.path,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  lifecycleChildren.set(child, once(child, "close"));
  await withTestTimeout(once(child, "message"), 5_000, "coordinator fixture did not start");
  return {
    child,
    options: { env, allowInTests: true, lockDir: path.join(stateDir, "__locks") },
  };
}

describe("Gateway lock roles", () => {
  beforeAll(async () => {
    fixtureRoot = await fixtureRootTracker.setup();
  });

  afterAll(async () => {
    await fixtureRootTracker.cleanup();
    fixtureRoot = "";
  });

  afterEach(async () => {
    for (const child of lifecycleChildren.keys()) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    await Promise.all(lifecycleChildren.values());
    lifecycleChildren.clear();
    for (const databasePath of lifecycleDatabases) {
      acquireGatewayStateOwner({ databasePath }).release();
    }
    lifecycleDatabases.clear();
  });

  it("acquires when the predecessor releases during the startup wait", async () => {
    const { child, options } = await holdLifecycleCoordinator();
    const lock = await acquireGatewayLock({
      ...options,
      sleep: async () => {
        child.send("release");
        await lifecycleChildren.get(child);
      },
    });
    expect(lock).not.toBeNull();
    await lock?.release();
  });

  it("bounds a live owner's wait at five minutes and names state ownership", async () => {
    const { options } = await holdLifecycleCoordinator();
    let elapsedMs = 0;
    const sleep = vi.fn(async (ms: number) => {
      elapsedMs += ms;
    });
    await expect(acquireGatewayLock({ ...options, now: () => elapsedMs, sleep })).rejects.toThrow(
      "failed to acquire gateway state ownership; waited 300000ms for Gateway state ownership",
    );
    expect(elapsedMs).toBe(300_000);
    expect(sleep).toHaveBeenCalled();
  });

  it("keeps a live Workshop apply owner while Gateway startup races", async () => {
    const stateDir = await fixtureRootTracker.make("case");
    const lockDir = path.join(fixtureRoot, "__locks");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, "{}", "utf8");
    const env = {
      ...process.env,
      OPENCLAW_ALLOW_MULTI_GATEWAY: "1",
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const readProcessCmdline = () => ["openclaw", "skills", "workshop", "apply", "proposal-id"];
    const lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      lockDir,
      platform: "darwin",
      port: 18789,
      readProcessStartTime: () => null,
      role: "skill-workshop-apply",
      timeoutMs: 30,
    });
    expect(lock).not.toBeNull();
    if (!lock) {
      throw new Error("Expected Workshop Gateway lock");
    }

    try {
      expect(lock.lockPath).not.toBe(lock.stateLockPath);
      await expect(
        readActiveGatewayLockPort({
          env,
          lockDir,
          platform: "darwin",
          readProcessCmdline,
          readProcessStartTime: () => null,
        }),
      ).resolves.toBeUndefined();
      await expect(
        acquireGatewayLock({
          allowInTests: true,
          env,
          lockDir,
          platform: "darwin",
          port: 18789,
          pollIntervalMs: 2,
          readProcessCmdline,
          readProcessStartTime: () => null,
          sleep: nativeSleep,
          timeoutMs: 15,
        }),
      ).rejects.toBeInstanceOf(GatewayLockError);
    } finally {
      await lock.release();
    }
  });

  it("keeps an explicit Gateway role visible to active-port discovery", async () => {
    const stateDir = await fixtureRootTracker.make("gateway-role");
    const lockDir = path.join(fixtureRoot, "__locks");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, "{}", "utf8");
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      lockDir,
      platform: "darwin",
      port: 28789,
      readProcessStartTime: () => null,
      timeoutMs: 30,
    });
    expect(lock).not.toBeNull();
    if (!lock) {
      throw new Error("Expected Gateway lock");
    }

    const payload = JSON.parse(await fs.readFile(lock.lockPath, "utf8")) as Record<string, unknown>;
    expect(payload.role).toBe("gateway");
    try {
      await expect(
        readActiveGatewayLockPort({
          env,
          lockDir,
          platform: "darwin",
          readProcessCmdline: () => ["openclaw-gateway"],
          readProcessStartTime: () => null,
        }),
      ).resolves.toBe(28789);
    } finally {
      await lock.release();
    }
  });

  it("keeps agent-embedded ownership distinct from a running Gateway", async () => {
    const stateDir = await fixtureRootTracker.make("agent-embedded-role");
    const lockDir = path.join(fixtureRoot, "__locks");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, "{}", "utf8");
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const readProcessCmdline = () => ["openclaw", "agent", "--local", "--message", "hello"];
    const lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      lockDir,
      platform: "darwin",
      port: 28789,
      readProcessCmdline,
      readProcessStartTime: () => null,
      role: "agent-embedded",
      timeoutMs: 30,
    });
    expect(lock).not.toBeNull();
    if (!lock) {
      throw new Error("Expected embedded agent Gateway lock");
    }

    try {
      await expect(
        readActiveGatewayLockIdentity({
          env,
          lockDir,
          platform: "darwin",
          readProcessCmdline,
          readProcessStartTime: () => null,
        }),
      ).resolves.toBeUndefined();
      await expect(
        acquireGatewayLock({
          allowInTests: true,
          env,
          lockDir,
          platform: "darwin",
          pollIntervalMs: 2,
          readProcessCmdline,
          readProcessStartTime: () => null,
          sleep: nativeSleep,
          timeoutMs: 15,
        }),
      ).rejects.toThrow("failed to acquire gateway state ownership");
    } finally {
      await lock.release();
    }
  });
});
