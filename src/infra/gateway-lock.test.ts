import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfigPath, resolveGatewayLockDir, resolveStateDir } from "../config/paths.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";

let fixtureRoot = "";
let fixtureCount = 0;

async function makeEnv() {
  const dir = path.join(fixtureRoot, `case-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, "openclaw.json");
  await fs.writeFile(configPath, "{}", "utf8");
  await fs.mkdir(resolveGatewayLockDir(), { recursive: true });
  return {
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: dir,
      OPENCLAW_CONFIG_PATH: configPath,
    },
    cleanup: async () => {},
  };
}

function resolveLockPath(env: NodeJS.ProcessEnv) {
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(env, stateDir);
  const hash = createHash("sha1").update(configPath).digest("hex").slice(0, 8);
  const lockDir = resolveGatewayLockDir();
  return { lockPath: path.join(lockDir, `gateway.${hash}.lock`), configPath };
}

function makeProcStat(pid: number, startTime: number) {
  const fields = [
    "R",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    String(startTime),
    "1",
    "1",
  ];
  return `${pid} (node) ${fields.join(" ")}`;
}

describe("gateway lock", () => {
  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-lock-"));
  });

  beforeEach(() => {
    // Other suites occasionally leave global spies behind (Date.now, setTimeout, etc.).
    // This test relies on fake timers advancing Date.now and setTimeout deterministically.
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("blocks concurrent acquisition until release", async () => {
    // Fake timers can hang on Windows CI when combined with fs open loops.
    // Keep this test on real timers and use small timeouts.
    vi.useRealTimers();
    const { env, cleanup } = await makeEnv();
    const lock = await acquireGatewayLock({
      env,
      allowInTests: true,
      timeoutMs: 100,
      pollIntervalMs: 5,
    });
    expect(lock).not.toBeNull();

    const pending = acquireGatewayLock({
      env,
      allowInTests: true,
      timeoutMs: 100,
      pollIntervalMs: 5,
    });
    await expect(pending).rejects.toBeInstanceOf(GatewayLockError);

    await lock?.release();
    const lock2 = await acquireGatewayLock({
      env,
      allowInTests: true,
      timeoutMs: 100,
      pollIntervalMs: 5,
    });
    await lock2?.release();
    await cleanup();
  });

  it("treats recycled linux pid as stale when start time mismatches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-06T10:05:00.000Z"));
    const { env, cleanup } = await makeEnv();
    const { lockPath, configPath } = resolveLockPath(env);
    const payload = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      configPath,
      startTime: 111,
    };
    await fs.writeFile(lockPath, JSON.stringify(payload), "utf8");

    const readFileSync = fsSync.readFileSync;
    const statValue = makeProcStat(process.pid, 222);
    const spy = vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, encoding) => {
      if (filePath === `/proc/${process.pid}/stat`) {
        return statValue;
      }
      return readFileSync(filePath as never, encoding as never) as never;
    });

    const lock = await acquireGatewayLock({
      env,
      allowInTests: true,
      timeoutMs: 80,
      pollIntervalMs: 5,
      platform: "linux",
    });
    expect(lock).not.toBeNull();

    await lock?.release();
    spy.mockRestore();
    await cleanup();
  });

  it("keeps lock on linux when proc access fails unless stale", async () => {
    vi.useRealTimers();
    const { env, cleanup } = await makeEnv();
    const { lockPath, configPath } = resolveLockPath(env);
    const payload = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      configPath,
      startTime: 111,
    };
    await fs.writeFile(lockPath, JSON.stringify(payload), "utf8");

    const readFileSync = fsSync.readFileSync;
    const spy = vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, encoding) => {
      if (filePath === `/proc/${process.pid}/stat`) {
        throw new Error("EACCES");
      }
      return readFileSync(filePath as never, encoding as never) as never;
    });

    const pending = acquireGatewayLock({
      env,
      allowInTests: true,
      timeoutMs: 50,
      pollIntervalMs: 5,
      staleMs: 10_000,
      platform: "linux",
    });
    await expect(pending).rejects.toBeInstanceOf(GatewayLockError);

    spy.mockRestore();

    const stalePayload = {
      ...payload,
      createdAt: new Date(0).toISOString(),
    };
    await fs.writeFile(lockPath, JSON.stringify(stalePayload), "utf8");

    const staleSpy = vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, encoding) => {
      if (filePath === `/proc/${process.pid}/stat`) {
        throw new Error("EACCES");
      }
      return readFileSync(filePath as never, encoding as never) as never;
    });

    const lock = await acquireGatewayLock({
      env,
      allowInTests: true,
      timeoutMs: 80,
      pollIntervalMs: 5,
      staleMs: 1,
      platform: "linux",
    });
    expect(lock).not.toBeNull();

    await lock?.release();
    staleSpy.mockRestore();
    await cleanup();
  });
});
