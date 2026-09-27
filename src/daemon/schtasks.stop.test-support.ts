// Windows schtasks stop tests cover stopping scheduled task services.
import type { SpawnSyncOptions } from "node:child_process";
import fs from "node:fs/promises";
import { hostname } from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { GatewayOwnerLeaseIdentity } from "../infra/gateway-owner-lease.js";
import type { PortUsage } from "../infra/ports-types.js";
import "./test-helpers/schtasks-base-mocks.js";
import {
  inspectPortUsageMock,
  killProcessTreeMock,
  resetSchtasksBaseMocks,
  schtasksCalls,
  schtasksResponses,
  withWindowsEnv,
  writeGatewayScript,
} from "./test-helpers/schtasks-fixtures.js";
const findVerifiedGatewayListenerPidsOnPortSync = vi.hoisted(() =>
  vi.fn<(port: number) => number[]>(() => []),
);
const timeState = vi.hoisted(() => ({ now: 0 }));
const callGatewayCli = vi.hoisted(() => vi.fn());
const readGatewayOwnerLease = vi.hoisted(() =>
  vi.fn<typeof import("../infra/gateway-owner-lease.js").readGatewayOwnerLease>(),
);
const readWindowsProcessStartTimeSync = vi.hoisted(() =>
  vi.fn<typeof import("../infra/windows-process-start.js").readWindowsProcessStartTimeSync>(),
);
const readWindowsProcessAncestorsSync = vi.hoisted(() =>
  vi.fn<typeof import("../infra/windows-process-start.js").readWindowsProcessAncestorsSync>(),
);
const sleepMock = vi.hoisted(() =>
  vi.fn(async (ms: number) => {
    timeState.now += ms;
  }),
);
type SpawnSyncResult = {
  pid: number;
  output: (string | null)[];
  stdout: string;
  stderr: string;
  status: number;
  signal: null;
};
function spawnSyncResult(stdout: string, status = 0): SpawnSyncResult {
  return {
    pid: 0,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status,
    signal: null,
  };
}
const spawnSync = vi.hoisted(() =>
  vi.fn<(command: string, args?: readonly string[], options?: SpawnSyncOptions) => SpawnSyncResult>(
    () => ({
      pid: 0,
      output: [null, "-2147024891", ""],
      stdout: "-2147024891",
      stderr: "",
      status: 1,
      signal: null,
    }),
  ),
);

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawnSync };
});

vi.mock("../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: (port: number) =>
    findVerifiedGatewayListenerPidsOnPortSync(port),
}));
vi.mock("../infra/gateway-owner-lease.js", () => ({ readGatewayOwnerLease }));
vi.mock("../gateway/call.js", () => ({ callGatewayCli }));
vi.mock("../infra/windows-process-start.js", () => ({
  readWindowsProcessAncestorsSync,
  readWindowsProcessStartTimeSync,
}));
vi.mock("../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../utils.js")>("../utils.js");
  return {
    ...actual,
    sleep: (ms: number) => sleepMock(ms),
  };
});

const {
  resolveTaskScriptPath,
  restartScheduledTask,
  resumeScheduledTaskAutoStartAfterUpdate,
  startScheduledTask,
  stopScheduledTask,
  suspendScheduledTaskAutoStartForUpdate,
} = await import("./schtasks.js");
const { probeProcessState, resolveScheduledTaskOwnedGatewayPids } =
  await import("./schtasks-process.js");
const { formatWindowsTaskSupervisorChildArgument } =
  await import("./windows-task-supervisor-contract.js");
const { terminateScheduledTaskGatewayListeners } = await import("./schtasks-process.js");
const GATEWAY_PORT = 18789;
const SUCCESS_RESPONSE = { code: 0, stdout: "", stderr: "" } as const;
const INSTALLED_GATEWAY_COMMAND_LINE =
  '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port 18789';
const GATEWAY_OWNER: GatewayOwnerLeaseIdentity = {
  owner: "gateway-owner-1",
  pid: 4242,
  host: hostname(),
  startedAt: 100,
  port: GATEWAY_PORT,
  mode: "supervised",
  supervisor: { kind: "schtasks", name: "OpenClaw Gateway" },
  state: "live",
  expired: false,
};

function pushSuccessfulSchtasksResponses(count: number) {
  for (let i = 0; i < count; i += 1) {
    schtasksResponses.push({ ...SUCCESS_RESPONSE });
  }
}

function freePortUsage() {
  return {
    port: GATEWAY_PORT,
    status: "free" as const,
    listeners: [],
    hints: [],
  };
}

function busyPortUsage(
  pid: number,
  options: {
    command?: string;
    commandLine?: string;
  } = {},
) {
  return {
    port: GATEWAY_PORT,
    status: "busy" as const,
    listeners: [
      {
        pid,
        command: options.command ?? "node.exe",
        address: `127.0.0.1:${GATEWAY_PORT}`,
        ...(options.commandLine ? { commandLine: options.commandLine } : {}),
      },
    ],
    hints: [],
  };
}

function expectGatewayTermination(pid: number) {
  if (process.platform === "win32") {
    expect(killProcessTreeMock).not.toHaveBeenCalled();
    return;
  }
  expect(killProcessTreeMock).toHaveBeenCalledWith(pid, { graceMs: 300 });
}
function scheduledTaskProbeResult(
  state = schtasksCalls.some(([action]) => action === "/Run") ? 4 : 3,
) {
  return spawnSyncResult(
    JSON.stringify({
      state,
      lastRunResult: state === 4 ? 267009 : 0,
      lastRunTime: "2026-09-27T00:00:00.0000000Z",
    }),
  );
}

