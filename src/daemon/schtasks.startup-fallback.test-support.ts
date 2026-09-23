import "./test-helpers/schtasks-base-mocks.js";
// Windows schtasks startup fallback tests cover fallback startup task behavior.
import type { ChildProcess, SpawnSyncOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import {
  inspectPortUsageMock,
  killProcessTreeMock,
  resetSchtasksBaseMocks,
  schtasksResponses,
} from "./test-helpers/schtasks-fixtures.js";

vi.mock("../infra/windows-encoding.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/windows-encoding.js")>(
    "../infra/windows-encoding.js",
  );
  return {
    ...actual,
    resolveWindowsOemCodePage: () => 437,
    resolveWindowsOemEncoding: () => "cp437",
  };
});

const timeState = vi.hoisted(() => ({ now: 0 }));

const sleepMock = vi.hoisted(() =>
  vi.fn(async (ms: number) => {
    timeState.now += ms;
  }),
);

const childUnref = vi.hoisted(() => vi.fn());

const spawn = vi.hoisted(() => vi.fn());

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
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    }),
  ),
);

const taskProbeResponses: Array<{ status: number; stdout: string; stderr?: string }> = [];

const taskProbe = vi.hoisted(() =>
  vi.fn<
    (
      command: string,
      args?: readonly string[],
      options?: SpawnSyncOptions,
    ) => {
      status: number;
      stdout: string;
      stderr?: string;
    }
  >(),
);

const findVerifiedGatewayListenerPidsOnPortSync = vi.hoisted(() =>
  vi.fn<(port: number) => number[]>(() => []),
);

vi.mock("../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../utils.js")>("../utils.js");
  return {
    ...actual,
    sleep: (ms: number) => sleepMock(ms),
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn,
    spawnSync: (command: string, args?: readonly string[], options?: SpawnSyncOptions) => {
      const encoded = args?.indexOf("-EncodedCommand") ?? -1;
      if (
        encoded >= 0 &&
        Buffer.from(args?.[encoded + 1] ?? "", "base64")
          .toString("utf16le")
          .includes("Schedule.Service")
      ) {
        return taskProbe(command, args, options);
      }
      return spawnSync(command, args, options);
    },
  };
});

vi.mock("../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: (port: number) =>
    findVerifiedGatewayListenerPidsOnPortSync(port),
}));

const {
  installScheduledTask,
  isScheduledTaskInstalled,
  readScheduledTaskRuntime,
  restartScheduledTask,
  resolveTaskScriptPath,
  stopScheduledTask,
  uninstallScheduledTask,
} = await import("./schtasks.js");

const { runScheduledTaskOrThrow } = await import("./schtasks-control.js");
const { decodeWindowsLauncherScript } = await import("../infra/windows-launcher-encoding.js");

const {
  launchFallbackTaskScript,
  removeStartupEntries,
  resolveFallbackRuntime,
  readWindowsStartupFallbackRuntimeForUpdate,
} = await import("./schtasks-runtime.js");

const { createMockGatewayService } = await import("./service.test-helpers.js");

const { readServiceStatusSummary } = await import("../commands/status.service-summary.js");

const { getStatusOverviewRowValue } = await import("../commands/status.test-support.ts");

function createSpawnChild(error?: Error): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.unref = childUnref;
  queueMicrotask(() => {
    child.emit(error ? "error" : "spawn", error);
  });
  return child;
}

const NODE_PROCESS_QUERY =
  "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";

const STARTUP_GATEWAY_COMMAND =
  '"C:\\Program Files\\nodejs\\node.exe" "C:\\openclaw\\dist\\index.js" gateway --port 18789';

async function writeRunningGatewayScript(
  env: Record<string, string>,
  processId: number,
  isRunning = () => true,
) {
  const scriptPath = resolveTaskScriptPath(env);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(
    scriptPath,
    ["@echo off", 'set "OPENCLAW_GATEWAY_PORT=18789"', STARTUP_GATEWAY_COMMAND, ""].join("\r\n"),
    "utf8",
  );
  let terminated = false;
  spawnSync.mockImplementation((command, args) => {
    if (command === getWindowsPowerShellExePath() && args?.includes(NODE_PROCESS_QUERY)) {
      return makeSpawnSyncResult({
        stdout: JSON.stringify([
          ...(!terminated && isRunning()
            ? [{ ProcessId: processId, CommandLine: STARTUP_GATEWAY_COMMAND }]
            : []),
          { ProcessId: 9999, CommandLine: "powershell.exe" },
        ]),
      });
    }
    if (command.endsWith("taskkill.exe") && args?.includes(String(processId))) {
      terminated = true;
    }
    return makeSpawnSyncResult();
  });
}

