import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfigPath, resolveGatewayLockDir, resolveStateDir } from "../config/paths.js";
import { acquireGatewayLock, GatewayLockError, type GatewayLockOptions } from "./gateway-lock.js";

let fixtureRoot = "";
let fixtureCount = 0;

async function makeEnv() {
  const dir = path.join(fixtureRoot, `case-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, "openclaw.json");
  await fs.writeFile(configPath, "{}", "utf8");
  await fs.mkdir(resolveGatewayLockDir(), { recursive: true });
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: dir,
    OPENCLAW_CONFIG_PATH: configPath,
  };
}

async function acquireForTest(
  env: NodeJS.ProcessEnv,
  opts: Omit<GatewayLockOptions, "env" | "allowInTests"> = {},
) {
  return await acquireGatewayLock({
    env,
    allowInTests: true,
    timeoutMs: 30,
    pollIntervalMs: 2,
    ...opts,
  });
}

function resolveLockPath(env: NodeJS.ProcessEnv) {
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(env, stateDir);
  const hash = createHash("sha256").update(configPath).digest("hex").slice(0, 8);
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

function createLockPayload(params: { configPath: string; startTime: number; createdAt?: string }) {
  return {
    pid: process.pid,
    createdAt: params.createdAt ?? new Date().toISOString(),
    configPath: params.configPath,
    startTime: params.startTime,
  };
}

function mockProcStatRead(params: { onProcRead: () => string }) {
  const readFileSync = fsSync.readFileSync;
  return vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, encoding) => {
    if (filePath === `/proc/${process.pid}/stat`) {
      return params.onProcRead();
    }
    return readFileSync(filePath as never, encoding as never) as never;
  });
}

async function writeLockFile(
  env: NodeJS.ProcessEnv,
  params: { startTime: number; createdAt?: string } = { startTime: 111 },
) {
  const { lockPath, configPath } = resolveLockPath(env);
  const payload = createLockPayload({
    configPath,
    startTime: params.startTime,
    createdAt: params.createdAt,
  });
  await fs.writeFile(lockPath, JSON.stringify(payload), "utf8");
  return { lockPath, configPath };
}

function createEaccesProcStatSpy() {
  return mockProcStatRead({
    onProcRead: () => {
      throw new Error("EACCES");
    },
  });
}

function createPortProbeConnectionSpy(result: "connect" | "refused") {
  return vi.spyOn(net, "createConnection").mockImplementation(() => {
    const socket = new EventEmitter() as net.Socket;
    socket.destroy = vi.fn();
    setImmediate(() => {
      if (result === "connect") {
        socket.emit("connect");
        return;
      }
      socket.emit("error", Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }));
    });
    return socket;
  });
}

async function writeRecentLockFile(env: NodeJS.ProcessEnv, startTime = 111) {
  await writeLockFile(env, {
    startTime,
    createdAt: new Date().toISOString(),
  });
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
    const env = await makeEnv();
    const lock = await acquireForTest(env, { timeoutMs: 50 });
    expect(lock).not.toBeNull();

    const pending = acquireForTest(env, { timeoutMs: 15 });
    await expect(pending).rejects.toBeInstanceOf(GatewayLockError);

    await lock?.release();
    const lock2 = await acquireForTest(env);
    await lock2?.release();
  });

  it("treats recycled linux pid as stale when start time mismatches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-06T10:05:00.000Z"));
    const env = await makeEnv();
    const { lockPath, configPath } = resolveLockPath(env);
    const payload = createLockPayload({ configPath, startTime: 111 });
    await fs.writeFile(lockPath, JSON.stringify(payload), "utf8");

    const statValue = makeProcStat(process.pid, 222);
    const spy = mockProcStatRead({
      onProcRead: () => statValue,
    });

    const lock = await acquireForTest(env, {
      timeoutMs: 80,
      pollIntervalMs: 5,
      platform: "linux",
    });
    expect(lock).not.toBeNull();

    await lock?.release();
    spy.mockRestore();
  });

  it("keeps lock on linux when proc access fails unless stale", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeLockFile(env);
    const spy = createEaccesProcStatSpy();

    const pending = acquireForTest(env, {
      timeoutMs: 15,
      staleMs: 10_000,
      platform: "linux",
    });
    await expect(pending).rejects.toBeInstanceOf(GatewayLockError);

    spy.mockRestore();
  });

  it("keeps lock when fs.stat fails until payload is stale", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeLockFile(env);
    const procSpy = createEaccesProcStatSpy();
    const statSpy = vi
      .spyOn(fs, "stat")
      .mockRejectedValue(Object.assign(new Error("EPERM"), { code: "EPERM" }));

    const pending = acquireForTest(env, {
      timeoutMs: 20,
      staleMs: 10_000,
      platform: "linux",
    });
    await expect(pending).rejects.toBeInstanceOf(GatewayLockError);

    procSpy.mockRestore();
    statSpy.mockRestore();
  });

  it("treats lock as stale when owner pid is alive but configured port is free", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeRecentLockFile(env);
    const connectSpy = createPortProbeConnectionSpy("refused");

    const lock = await acquireForTest(env, {
      timeoutMs: 80,
      pollIntervalMs: 5,
      staleMs: 10_000,
      platform: "darwin",
      port: 18789,
    });
    expect(lock).not.toBeNull();
    await lock?.release();
    connectSpy.mockRestore();
  });

  it("keeps lock when configured port is busy and owner pid is alive", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeRecentLockFile(env);
    const connectSpy = createPortProbeConnectionSpy("connect");
    try {
      const pending = acquireForTest(env, {
        timeoutMs: 20,
        pollIntervalMs: 2,
        staleMs: 10_000,
        platform: "darwin",
        port: 18789,
      });
      await expect(pending).rejects.toBeInstanceOf(GatewayLockError);
    } finally {
      connectSpy.mockRestore();
    }
  });

  it("returns null when multi-gateway override is enabled", async () => {
    const env = await makeEnv();
    const lock = await acquireGatewayLock({
      env: { ...env, OPENCLAW_ALLOW_MULTI_GATEWAY: "1", VITEST: "" },
    });
    expect(lock).toBeNull();
  });

  it("returns null in test env unless allowInTests is set", async () => {
    const env = await makeEnv();
    const lock = await acquireGatewayLock({
      env: { ...env, VITEST: "1" },
    });
    expect(lock).toBeNull();
  });

  it("wraps unexpected fs errors as GatewayLockError", async () => {
    const env = await makeEnv();
    const openSpy = vi.spyOn(fs, "open").mockRejectedValueOnce(
      Object.assign(new Error("denied"), {
        code: "EACCES",
      }),
    );

    await expect(acquireForTest(env)).rejects.toBeInstanceOf(GatewayLockError);
    openSpy.mockRestore();
  });
});
