// Windows schtasks stop tests cover stopping scheduled task services.
import type { SpawnSyncOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { GatewayOwnerLeaseIdentity } from "../infra/gateway-owner-lease.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../infra/state-database-coordinator.js";
import "./test-helpers/schtasks-base-mocks.js";
import {
  inspectPortUsageMock,
  killProcessTreeMock,
  resetSchtasksBaseMocks,
  schtasksResponses,
  withWindowsEnv,
  writeGatewayScript,
} from "./test-helpers/schtasks-fixtures.js";
const findVerifiedGatewayListenerPidsOnPortSync = vi.hoisted(() =>
  vi.fn<(port: number) => number[]>(() => []),
);
const timeState = vi.hoisted(() => ({ now: 0 }));
const readGatewayOwnerLease = vi.hoisted(() =>
  vi.fn<typeof import("../infra/gateway-owner-lease.js").readGatewayOwnerLease>(),
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
  host: "gateway-test-host",
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
function mockWindowsTaskkillSuccess() {
  // Route process-control probes so verified owners terminate cleanly: taskkill
  // succeeds and the follow-up tasklist probe reports the PID as gone.
  spawnSync.mockImplementation((exe: unknown) => {
    const exeText = String(exe);
    if (/taskkill\.exe$/i.test(exeText)) {
      return { pid: 0, output: [null, "", ""], stdout: "", stderr: "", status: 0, signal: null };
    }
    if (/tasklist\.exe$/i.test(exeText)) {
      const stdout = "No tasks";
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

function setTaskStateProbeResult(state: number) {
  const stdout = JSON.stringify({ state });
  spawnSync.mockReturnValueOnce({
    pid: 0,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status: 0,
    signal: null,
  });
}

async function withPreparedGatewayTask(
  run: (context: { env: Record<string, string>; stdout: PassThrough }) => Promise<void>,
  launcherSuffix = "",
) {
  await withWindowsEnv("openclaw-win-stop-", async ({ tmpDir, env }) => {
    await writeGatewayScript(env, GATEWAY_PORT);
    if (launcherSuffix) {
      const scriptPath = resolveTaskScriptPath(env);
      const script = await fs.readFile(scriptPath, "utf8");
      await fs.writeFile(scriptPath, `${script.trimEnd()} ${launcherSuffix}\r\n`);
    }
    const stdout = new PassThrough();
    await withStateDatabaseCoordinatorRuntimeDirectory(path.join(tmpDir, "coordinators"), () =>
      run({ env, stdout }),
    );
  });
}

beforeEach(() => {
  resetSchtasksBaseMocks();
  readGatewayOwnerLease.mockReset();
  findVerifiedGatewayListenerPidsOnPortSync.mockReset();
  findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
  timeState.now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => timeState.now);
  sleepMock.mockReset();
  sleepMock.mockImplementation(async (ms: number) => {
    timeState.now += ms;
  });
  spawnSync.mockReset();
  spawnSync.mockReturnValue({
    pid: 0,
    output: [null, "-2147024891", ""],
    stdout: "-2147024891",
    stderr: "",
    status: 1,
    signal: null,
  });
  inspectPortUsageMock.mockResolvedValue(freePortUsage());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

export {
  GATEWAY_OWNER,
  GATEWAY_PORT,
  INSTALLED_GATEWAY_COMMAND_LINE,
  SUCCESS_RESPONSE,
  expectGatewayTermination,
  expectTaskkill,
  findVerifiedGatewayListenerPidsOnPortSync,
  formatWindowsTaskSupervisorChildArgument,
  mockWindowsTaskkillSuccess,
  probeProcessState,
  pushSuccessfulSchtasksResponses,
  readGatewayOwnerLease,
  resolveScheduledTaskOwnedGatewayPids,
  resolveTaskScriptPath,
  restartScheduledTask,
  resumeScheduledTaskAutoStartAfterUpdate,
  setTaskStateProbeResult,
  spawnSync,
  startScheduledTask,
  stopScheduledTask,
  suspendScheduledTaskAutoStartForUpdate,
  taskkillPids,
  terminateScheduledTaskGatewayListeners,
  withPreparedGatewayTask,
  busyPortUsage,
  freePortUsage,
};
