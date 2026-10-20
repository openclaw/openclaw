import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { captureStalledGatewayStartup } from "../infra/gateway-startup-owner.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import * as processes from "../shared/pid-alive.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { stopStalledGatewayStartup } from "./schtasks-process.js";

const directories = useAutoCleanupTempDirTracker(afterAll);
const realNow = Date.now.bind(Date);
const children: { child: ChildProcess; exited: Promise<unknown[]> }[] = [];
let holder: ChildProcess;
let unrelated: ChildProcess;
let custody: ReturnType<typeof acquireGatewayStateOwner>;
let env: NodeJS.ProcessEnv;
let startTime: number;
let startupAt: number;

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: directories.make("stalled-gateway-") };
  for (let index = 0; index < 2; index += 1) {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready');",
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const ready = once(child, "message");
    children.push({ child, exited: once(child, "exit") });
    await ready;
  }
  const [held, other] = children;
  if (!held || !other) {
    throw new Error("Fixture children unavailable");
  }
  holder = held.child;
  unrelated = other.child;
  const identity = processes.getFileLockProcessStartTime(holder.pid!);
  if (identity === null) {
    throw new Error("Fixture process start identity unavailable");
  }
  startTime = identity;
  startupAt = realNow() - 300_001;
  custody = acquireGatewayStateOwner({
    databasePath: resolveOpenClawStateSqlitePath(env),
    payload: {
      pid: holder.pid!,
      ownerId: "stalled-owner",
      startTime,
      processNamespace: readGatewayLockProcessNamespace(),
      role: "gateway",
      createdAt: new Date(startupAt).toISOString(),
      configPath: path.join(env.OPENCLAW_STATE_DIR!, "openclaw.json"),
    },
  });
  holder.once("exit", () => custody.release());
});

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  for (const { child, exited } of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exited;
  }
  custody?.release();
});

it("names the overdue startup PID, phase, age, and stop command despite a fresh worker heartbeat", async () => {
  vi.spyOn(Date, "now").mockReturnValue(startupAt + 300_001);
  const stamp = new Date(Date.now());
  fs.utimesSync(custody.path, stamp, stamp);
  const contender = acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0 });
  await expect(contender).rejects.toThrow(
    `Gateway pid ${holder.pid} has been stuck in startup for 300 s`,
  );
  await expect(contender).rejects.toThrow("openclaw gateway stop");
  expect(() => custody.assertCurrent()).not.toThrow();
});

it("refuses a recycled PID before sending any stop signal", async () => {
  const stalled = captureStalledGatewayStartup(env);
  expect(stalled).toBeDefined();
  vi.spyOn(processes, "getFileLockProcessStartTime").mockReturnValue(startTime + 1);
  const signals = vi.spyOn(process, "kill");
  await expect(stopStalledGatewayStartup(stalled!)).rejects.toThrow("changed; process preserved");
  expect(
    signals.mock.calls.filter(([, signal]) => signal === "SIGTERM" || signal === "SIGKILL"),
  ).toEqual([]);
  expect(processes.isPidAlive(holder.pid!)).toBe(true);
});

it("terminates only the exact stuck holder and confirms exit and state lock release", async () => {
  const stalled = captureStalledGatewayStartup(env);
  expect(stalled).toBeDefined();
  await stopStalledGatewayStartup(stalled!);
  expect(processes.isPidAlive(holder.pid!)).toBe(false);
  expect(processes.isPidAlive(unrelated.pid!)).toBe(true);
  expect(fs.existsSync(custody.path)).toBe(false);
  const successor = await acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0 });
  await successor?.release();
});
