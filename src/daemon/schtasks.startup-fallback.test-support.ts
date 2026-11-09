import "./test-helpers/schtasks-base-mocks.js";
import type { ChildProcess, SpawnSyncOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import {
  createSchtasksNativeFixture,
  inspectPortUsageMock,
  killProcessTreeMock,
  resetSchtasksBaseMocks,
  schtasksResponses,
  schtasksRegistration,
} from "./test-helpers/schtasks-fixtures.js";

type SpawnSyncResult = {
  pid: number;
  output: (string | null)[];
  stdout: string;
  stderr: string;
  status: number;
  signal: null;
};

type TaskSnapshot = { state: number; lastRunTime: string; lastRunResult: number };
type NativeResponse = (typeof schtasksResponses)[number] | TaskSnapshot;

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

function notYetRunTaskSnapshot(lastRunTime = "1999-11-30T00:00:00.0000000Z"): TaskSnapshot {
  return { state: 3, lastRunTime, lastRunResult: 267011 };
}

function cleanExitTaskSnapshot(lastRunTime = "2026-05-02T14:41:39.0000000Z"): TaskSnapshot {
  return { state: 3, lastRunTime, lastRunResult: 0 };
}

function runningTaskSnapshot(): TaskSnapshot {
  return { state: 4, lastRunTime: "2026-04-15T23:42:31.0000000Z", lastRunResult: 267009 };
}

const timeState = vi.hoisted(() => ({ now: 0 }));
const sleepMock = vi.hoisted(() =>
  vi.fn(async (ms: number) => {
    timeState.now += ms;
  }),
);
const spawn = vi.hoisted(() => vi.fn());
const spawnSync = vi.hoisted(() =>
  vi.fn<(command: string, args?: readonly string[], options?: SpawnSyncOptions) => SpawnSyncResult>(
    () => makeSpawnSyncResult(),
  ),
);
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

let activeTaskEnv: Record<string, string> | undefined;
const nativeTask = createSchtasksNativeFixture(() => activeTaskEnv ?? {});
const { queue: queueNativeResponses, advance: advanceTaskProbe } = nativeTask;

function isProcessSnapshotQuery(args: readonly string[] | undefined): boolean {
  const markers = [
    "Get-CimInstance Win32_Process",
    "Select-Object ProcessId,CommandLine",
    "ConvertTo-Json",
  ];
  return args?.some((arg) => markers.every((marker) => arg.includes(marker))) ?? false;
}

function createSpawnChild(error?: Error): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.unref = vi.fn();
  queueMicrotask(() => child.emit(error ? "error" : "spawn", error));
  return child;
}

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

// mock-isolation: activation tests control listener ownership independently of process inventory.
vi.mock("../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: (port: number) =>
    findVerifiedGatewayListenerPidsOnPortSync(port),
}));

const { runScheduledTaskOrThrow } = await import("./schtasks-control.js");
const { installScheduledTask } = await import("./schtasks-install.js");
const { resolveTaskScriptPath } = await import("./schtasks-layout.js");

function makeNodeServiceEnv(env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    OPENCLAW_SERVICE_KIND: "node",
    OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Node",
  };
}

function expectNoGatewayTermination() {
  expect(killProcessTreeMock).not.toHaveBeenCalled();
  expect(spawnSync.mock.calls.filter(([command]) => command.endsWith("taskkill.exe"))).toEqual([]);
}

function successfulResponses(count: number): (typeof schtasksResponses)[number][] {
  return Array.from({ length: count }, () => ({ code: 0, stdout: "", stderr: "" }));
}

function addMissingTaskInstallResponses(responses: NativeResponse[]): void {
  schtasksRegistration.response = {
    code: 1,
    stdout: "",
    stderr: "ERROR: The system cannot find the file specified.",
  };
  queueNativeResponses(...responses);
}

function installGatewayScheduledTask(
  env: Record<string, string>,
  stdout = new PassThrough(),
  port = "18789",
) {
  activeTaskEnv = env;
  return installScheduledTask({
    env,
    stdout,
    programArguments: ["node", "gateway.js", "--port", port],
    environment: { OPENCLAW_GATEWAY_PORT: port },
  });
}

function fastForwardTaskStartWait(): void {
  sleepMock.mockImplementationOnce(async () => {
    timeState.now += 15_000;
    advanceTaskProbe();
  });
}

function addAcceptedRunNeverStartsResponses(): void {
  addMissingTaskInstallResponses([
    ...successfulResponses(2),
    notYetRunTaskSnapshot(),
    notYetRunTaskSnapshot(),
  ]);
}

beforeEach(() => {
  activeTaskEnv = undefined;
  resetSchtasksBaseMocks();
  nativeTask.reset();
  taskProbe.mockReset().mockImplementation(nativeTask.probe);
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  findVerifiedGatewayListenerPidsOnPortSync.mockReset().mockReturnValue([]);
  inspectPortUsageMock.mockResolvedValue({
    port: 18789,
    status: "free",
    listeners: [],
    hints: [],
  });
  spawn.mockReset().mockImplementation(() => createSpawnChild());
  spawnSync.mockReset().mockImplementation((command, args) =>
    command === getWindowsPowerShellExePath() && isProcessSnapshotQuery(args)
      ? makeSpawnSyncResult({
          stdout: JSON.stringify([{ ProcessId: 9999, CommandLine: "powershell.exe" }]),
        })
      : makeSpawnSyncResult(),
  );
  timeState.now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => timeState.now);
  vi.spyOn(performance, "now").mockImplementation(() => timeState.now);
  sleepMock.mockReset().mockImplementation(async (ms: number) => {
    timeState.now += ms;
    advanceTaskProbe();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

export {
  addAcceptedRunNeverStartsResponses,
  addMissingTaskInstallResponses,
  cleanExitTaskSnapshot,
  expectNoGatewayTermination,
  fastForwardTaskStartWait,
  installGatewayScheduledTask,
  installScheduledTask,
  isProcessSnapshotQuery,
  makeNodeServiceEnv,
  makeSpawnSyncResult,
  notYetRunTaskSnapshot,
  resolveTaskScriptPath,
  runScheduledTaskOrThrow,
  runningTaskSnapshot,
  sleepMock,
  spawn,
  spawnSync,
  taskProbe,
  timeState,
  type TaskSnapshot,
};