function makeNodeServiceEnv(env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    OPENCLAW_SERVICE_KIND: "node",
    OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Node",
  };
}

function makeSpawnSyncResult(overrides: Partial<SpawnSyncResult> = {}): SpawnSyncResult {
  return {
    pid: 0,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...overrides,
  };
}

function mockWindowsNodeHostProcess(processId = 5151): void {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  let processAlive = true;
  spawnSync.mockImplementation((command, args) => {
    if (
      command === getWindowsPowerShellExePath() &&
      Array.isArray(args) &&
      args.includes(NODE_PROCESS_QUERY)
    ) {
      return makeSpawnSyncResult({
        stdout: JSON.stringify(
          processAlive
            ? [
                {
                  ProcessId: processId,
                  CommandLine: "C:\\bin\\openclaw.cmd node run --host 127.0.0.1 --port 18789",
                },
                { ProcessId: 9999, CommandLine: "powershell.exe" },
              ]
            : [{ ProcessId: 9999, CommandLine: "powershell.exe" }],
        ),
      });
    }
    if (command.endsWith("taskkill.exe")) {
      processAlive = false;
    }
    return makeSpawnSyncResult();
  });
}

function expectTaskkillPid(pid: number): void {
  expect(
    spawnSync.mock.calls.some(
      ([command, args]) =>
        command.endsWith("taskkill.exe") &&
        Array.isArray(args) &&
        args.includes("/PID") &&
        args.includes(String(pid)),
    ),
  ).toBe(true);
}

function expectStartupFallbackSpawn() {
  expect(spawn).toHaveBeenCalled();
  const calls = spawn.mock.calls as unknown as Array<
    [string, readonly string[], Record<string, unknown>]
  >;
  const lastCall = calls[calls.length - 1];
  if (!lastCall) {
    throw new Error("expected gateway launch spawn call");
  }
  const [executable, args, options] = lastCall;
  expect(executable).not.toBe("cmd.exe");
  expect(args).toContain("--port");
  expect(args).toContain("18789");
  expect(options.detached).toBe(true);
  expect((options.env as Record<string, string> | undefined)?.OPENCLAW_GATEWAY_PORT).toBe("18789");
  expect(options.stdio).toBe("ignore");
  expect(options.windowsHide).toBe(true);
}

function expectGatewayTermination(pid: number) {
  expectTaskkillPid(pid);
  expect(killProcessTreeMock).not.toHaveBeenCalled();
}

function expectNoGatewayTermination() {
  expect(killProcessTreeMock).not.toHaveBeenCalled();
  expect(spawnSync.mock.calls.filter(([command]) => command.endsWith("taskkill.exe"))).toEqual([]);
}