function mockWindowsTaskkillSuccess() {
  // Route process-control probes so verified owners terminate cleanly: taskkill
  // succeeds and the follow-up tasklist probe reports the PID as gone.
  spawnSync.mockImplementation((exe: unknown, args) => {
    const exeText = String(exe);
    if (args?.includes("-EncodedCommand")) {
      return scheduledTaskProbeResult();
    }
    if (/taskkill\.exe$/i.test(exeText)) {
      return { pid: 0, output: [null, "", ""], stdout: "", stderr: "", status: 0, signal: null };
    }
    if (/tasklist\.exe$/i.test(exeText)) {
      const pid = Number(args?.find((arg) => arg.startsWith("PID eq "))?.slice(7));
      const gone =
        taskkillPids().includes(pid) || schtasksCalls.some(([action]) => action === "/End");
      const stdout = gone ? "No tasks" : `"node.exe","${pid}","Console","1","1 K"`;
      return { pid: 0, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null };
    }
    return {
      pid: 0,
      output: [null, "-2147024891", ""],
      stdout: "-2147024891",
      stderr: "",
      status: 1,
      signal: null,
    };
  });
}

function taskkillPids(): number[] {
  return spawnSync.mock.calls
    .filter(([exe]) => /taskkill\.exe$/i.test(exe))
    .map(([, args]) => {
      const list = (args as string[] | undefined) ?? [];
      const index = list.findIndex((arg) => arg.toUpperCase() === "/PID");
      return index >= 0 ? Number.parseInt(list[index + 1] ?? "", 10) : Number.NaN;
    })
    .filter((pid) => Number.isFinite(pid));
}

function expectTaskkill(pid: number) {
  if (process.platform === "win32") {
    expect(taskkillPids()).toContain(pid);
  }
}

function setTaskStateProbeResult(state: number | null) {
  const previous = spawnSync.getMockImplementation();
  spawnSync.mockImplementation((command, args, options) => {
    if (command.toLowerCase().endsWith("powershell.exe") && args?.includes("-EncodedCommand")) {
      return state === null ? spawnSyncResult("-2147024894", 1) : scheduledTaskProbeResult(state);
    }
    return previous?.(command, args, options) ?? spawnSyncResult("", 1);
  });
}

function mockLingeringGatewayListener(pid: number, after: PortUsage = freePortUsage()) {
  inspectPortUsageMock.mockImplementation(async () => {
    const terminated =
      process.platform === "win32"
        ? taskkillPids().includes(pid)
        : killProcessTreeMock.mock.calls.some(([candidate]) => candidate === pid);
    return terminated ? after : busyPortUsage(pid, { commandLine: INSTALLED_GATEWAY_COMMAND_LINE });
  });
}

async function withPreparedGatewayTask(
  run: (context: { env: Record<string, string>; stdout: PassThrough }) => Promise<void>,
  launcherSuffix = "",
) {
  await withWindowsEnv("openclaw-win-stop-", async ({ env }) => {
    await writeGatewayScript(env, GATEWAY_PORT);
    if (launcherSuffix) {
      const scriptPath = resolveTaskScriptPath(env);
      const script = await fs.readFile(scriptPath, "utf8");
      await fs.writeFile(scriptPath, `${script.trimEnd()} ${launcherSuffix}\r\n`);
    }
    const stdout = new PassThrough();
    await run({ env, stdout });
  });
}

beforeEach(() => {
  resetSchtasksBaseMocks();
  callGatewayCli.mockReset().mockRejectedValue(new Error("unsupported method"));
  readGatewayOwnerLease.mockReset();
  readWindowsProcessStartTimeSync.mockReset();
  readWindowsProcessStartTimeSync.mockReturnValue(GATEWAY_OWNER.startedAt);
  readWindowsProcessAncestorsSync.mockReset().mockReturnValue({ pids: [], complete: false });
  findVerifiedGatewayListenerPidsOnPortSync.mockReset();
  findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
  timeState.now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => timeState.now);
  sleepMock.mockReset();
  sleepMock.mockImplementation(async (ms: number) => {
    timeState.now += ms;
  });
  spawnSync.mockReset();
  spawnSync.mockImplementation((_exe, args) =>
    args?.includes("-EncodedCommand")
      ? scheduledTaskProbeResult()
      : spawnSyncResult("-2147024891", 1),
  );
  inspectPortUsageMock.mockResolvedValue(freePortUsage());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

export {
  callGatewayCli,
  GATEWAY_OWNER,
  GATEWAY_PORT,
  INSTALLED_GATEWAY_COMMAND_LINE,
  SUCCESS_RESPONSE,
  expectGatewayTermination,
  expectTaskkill,
  findVerifiedGatewayListenerPidsOnPortSync,
  formatWindowsTaskSupervisorChildArgument,
  mockWindowsTaskkillSuccess,
  mockLingeringGatewayListener,
  probeProcessState,
  pushSuccessfulSchtasksResponses,
  readGatewayOwnerLease,
  readWindowsProcessStartTimeSync,
  resolveScheduledTaskOwnedGatewayPids,
  resolveTaskScriptPath,
  restartScheduledTask,
  resumeScheduledTaskAutoStartAfterUpdate,
  setTaskStateProbeResult,
  spawnSync,
  spawnSyncResult,
  scheduledTaskProbeResult,
  startScheduledTask,
  stopScheduledTask,
  suspendScheduledTaskAutoStartForUpdate,
  taskkillPids,
  terminateScheduledTaskGatewayListeners,
  withPreparedGatewayTask,
  busyPortUsage,
  freePortUsage,
};
