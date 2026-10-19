import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { captureFullEnv, withEnv } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: vi.fn(),
    __promisify__: vi.fn(),
  }),
);
const resolveLsofCommandSyncMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn());
const observedArgv = vi.hoisted(() => new Map<number, string[]>());

vi.mock("node:fs", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:fs")>("node:fs"),
    (actual) => ({
      readFileSync: new Proxy(actual.readFileSync, {
        apply(target, receiver, args) {
          const pid = Number(/^\/proc\/(\d+)\/cmdline$/.exec(String(args[0]))?.[1]);
          const argv = observedArgv.get(pid);
          if (!argv) {
            return Reflect.apply(target, receiver, args);
          }
          const bytes = Buffer.from(argv.join("\0"));
          const encoding = typeof args[1] === "string" ? args[1] : args[1]?.encoding;
          return encoding ? bytes.toString(encoding) : bytes;
        },
      }),
    }),
    { mirrorToDefault: true },
  );
});
vi.mock("../process/supervisor/darwin-process-command.js", () => ({
  readDarwinProcessCommand: (pid: number) => {
    const argv = observedArgv.get(pid);
    return argv ? { argv } : undefined;
  },
}));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      execFile: execFileMock,
      spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
    } as Partial<typeof import("node:child_process")>,
  );
});

vi.mock("./ports-lsof.js", () => ({
  resolveLsofCommandSync: (...args: unknown[]) => resolveLsofCommandSyncMock(...args),
}));

vi.mock("../config/paths.js", () => ({
  resolveGatewayPort: (...args: unknown[]) => resolveGatewayPortMock(...args),
  resolveStateDir: (env: NodeJS.ProcessEnv = process.env) =>
    env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw-state",
}));

const { cleanStaleGatewayProcessesSync, findGatewayPidsOnPortSync } =
  await import("./restart-stale-pids.js");
const {
  consumeGatewayRestartAuthorization,
  normalizeGatewayRestartDelayMs,
  requestGatewayRestartWithSignalAdmission,
  resetGatewayRestartStateForInProcessRestart,
  scheduleGatewayRestart,
  triggerOpenClawRestart,
} = await import("./restart.js");

const envSnapshot = captureFullEnv();

beforeEach(() => {
  observedArgv.clear();
  execFileMock.mockReset();
  spawnSyncMock.mockReset();
  resolveLsofCommandSyncMock.mockReset().mockReturnValue("/usr/sbin/lsof");
  resolveGatewayPortMock.mockReset().mockReturnValue(18789);
  vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
});

afterEach(() => {
  resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
  vi.useRealTimers();
  envSnapshot.restore();
  vi.restoreAllMocks();
});

function lsofResult(processes: [pid: number, command: string, argv?: string[]][]) {
  return {
    status: 0,
    stdout: processes
      .flatMap(([pid, command, argv]) => {
        if (argv) {
          observedArgv.set(pid, argv);
        }
        return [`p${pid}`, `c${command}`];
      })
      .join("\n"),
  };
}

function expectLsofCall(port: number, first = false) {
  const calls = first ? spawnSyncMock.mock.calls.slice(0, 1) : spawnSyncMock.mock.calls;
  expect(calls).toContainEqual([
    "/usr/sbin/lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"],
    expect.objectContaining({ encoding: "utf8", timeout: 5000 }),
  ]);
}

it.runIf(process.platform !== "win32")("filters lsof listeners by PID and process", () => {
  mockProcessPlatform("linux");
  const gatewayPidA = process.pid + 1000;
  const gatewayPidB = process.pid + 2000;
  const foreignPid = process.pid + 3000;
  spawnSyncMock.mockReturnValue(
    lsofResult([
      [process.pid, "openclaw"],
      [gatewayPidA, "openclaw-gateway", ["openclaw-gateway"]],
      [foreignPid, "node", ["python", "server.py"]],
      [gatewayPidB, "OpenClaw", ["openclaw", "gateway"]],
    ]),
  );
  expect(findGatewayPidsOnPortSync(18789)).toEqual([gatewayPidA, gatewayPidB]);
  expectLsofCall(18789);
});

it.runIf(process.platform !== "win32")("cleans stale processes on an explicit port", () => {
  const stalePid = process.pid + 1000;
  spawnSyncMock
    .mockReturnValueOnce(lsofResult([[stalePid, "openclaw", ["openclaw-gateway"]]]))
    .mockReturnValue({ status: 1, stdout: "" });
  const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

  expect(cleanStaleGatewayProcessesSync(19999)).toEqual([stalePid]);
  expect(resolveGatewayPortMock).not.toHaveBeenCalled();
  const lsofCalls = spawnSyncMock.mock.calls.filter((call) => call[0] === "/usr/sbin/lsof");
  expect(lsofCalls).toHaveLength(2);
  expectLsofCall(19999, true);
  expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
  expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGKILL");
});

it.each([0, 37])("handles launchctl bootstrap status %s", (bootstrapStatus) => {
  mockProcessPlatform("darwin");
  withEnv(
    { VITEST: undefined, NODE_ENV: undefined, HOME: "/Users/test", OPENCLAW_PROFILE: "default" },
    () => {
      const failure = { status: 1, stdout: "" };
      spawnSyncMock.mockImplementation((command: string, args: string[]) => {
        if (command !== "launchctl") {
          return failure;
        }
        if (args[0] === "bootstrap") {
          return {
            status: bootstrapStatus,
            stderr: bootstrapStatus === 0 ? "" : "Operation already in progress",
          };
        }
        if (args[0] !== "kickstart") {
          return failure;
        }
        if (args[1] === "-k") {
          return { status: 113, stderr: "service not loaded" };
        }
        return bootstrapStatus === 0 ? failure : { status: 0, stdout: "" };
      });
      const uid = typeof process.getuid === "function" ? process.getuid() : 501;
      expect(triggerOpenClawRestart()).toEqual({
        ok: true,
        method: "launchctl",
        tried: [
          `launchctl kickstart -k gui/${uid}/ai.openclaw.gateway`,
          `launchctl bootstrap gui/${uid} /Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist`,
          ...(bootstrapStatus === 37 ? [`launchctl kickstart gui/${uid}/ai.openclaw.gateway`] : []),
        ],
      });
    },
  );
});

it("rejects restart without signaling an embedded host that has no restart handler", () => {
  mockProcessPlatform("linux");
  const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  const listeners = process.listeners("SIGUSR2");
  process.removeAllListeners("SIGUSR2");
  resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
  try {
    const result = requestGatewayRestartWithSignalAdmission("embedded-host");
    expect(result).toEqual({ status: "failed" });
    expect(killSpy).not.toHaveBeenCalled();
    expect(consumeGatewayRestartAuthorization()).toBe(false);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  } finally {
    for (const listener of listeners) {
      process.on("SIGUSR2", listener);
    }
  }
});

it("uses the default delay when the requested delay is NaN", () => {
  expect(normalizeGatewayRestartDelayMs(Number.NaN)).toBe(2000);
});

it("does not emit an overflow-sized restart before its effective 60-second delay", async () => {
  vi.useFakeTimers();
  const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  const restart = scheduleGatewayRestart({ delayMs: 2_147_153_648 });
  expect(restart.delayMs).toBe(60_000);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(killSpy).not.toHaveBeenCalled();
});
