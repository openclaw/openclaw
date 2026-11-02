import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readProcessMachineIdentity } from "../infra/current-machine-identity.js";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { acquireGatewayOwnerLease } from "../infra/gateway-owner-lease.js";
import { captureStalledGatewayStartup } from "../infra/gateway-startup-owner.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import * as processes from "../shared/pid-alive.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { stopStalledGatewayStartup } from "./schtasks-process.js";

const directories = useAutoCleanupTempDirTracker(afterAll);
const children: { child: ChildProcess; exited: Promise<unknown[]> }[] = [];
let holder: ChildProcess;
let unrelated: ChildProcess;
let custody: ReturnType<typeof acquireGatewayStateOwner>;
let env: NodeJS.ProcessEnv;
let startTime: number;
let startupAt: number;

async function spawnFixture() {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready');"],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  children.push({ child, exited: once(child, "exit") });
  await once(child, "message");
  return child;
}

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: directories.make("stalled-gateway-") };
  holder = await spawnFixture();
  unrelated = await spawnFixture();
  const identity = processes.getFileLockProcessStartTime(holder.pid!);
  if (identity === null) {
    throw new Error("Fixture process start identity unavailable");
  }
  startTime = identity;
  startupAt = Date.now() - 300_001;
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
  await Promise.all(
    children.map(({ child, exited }) => {
      child.kill("SIGKILL");
      return exited;
    }),
  );
});

it("names the overdue startup PID, phase, age, and stop command despite a fresh worker heartbeat", async () => {
  vi.spyOn(Date, "now").mockReturnValue(startupAt + 300_001);
  fs.utimesSync(custody.path, new Date(Date.now()), new Date(Date.now()));
  const contender = acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0 });
  await expect(contender).rejects.toThrow(
    `Gateway pid ${holder.pid} has been stuck in startup for 300 s`,
  );
  await expect(contender).rejects.toThrow("openclaw gateway stop");
  expect(() => custody.assertCurrent()).not.toThrow();
});

it("refuses a recycled PID before sending any stop signal", async () => {
  const stalled = captureStalledGatewayStartup(env);
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
  await stopStalledGatewayStartup(stalled!);
  expect(processes.isPidAlive(holder.pid!)).toBe(false);
  expect(processes.isPidAlive(unrelated.pid!)).toBe(true);
  expect(fs.existsSync(custody.path)).toBe(false);
  const successor = await acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0 });
  await successor?.release();
});

it("checks an overdue listening Gateway from another process without copying shared state", async ({
  signal,
}) => {
  const root = directories.make("listening-gateway-");
  const ownerEnv = { OPENCLAW_STATE_DIR: root, HOME: root, OPENCLAW_HOME: root };
  const databasePath = resolveOpenClawStateSqlitePath(ownerEnv);
  openOpenClawStateDatabase({ env: ownerEnv });
  closeOpenClawStateDatabaseForTest();
  const owner = "listening-owner";
  const coordinator = acquireGatewayStateOwner({
    databasePath,
    payload: {
      pid: process.pid,
      ownerId: owner,
      startTime: processes.getFileLockProcessStartTime(process.pid)!,
      createdAt: new Date(Date.now() - 300_001).toISOString(),
      startupPhase: "starting",
      configPath: path.join(root, "openclaw.json"),
      role: "gateway",
      processNamespace: readGatewayLockProcessNamespace(),
      machineIdentity: readProcessMachineIdentity(),
    },
  });
  const lease = acquireGatewayOwnerLease({
    env: ownerEnv,
    port: 19483,
    mode: "foreground",
    supervisor: null,
    owner,
  });
  try {
    await lease.ready;
    lease.markListening();
    const result = await runNodeScript(
      [
        "--import=tsx",
        "--input-type=module",
        "--eval",
        `
      import fs from "node:fs";
      import cp from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      const observed = { syncSpawns: 0, snapshotDirectories: 0 };
      const spawn = cp.spawnSync;
      cp.spawnSync = (...args) => {
        if (args[1]?.includes("--openclaw-sqlite-readonly-child") && args[1]?.includes("sync")) observed.syncSpawns++;
        return spawn(...args);
      };
      const mkdtemp = fs.mkdtempSync;
      fs.mkdtempSync = (prefix, ...args) => {
        if (String(prefix).includes("openclaw-sqlite-readonly-v2-")) observed.snapshotDirectories++;
        return mkdtemp(prefix, ...args);
      };
      syncBuiltinESMExports();
      const { captureStalledGatewayStartup } = await import(${JSON.stringify(new URL("../infra/gateway-startup-owner.ts", import.meta.url).href)});
      console.log(JSON.stringify({ stalled: Boolean(captureStalledGatewayStartup()), ...observed }));
    `,
      ],
      {
        ...ownerEnv,
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        XDG_CACHE_HOME: path.join(root, "cache"),
        NODE_DISABLE_COMPILE_CACHE: "1",
        TSX_DISABLE_CACHE: "1",
      },
      20_000,
      { signal },
    );
    expect(result, result.stderr).toMatchObject({ error: undefined, status: 0 });
    expect(JSON.parse(result.stdout)).toEqual({
      stalled: false,
      syncSpawns: 0,
      snapshotDirectories: 0,
    });
  } finally {
    await lease.release();
    coordinator.release();
    closeOpenClawStateDatabaseForTest();
  }
});