function addMissingTaskInstallResponses(responses: NativeResponse[]): void {
  taskProbe.mockReturnValueOnce({ status: 1, stdout: "-2147024894" });
  queueNativeResponses(
    { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." },
    ...responses.flatMap((response, index) =>
      index === 0 && "code" in response && response.code === 0
        ? [response, { code: 0, stdout: "", stderr: "" }]
        : [response],
    ),
  );
}

function addStartupFallbackMissingResponses(extraResponses: NativeResponse[] = []) {
  queueNativeResponses({ code: 0, stdout: "", stderr: "" });
  addMissingTaskInstallResponses(extraResponses);
}

function installGatewayScheduledTask(
  env: Record<string, string>,
  stdout = new PassThrough(),
  port = "18789",
  startupFallbackTakeoverRuntime?: GatewayServiceRuntime,
) {
  return installScheduledTask({
    env,
    stdout,
    programArguments: ["node", "gateway.js", "--port", port],
    environment: { OPENCLAW_GATEWAY_PORT: port },
    startupFallbackTakeoverRuntime,
  });
}

function installNodeScheduledTask(env: Record<string, string>, stdout = new PassThrough()) {
  return installScheduledTask({
    env: {
      ...env,
      OPENCLAW_SERVICE_KIND: "node",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Node",
    },
    stdout,
    programArguments: ["node", "openclaw", "node", "run", "--host", "127.0.0.1", "--port", "18789"],
    environment: {
      OPENCLAW_SERVICE_KIND: "node",
      OPENCLAW_GATEWAY_PORT: "18789",
    },
  });
}

function fastForwardTaskStartWait(): void {
  sleepMock.mockImplementationOnce(async () => {
    timeState.now += 15_000;
  });
}

function addAcceptedRunNeverStartsResponses(): void {
  addMissingTaskInstallResponses([
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    notYetRunTaskSnapshot(),
    notYetRunTaskSnapshot(),
  ]);
}

function addSuccessfulScheduledTaskRestartResponses(
  cleanupEvidence: TaskSnapshot[] = [runningTaskSnapshot()],
  launchEvidence = runningTaskSnapshot(),
): void {
  queueNativeResponses(
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    launchEvidence,
  );
  for (const output of cleanupEvidence) {
    queueNativeResponses(output);
  }
}

type TaskSnapshot = { state: number; lastRunTime: string; lastRunResult: number };

type NativeResponse = (typeof schtasksResponses)[number] | TaskSnapshot;

function queueNativeResponses(...responses: NativeResponse[]): void {
  for (const response of responses) {
    if ("state" in response) {
      taskProbeResponses.push({ status: 0, stdout: JSON.stringify(response) });
    } else {
      schtasksResponses.push(response);
    }
  }
}

function notYetRunTaskSnapshot(lastRunTime = "1999-11-30T00:00:00.0000000Z"): TaskSnapshot {
  return { state: 3, lastRunTime, lastRunResult: 267011 };
}

function cleanExitTaskSnapshot(lastRunTime = "2026-05-02T14:41:39.0000000Z"): TaskSnapshot {
  return { state: 3, lastRunTime, lastRunResult: 0 };
}

function addAcceptedRunCleanExitResponses(initialOutput = cleanExitTaskSnapshot()): void {
  addMissingTaskInstallResponses([
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    initialOutput,
    cleanExitTaskSnapshot(),
  ]);
}

function runningTaskSnapshot(): TaskSnapshot {
  return { state: 4, lastRunTime: "2026-04-15T23:42:31.0000000Z", lastRunResult: 267009 };
}

beforeEach(() => {
  resetSchtasksBaseMocks();
  taskProbeResponses.length = 0;
  taskProbe.mockReset();
  let lastTaskProbe = { status: 0, stdout: JSON.stringify(runningTaskSnapshot()) };
  taskProbe.mockImplementation(() => {
    // Native Scheduler facts persist until a fixture supplies a state transition.
    lastTaskProbe = taskProbeResponses.shift() ?? lastTaskProbe;
    return lastTaskProbe;
  });
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  findVerifiedGatewayListenerPidsOnPortSync.mockReset();
  findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
  inspectPortUsageMock.mockResolvedValue({
    port: 18789,
    status: "free",
    listeners: [],
    hints: [],
  });
  spawn.mockReset();
  spawn.mockImplementation(() => createSpawnChild());
  spawnSync.mockReset();
  spawnSync.mockImplementation((command, args) =>
    command === getWindowsPowerShellExePath() && args?.includes(NODE_PROCESS_QUERY)
      ? makeSpawnSyncResult({
          stdout: JSON.stringify([{ ProcessId: 9999, CommandLine: "powershell.exe" }]),
        })
      : makeSpawnSyncResult(),
  );
  childUnref.mockClear();
  timeState.now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => timeState.now);
  sleepMock.mockReset();
  sleepMock.mockImplementation(async (ms: number) => {
    timeState.now += ms;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
export {
  runScheduledTaskOrThrow,
  decodeWindowsLauncherScript,
  timeState,
  sleepMock,
  childUnref,
  spawn,
  spawnSync,
  taskProbe,
  findVerifiedGatewayListenerPidsOnPortSync,
  isScheduledTaskInstalled,
  readScheduledTaskRuntime,
  readWindowsStartupFallbackRuntimeForUpdate,
  restartScheduledTask,
  resolveTaskScriptPath,
  stopScheduledTask,
  uninstallScheduledTask,
  launchFallbackTaskScript,
  removeStartupEntries,
  resolveFallbackRuntime,
  createMockGatewayService,
  readServiceStatusSummary,
  getStatusOverviewRowValue,
  createSpawnChild,
  NODE_PROCESS_QUERY,
  writeRunningGatewayScript,
  makeNodeServiceEnv,
  makeSpawnSyncResult,
  mockWindowsNodeHostProcess,
  expectTaskkillPid,
  expectStartupFallbackSpawn,
  expectGatewayTermination,
  expectNoGatewayTermination,
  addMissingTaskInstallResponses,
  addStartupFallbackMissingResponses,
  installGatewayScheduledTask,
  installNodeScheduledTask,
  fastForwardTaskStartWait,
  addAcceptedRunNeverStartsResponses,
  addSuccessfulScheduledTaskRestartResponses,
  queueNativeResponses,
  notYetRunTaskSnapshot,
  cleanExitTaskSnapshot,
  addAcceptedRunCleanExitResponses,
  runningTaskSnapshot,
  installScheduledTask,
  type TaskSnapshot,
};
